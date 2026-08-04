/**
 * Cross-platform process helpers for the launcher.
 *
 * WHY THIS EXISTS: `launch.js` was Windows-only in ways that ranged from
 * harmless to fatal. The fatal one — `spawn('cmd', ['/c','start',...])` with no
 * `'error'` listener — raised an unhandled ENOENT on Linux and killed the
 * process, so the systemd unit installed by the VPS flow crash-looped behind a
 * passing `sleep 4; systemctl is-active` check. The Linux bridge has therefore
 * never actually run.
 *
 * DESIGN NOTE — no port→pid lookup on POSIX. We deliberately do NOT shell out
 * to `lsof`, `ss`, `netstat` or `pgrep`:
 *   - none of them are guaranteed on a minimal Debian/Alpine image, which is
 *     exactly the kind of box this targets, and a missing binary would fail
 *     silently into "no processes found";
 *   - scanning /proc lets us match OUR OWN command lines, so we can only ever
 *     reap a process we positively identified as ours — which was always the
 *     stated intent of the old `isRepoBridgeProcess` guard;
 *   - one readdirSync('/proc') beats spawning two processes per port.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Read a process's full command line.
 * Linux exposes it at /proc/<pid>/cmdline as NUL-separated argv.
 * Returns '' when the pid is gone or unreadable — never throws.
 */
function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return raw.replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Snapshot of visible processes as [{ pid, cmd }].
 * linux  → scan /proc (pure fs, no subprocess)
 * darwin → ps
 * win32  → PowerShell CIM, falling back to wmic.
 *
 * The Windows CIM-first order is deliberate: `wmic` is deprecated and is being
 * removed from Windows 11, so the old wmic-only path is a latent breakage.
 */
function psSnapshot() {
  if (process.platform === 'linux') {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync('/proc'); } catch { return out; }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const cmd = readProcCmdline(name);
      if (cmd) out.push({ pid: Number(name), cmd });
    }
    return out;
  }

  if (process.platform === 'darwin') {
    try {
      const raw = execSync('ps -A -o pid=,command=', { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
      return raw.split('\n').map(line => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), cmd: m[2] } : null;
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  // Windows — CIM first, wmic as the legacy fallback.
  //
  // -EncodedCommand (base64 UTF-16LE) rather than -Command: the expression
  // needs both quote styles, and passing it inline gets mangled by the
  // cmd.exe/shell layer between execSync and powershell. Verified: the inline
  // form silently failed and psSnapshot returned ZERO processes, which would
  // have made the launcher's reap a no-op and let bridges stack on one port.
  try {
    const expr = "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.CommandLine }";
    const encoded = Buffer.from(expr, 'utf16le').toString('base64');
    const raw = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = raw.split('\n').map(line => {
      const i = line.indexOf('|');
      if (i < 0) return null;
      const pid = Number(line.slice(0, i).trim());
      const cmd = line.slice(i + 1).trim();
      return Number.isFinite(pid) && cmd ? { pid, cmd } : null;
    }).filter(Boolean);
    if (rows.length) return rows;
  } catch { /* fall through to wmic */ }

  try {
    const raw = execSync('wmic process get ProcessId,CommandLine /format:csv', {
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\n').map(line => {
      const parts = line.split(',');
      if (parts.length < 3) return null;
      const pid = Number(parts[parts.length - 1].trim());
      const cmd = parts.slice(1, -1).join(',').trim();
      return Number.isFinite(pid) && cmd ? { pid, cmd } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read a process's environment (Linux only — /proc/<pid>/environ).
 * Returns {} when unavailable. This is how we tell a bridge running on OUR
 * ports from a parallel bridge on different ones: the ports are passed by env,
 * never on the command line.
 */
function readProcEnviron(pid) {
  if (process.platform !== 'linux') return {};
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
    const env = {};
    for (const pair of raw.split('\0')) {
      const i = pair.indexOf('=');
      if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * Classify a command line against THIS bridge install.
 * Returns 'repo' | 'payload' | 'chrome' | null.
 *
 * Kept intentionally specific so an unrelated app that merely happens to hold
 * one of our ports is never touched.
 *
 * Chrome is matched ONLY by `--remote-debugging-port=<cdpPort>` — i.e. the
 * parent we launched. Matching on the profile path too would also sweep up
 * Chrome's renderer/gpu/utility children, which is pointless (killing the
 * parent takes them with it) and needlessly widens the blast radius.
 */
function classifyBridgeProcess(cmd, { root, cdpPort } = {}) {
  if (!cmd) return null;
  const norm = cmd.toLowerCase().replace(/\\/g, '/');

  if (cdpPort && norm.includes(`--remote-debugging-port=${cdpPort}`)) return 'chrome';

  // The installed payload daemon, wherever it was launched from.
  if (norm.includes('.empir3-bridge/payload') || norm.includes('.empir3-bridge/node/')) return 'payload';

  if (root) {
    const r = String(root).toLowerCase().replace(/\\/g, '/');
    const isOurs = norm.includes(r) && (
      norm.includes('src/bridge.ts') ||
      norm.includes('src/server.ts') ||
      norm.includes('src/launch.js') ||
      norm.includes('src/headless-entry.js')
    );
    if (isOurs) return 'repo';
  }
  return null;
}

/**
 * Bridge processes this launcher owns AND may reap.
 *
 * PORT SCOPING MATTERS: the header of launch.js documents running a second
 * bridge alongside the first on other ports (EMPIR3_PW_PORT=3106 …). A reap
 * that ignored ports would make `npm start` on the parallel bridge kill the
 * main one. The old netstat-based code was port-scoped by construction; this
 * keeps that property by reading each candidate's environment on Linux, where
 * the ports actually live. When the environment is unreadable (non-Linux, or a
 * process we can't inspect), we fall back to including the process — matching
 * the historical single-bridge behavior — because leaving a stale bridge on our
 * port is the worse failure: it means EADDRINUSE and a dead launch.
 */
function listOwnedProcesses({ root, cdpPort, pwPort, bridgePort } = {}) {
  const self = process.pid;
  const out = [];
  for (const { pid, cmd } of psSnapshot()) {
    if (pid === self) continue;
    const kind = classifyBridgeProcess(cmd, { root, cdpPort });
    if (!kind) continue;

    // Chrome already carries our CDP port in its command line, so it is
    // port-scoped by construction.
    if (kind !== 'chrome' && (pwPort || bridgePort)) {
      const env = readProcEnviron(pid);
      const theirPw = env.EMPIR3_PW_PORT || env.PW_PORT;
      const theirBridge = env.EMPIR3_BRIDGE_HTTP_PORT || env.EMPIR3_BRIDGE_PORT || env.BRIDGE_PORT;
      if (theirPw || theirBridge) {
        const sharesPort =
          (pwPort && String(theirPw) === String(pwPort)) ||
          (bridgePort && String(theirBridge) === String(bridgePort));
        if (!sharesPort) continue; // a parallel bridge on other ports — leave it
      }
    }
    out.push({ pid, cmd, kind });
  }
  return out;
}

/** SIGTERM, wait, then SIGKILL. Windows uses taskkill. */
function reapProcesses(pids, { graceMs = 2000, log = () => {} } = {}) {
  const killed = [];
  const skipped = [];
  for (const pid of pids) {
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed.push(pid);
      log(`  Stopped bridge PID ${pid}`);
    } catch {
      skipped.push(pid);
    }
  }
  if (!IS_WINDOWS && killed.length) {
    const deadline = Date.now() + graceMs;
    // Busy-wait is fine here: this runs once at startup, for at most graceMs.
    while (Date.now() < deadline) {
      const alive = killed.filter(pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      if (alive.length === 0) break;
    }
    for (const pid of killed) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  return { killed, skipped };
}

/**
 * spawn() that ALWAYS attaches an 'error' listener.
 *
 * THIS IS THE P0 FIX. A ChildProcess is an EventEmitter: an 'error' event with
 * no listener is re-thrown as an uncaught exception. `spawn('cmd', ...)` on
 * Linux fails with ENOENT, and with no listener that killed the launcher — the
 * whole reason the Linux bridge never started.
 *
 * Returns the child, or null when the spawn could not even be attempted.
 */
function spawnDetached(file, args, opts = {}) {
  let child;
  try {
    child = spawn(file, args, opts);
  } catch (err) {
    console.error(`  ✗ could not spawn ${file}: ${err && err.message ? err.message : err}`);
    return null;
  }
  child.on('error', (err) => {
    console.error(`  ✗ ${file} failed to start: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
  return child;
}

/**
 * Locate the tsx CLI without shelling through `npx`.
 * `npx tsx` costs a resolution round-trip and, on POSIX, needed a shell to be
 * found at all — which is what forced the `cmd /c` spawn shape in the first
 * place. Resolving the real entry lets us spawn node directly on every OS.
 */
function resolveTsx(root) {
  const candidates = [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'node_modules', 'tsx', 'cli.mjs'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return { file: process.execPath, args: [file] };
  }
  const bin = path.join(root, 'node_modules', '.bin', IS_WINDOWS ? 'tsx.cmd' : 'tsx');
  if (fs.existsSync(bin)) return { file: bin, args: [] };
  return null;
}

module.exports = {
  IS_WINDOWS,
  readProcCmdline,
  readProcEnviron,
  psSnapshot,
  classifyBridgeProcess,
  listOwnedProcesses,
  reapProcesses,
  spawnDetached,
  resolveTsx,
};
