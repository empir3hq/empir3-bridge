#!/usr/bin/env node
/**
 * Empir3 Bridge — payload entry point.
 *
 * This file becomes `entry.js` inside the signed payload tarball that the
 * bootstrapper extracts to `~/.empir3-bridge/payload/<version>/`. The
 * bootstrapper calls our exported `start(argv)` and forwards the user's
 * CLI args.
 *
 * This is everything that USED to live in `bridge/build/entry.js` minus
 * the bootstrap-only concerns (network update, signature verification,
 * payload cache layout). Asset paths now point at sibling files inside
 * the extracted payload dir instead of being SEA-extracted.
 *
 * Subcommands (all forwarded from Empir3Setup.exe argv):
 *   <none>                         → First-run UX. Spawns the tray wrapper,
 *                                    which spawns the daemon. Daemon detects
 *                                    no auth file and serves the two-button
 *                                    splash at /welcome inside the bridge's
 *                                    own Chrome. (Replaces the Koba chat
 *                                    installer that used to live here.)
 *   --daemon                       → Spawn the tray wrapper (Empir3Tray.exe);
 *                                    tray supervises the actual daemon. This
 *                                    is the autostart target, so users boot
 *                                    into a tray icon, not a hidden process.
 *   --daemon-real                  → Run the bridge daemon directly, no tray.
 *                                    Used by the tray itself when it spawns
 *                                    the bootstrapper as a child.
 *   --uninstall                    → Reverse all the things we wrote
 *   --version | -v                 → Print SHIPPED version (payload version)
 *   --help    | -h                 → Print usage
 *
 * Exit codes:
 *   0   normal exit
 *   1   fatal error inside the payload (also when the daemon dies)
 *   69  unavailable (used by bootstrap, not us)
 *   70  internal contract error (e.g. missing entry export — bootstrap)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Inside the extracted payload dir we have:
//   entry.js                   ← this file (renamed from payload-entry.js)
//   bundle-daemon.js           ← bundled bridge/index.js + handlers + ws
//   bundle-installer.js        ← bundled bridge/installer/server.js
//   installer-ui/<files>       ← Koba chat UI static files
//   .payload-version           ← plain text version stamp
const PAYLOAD_DIR = process.env.EMPIR3_BRIDGE_PAYLOAD_DIR
  || __dirname; // dev fallback when running directly via node payload-entry.js

const VERSION_FILE = path.join(PAYLOAD_DIR, '.payload-version');
function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}
  return process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || 'dev';
}

// Legacy bundled-extension ID. The extension is no longer shipped or loaded
// (the overlay rides the CDP mailbox instead), but this ID is retained solely
// to scrub the old ExtensionInstallForcelist policy below from installs that
// received it — see the migration further down.
const EXTENSION_ID = 'gbigofjjgcpjkffhlfepjdglabhngeii';

// ── Asset paths surfaced to bundled daemon + installer ──────────────

function configureRuntimePaths() {
  const uiDir = path.join(PAYLOAD_DIR, 'installer-ui');
  process.env.EMPIR3_BRIDGE_INSTALLER_UI_DIR = uiDir;
  process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION = readVersion();
}

const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE_NAME = 'Empir3Bridge';
const APPDATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Empir3');
const STABLE_BOOTSTRAP_EXE = path.join(APPDATA_DIR, 'Empir3Setup.exe');
const BOOTSTRAP_POINTER_FILE = path.join(APPDATA_DIR, 'bridge-bootstrap.json');

function appendBridgeLog(message) {
  try {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(APPDATA_DIR, 'bridge.log'),
      `${new Date().toISOString()} [empir3-entry] ${message}\n`,
      'utf8',
    );
  } catch {}
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function copyBootstrapToStablePath() {
  if (process.platform !== 'win32') return process.execPath;
  if (!process.env.EMPIR3_BRIDGE_BOOTSTRAP_VERSION) return process.execPath;

  // Go bootstrapper path: the stub has ALREADY reconciled stable-vs-running per
  // the design decision table (including the locked-stale case where the
  // authoritative exe is the running NEWER stub, not the older stable) and set
  // EMPIR3_BOOTSTRAP_EXE to the result. That value is guaranteed >= the running
  // stub, so we TRUST it verbatim — never copy, never fall back to an older
  // stable exe (doing so could re-register the older one, which the design
  // forbids). We only refresh the pointer to match.
  const authoritative = (process.env.EMPIR3_BOOTSTRAP_EXE || '').trim();
  if (authoritative) {
    try {
      fs.mkdirSync(APPDATA_DIR, { recursive: true });
      fs.writeFileSync(
        BOOTSTRAP_POINTER_FILE,
        JSON.stringify({ bootstrapPath: authoritative, sourcePath: authoritative, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch (e) {
      console.error('[empir3-bridge] stable bootstrap pointer refresh failed:', e.message);
    }
    return authoritative;
  }

  // Legacy Node-SEA path: EMPIR3_BOOTSTRAP_EXE is unset, so the running SEA exe
  // (process.execPath) IS the product — copy it to the stable path.
  const source = process.execPath;
  const target = STABLE_BOOTSTRAP_EXE;
  try {
    fs.mkdirSync(APPDATA_DIR, { recursive: true });
    if (source.toLowerCase() !== target.toLowerCase()) {
      let shouldCopy = true;
      try {
        const srcStat = fs.statSync(source);
        const dstStat = fs.statSync(target);
        shouldCopy = srcStat.size !== dstStat.size;
      } catch {}
      if (shouldCopy) {
        fs.copyFileSync(source, target);
      }
    }
    fs.writeFileSync(
      BOOTSTRAP_POINTER_FILE,
      JSON.stringify({ bootstrapPath: target, sourcePath: source, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    return target;
  } catch (e) {
    console.error('[empir3-bridge] stable bootstrap write failed:', e.message);
    return fs.existsSync(target) ? target : source;
  }
}

function bootstrapExeForRegistration() {
  return copyBootstrapToStablePath();
}

// Per-user Start Menu folder. Windows resolves the env var to e.g.
// C:\Users\<u>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs.
function startMenuShortcutPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Empir3', 'Empir3.lnk');
}

// Idempotent Start Menu shortcut. Points at the running bootstrapper exe
// with --daemon so clicking it boots the tray (which then supervises the
// real bridge daemon as a child). PowerShell's WScript.Shell ComObject is
// the simplest way to write a real .lnk from Node without bundling a
// shortcut library — every Win10/11 install ships with PowerShell.
function registerStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  // Same gate as autostart — only register when running from the SEA
  // bootstrapper, so plain `node payload-entry.js` dev runs don't pollute
  // the user's Start Menu.
  const fromBootstrap = !!process.env.EMPIR3_BRIDGE_BOOTSTRAP_VERSION;
  if (!fromBootstrap) return;
  try {
    const exe = bootstrapExeForRegistration();
    const lnk = startMenuShortcutPath();
    fs.mkdirSync(path.dirname(lnk), { recursive: true });

    // Skip if a shortcut already exists pointing at the same exe — no-op
    // on every subsequent boot. Compare by reading TargetPath via the same
    // ComObject; if the user moved Empir3Setup.exe we re-write to the new
    // path automatically.
    const probe = spawnSync('powershell', ['-NoProfile', '-Command',
      `try { $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('${lnk.replace(/'/g, "''")}'); Write-Output $s.TargetPath; Write-Output $s.Arguments } catch {}`,
    ], { encoding: 'utf8' });
    const probeLines = probe.stdout ? probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    if (probe.status === 0 && probeLines[0] === exe && (probeLines[1] || '') === '--daemon') return;

    const ps = `
      $ws = New-Object -ComObject WScript.Shell
      $s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')
      $s.TargetPath = '${exe.replace(/'/g, "''")}'
      $s.Arguments = '--daemon'
      $s.IconLocation = '${exe.replace(/'/g, "''")},0'
      $s.Description = 'Empir3 Bridge — desktop companion'
      $s.WorkingDirectory = '${path.dirname(exe).replace(/'/g, "''")}'
      $s.Save()
    `.trim();
    const w = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    if (w.status === 0) {
      console.log(`[empir3-bridge] Start Menu shortcut written: ${lnk}`);
    } else {
      console.error('[empir3-bridge] Start Menu shortcut write failed:', (w.stderr || w.stdout || '').trim());
    }
  } catch (e) {
    console.error('[empir3-bridge] Start Menu shortcut threw:', e.message);
  }
}

// Register Empir3Setup.exe --daemon (the BOOTSTRAPPER, not the payload —
// process.execPath here is the SEA exe) to launch automatically on
// Windows login. Idempotent: writes only when missing or pointing
// somewhere else.
function registerAutostart() {
  if (process.platform !== 'win32') return;
  // Only register autostart when running inside the SEA-packaged bootstrapper.
  // In dev runs (plain node payload-entry.js) we don't want to install autostart.
  const fromBootstrap = !!process.env.EMPIR3_BRIDGE_BOOTSTRAP_VERSION;
  if (!fromBootstrap) return;
  try {
    const exe = bootstrapExeForRegistration();
    const desired = `"${exe}" --daemon`;

    const q = spawnSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_VALUE_NAME], { encoding: 'utf8' });
    if (q.status === 0 && q.stdout) {
      const m = q.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && m[1].trim() === desired) return;
    }

    const w = spawnSync('reg', [
      'add', AUTOSTART_KEY,
      '/v', AUTOSTART_VALUE_NAME,
      '/t', 'REG_SZ',
      '/d', desired,
      '/f',
    ], { encoding: 'utf8' });
    if (w.status === 0) {
      console.log('[empir3-bridge] autostart registered: bridge will launch on Windows login');
    } else {
      console.error('[empir3-bridge] autostart write failed:', (w.stderr || w.stdout || '').trim());
    }
  } catch (e) {
    console.error('[empir3-bridge] autostart write threw:', e.message);
  }
}

// RETIRED: HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist.
//
// The HKCU policy was a privacy violation — it force-installed the bridge
// extension into the USER'S MAIN Chrome (every profile, every window), not
// just the bridge's isolated profile. Per the load-bearing rule (memory
// `feedback_bridge_privacy_isolated_profile`): Vincent never touches the
// user's normal Chrome.
//
// Replacement: the bridge no longer ships or loads any Chrome extension at
// all — the in-page overlay rides the bridge's own CDP connection (a mailbox:
// push via window.__empir3_inbox, drain window.__empir3_outbox), which works
// on every page including https. The user's main Chrome stays untouched.
//
// MIGRATION CLEANUP: every --daemon boot scrubs the old HKCU entry so
// upgrades from <=v0.1.3 self-heal. Removing on every boot is cheap (one
// reg query + one reg delete on hit) and idempotent.
function scrubLegacyForceInstallPolicy() {
  if (process.platform !== 'win32') return;
  try {
    const REG_KEY = 'HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist';
    const q = spawnSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
    if (q.status !== 0 || !q.stdout) return; // key doesn't exist, nothing to do

    const re = /\s+(\S+)\s+REG_SZ\s+(.+?)\s*$/gm;
    let m;
    let removed = 0;
    while ((m = re.exec(q.stdout)) !== null) {
      const [, slot, data] = m;
      if (data.startsWith(EXTENSION_ID + ';')) {
        const d = spawnSync('reg', ['delete', REG_KEY, '/v', slot, '/f'], { stdio: 'ignore' });
        if (d.status === 0) removed++;
      }
    }
    if (removed > 0) {
      console.log(`[empir3-bridge] migration: scrubbed ${removed} legacy ExtensionInstallForcelist entr${removed === 1 ? 'y' : 'ies'} (extension no longer leaks into user's main Chrome)`);
      // If the parent key is now empty, remove it too so Chrome stops
      // showing "Managed by your organization" in the menu.
      const q2 = spawnSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
      if (q2.status === 0 && !/\s+\d+\s+REG_SZ/.test(q2.stdout || '')) {
        spawnSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' });
      }
    }
  } catch (e) {
    console.error('[empir3-bridge] policy scrub failed:', e.message);
  }
}

// ── Uninstall ──────────────────────────────────────────────────────

async function uninstall() {
  console.log('[empir3-bridge] uninstalling…');
  let steps = 0;

  // 1a. Kill the tray wrapper by image name. The tray supervises the daemon
  // and would otherwise immediately respawn anything we kill on a port.
  // Done first so step 1b's daemon kills stay dead.
  if (process.platform === 'win32') {
    const tk = spawnSync('taskkill', ['/F', '/IM', 'Empir3Tray.exe'], { encoding: 'utf8' });
    if (tk.status === 0) {
      console.log('  killed Empir3Tray.exe');
      steps++;
    }
  }

  // 1b. Stop any running daemon (kill anything listening on 3006-3306).
  if (process.platform === 'win32') {
    const ports = [3006, 3106, 3206, 3306];
    const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    if (ns.stdout) {
      const seen = new Set();
      for (const port of ports) {
        const re = new RegExp(`LISTENING\\s+(\\d+)\\s*$`);
        for (const line of ns.stdout.split('\n')) {
          if (line.includes(`127.0.0.1:${port}`) || line.includes(`0.0.0.0:${port}`)) {
            const m = line.match(re);
            if (m) seen.add(m[1]);
          }
        }
      }
      for (const pid of seen) {
        if (pid === String(process.pid)) continue;
        spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
        console.log('  killed bridge daemon pid', pid);
        steps++;
      }
    }
  }

  // 2. Remove HKCU Chrome ExtensionInstallForcelist policy.
  if (process.platform === 'win32') {
    const REG_KEY = 'HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist';
    const q = spawnSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
    if (q.status === 0 && q.stdout) {
      const re = /\s+(\S+)\s+REG_SZ\s+(.+?)\s*$/gm;
      let m;
      while ((m = re.exec(q.stdout)) !== null) {
        const [, slot, data] = m;
        if (data.startsWith(EXTENSION_ID + ';')) {
          spawnSync('reg', ['delete', REG_KEY, '/v', slot, '/f'], { stdio: 'ignore' });
          console.log(`  removed Chrome force-install policy (slot ${slot})`);
          steps++;
        }
      }
      const q2 = spawnSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
      if (q2.status === 0 && !/\s+\d+\s+REG_SZ/.test(q2.stdout || '')) {
        spawnSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' });
      }
    }
  }

  // 3. Remove autostart entry.
  if (process.platform === 'win32') {
    const q = spawnSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_VALUE_NAME], { encoding: 'utf8' });
    if (q.status === 0) {
      spawnSync('reg', ['delete', AUTOSTART_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'], { stdio: 'ignore' });
      console.log('  removed Windows autostart');
      steps++;
    }
  }

  // 4. Remove cached payload tree (every version).
  try {
    const payloadRoot = path.join(os.homedir(), '.empir3-bridge');
    fs.rmSync(payloadRoot, { recursive: true, force: true });
    console.log('  cleared cached payloads + extracted runtime files');
    steps++;
  } catch {}

  // 5. Remove the bridge's dedicated Chrome profile (if it was used).
  try {
    const bridgeProfile = path.join(os.homedir(), '.empir3', 'bridge-chrome-profile');
    if (fs.existsSync(bridgeProfile)) {
      fs.rmSync(bridgeProfile, { recursive: true, force: true });
      console.log('  cleared bridge Chrome profile');
      steps++;
    }
  } catch {}

  // 6. Remove %APPDATA%/Empir3/ — auth token, settings, daemon log, tray
  // log. This was previously kept on the theory the user might re-install
  // and want to skip re-pairing, but a "full uninstall" should leave the
  // machine clean. They can re-pair in 6 seconds via the welcome page if
  // they reinstall.
  if (process.platform === 'win32') {
    try {
      const appdataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Empir3');
      if (fs.existsSync(appdataDir)) {
        fs.rmSync(appdataDir, { recursive: true, force: true });
        console.log('  cleared %APPDATA%/Empir3 (auth, settings, logs)');
        steps++;
      }
    } catch (e) {
      console.warn('  could not clear %APPDATA%/Empir3:', e.message);
    }
  }

  // 7. Remove Start Menu shortcut + parent folder (if empty).
  if (process.platform === 'win32') {
    try {
      const lnk = startMenuShortcutPath();
      if (fs.existsSync(lnk)) {
        fs.rmSync(lnk, { force: true });
        console.log('  removed Start Menu shortcut');
        steps++;
      }
      const folder = path.dirname(lnk);
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) {
        fs.rmdirSync(folder);
      }
    } catch {}
  }

  console.log(`[empir3-bridge] uninstall complete (${steps} steps).`);
  console.log('Note: the bootstrapper exe (Empir3Setup.exe) you ran can be deleted manually.');
  console.log('Note: the extension may persist in your Chrome until you reopen Chrome (which will see the policy is gone and remove it).');

  // 8. Reassure the user it's actually done. The tray was killed in step 1a,
  // so this native dialog is the ONLY "uninstall complete" signal they get —
  // without it the tray just vanishes and nothing confirms success. Best
  // effort: a popup failure must never mask a successful uninstall. Body is
  // base64'd into the PowerShell command to sidestep all quoting/newline
  // escaping; -STA is required for WinForms MessageBox.
  if (process.platform === 'win32') {
    try {
      const body =
        'Empir3 Bridge has been uninstalled.\n\n' +
        `${steps} item(s) were removed. You can delete Empir3Setup.exe whenever you like.\n\n` +
        'If Chrome is open, the helper extension disappears the next time you restart it.';
      const b64 = Buffer.from(body, 'utf8').toString('base64');
      const ps =
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null; ' +
        '[System.Windows.Forms.MessageBox]::Show(' +
        `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')),` +
        "'Empir3 Bridge','OK','Information') | Out-Null";
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps],
        { stdio: 'ignore', windowsHide: true });
    } catch {}
  }
}

// ── Subcommand dispatch ─────────────────────────────────────────────

function printHelp() {
  const v = readVersion();
  console.log(`Empir3 Bridge ${v}`);
  console.log('');
  console.log('Usage:');
  console.log('  Empir3Setup.exe              Install + start the bridge (first-time setup).');
  console.log('  Empir3Setup.exe --daemon     Run the bridge daemon headless (used by autostart).');
  console.log('  Empir3Setup.exe --uninstall  Remove all bridge components from this machine.');
  console.log('  Empir3Setup.exe --version    Print version and exit.');
  console.log('');
}

// Locate Empir3Tray.exe inside the extracted payload. Returns null if the
// payload predates the tray bundle (older payloads still run --daemon
// directly via the no-tray fallback).
function findTrayExe() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    path.join(PAYLOAD_DIR, 'Empir3Tray.exe'),
    // Dev fallback when running entry.js directly without an extracted payload.
    path.join(__dirname, '..', 'tray', 'Empir3Tray.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Spawn the tray wrapper and exit. The tray takes ownership of the daemon
// child process and gives the user a menu/icon. Pass the bootstrapper exe
// path through the env so the tray can spawn `--daemon-real` reliably.
async function spawnTrayAndExit() {
  const trayExe = findTrayExe();
  if (!trayExe) {
    // No tray exe. Under the Go bootstrapper the --daemon node has NO
    // kill-on-close job, so running the daemon IN-PROCESS here would orphan it
    // if the stub is killed. Instead relaunch the bootstrap exe as
    // `--daemon-real`, which the Go stub supervises with its own kill-on-close
    // job (no orphan). Only do this when we have a genuine bootstrap exe; dev /
    // legacy runs (no EMPIR3_BOOTSTRAP_EXE) fall back to in-process.
    const exe = (process.env.EMPIR3_BOOTSTRAP_EXE || '').trim();
    if (exe && process.platform === 'win32') {
      console.error(`[empir3-bridge] tray exe not found; relaunching ${exe} --daemon-real (supervised fallback)`);
      const child = spawn(exe, ['--daemon-real'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EMPIR3_BOOTSTRAP_EXE: exe },
      });
      child.unref();
      return;
    }
    console.error('[empir3-bridge] tray exe not found; running daemon headless as fallback (dev)');
    await require('./bundle-daemon.js').start();
    return;
  }

  const bootstrapExe = bootstrapExeForRegistration();
  const trayEnv = {
    ...process.env,
    EMPIR3_BOOTSTRAP_EXE: bootstrapExe,
    EMPIR3_BRIDGE_PAYLOAD_DIR: PAYLOAD_DIR,
    EMPIR3_BRIDGE_PAYLOAD_VERSION: readVersion(),
  };

  console.log(`[empir3-bridge] spawning tray: ${trayExe}`);
  appendBridgeLog(`spawning tray via node: ${trayExe}`);
  const child = spawn(trayExe, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(trayExe),
    env: trayEnv,
    windowsHide: true,
  });
  const spawned = await new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once('spawn', () => {
      appendBridgeLog(`node tray spawn returned pid=${child.pid || 0}`);
      done(true);
    });
    child.once('error', (e) => {
      appendBridgeLog(`node tray spawn failed: ${e?.message || e}`);
      done(false);
    });
    setTimeout(() => done(!!child.pid), 750);
  });
  if (spawned) {
    child.unref();
    // Bootstrapper exits cleanly; the tray runs independently.
    return;
  }

  appendBridgeLog('node tray spawn did not start; retrying with PowerShell Start-Process');
  const ps = `
    $env:EMPIR3_BOOTSTRAP_EXE = ${psQuote(bootstrapExe)}
    $env:EMPIR3_BRIDGE_PAYLOAD_DIR = ${psQuote(PAYLOAD_DIR)}
    $env:EMPIR3_BRIDGE_PAYLOAD_VERSION = ${psQuote(readVersion())}
    Start-Process -FilePath ${psQuote(trayExe)} -WorkingDirectory ${psQuote(path.dirname(trayExe))}
  `.trim();
  const retry = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    env: trayEnv,
    windowsHide: true,
  });
  if (retry.status === 0) {
    appendBridgeLog('PowerShell Start-Process tray retry succeeded');
    return;
  }
  appendBridgeLog(`PowerShell Start-Process tray retry failed: ${(retry.stderr || retry.stdout || '').trim()}`);
}

async function start(argv) {
  argv = argv || process.argv.slice(2);

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(readVersion());
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (argv.includes('--uninstall')) {
    await uninstall();
    return;
  }

  configureRuntimePaths(); // env-only (no stdout) — safe before the --mcp gate

  // --mcp runs the MCP stdio shim. Spawned by Claude Code (or any other MCP
  // client) per the snippet our /api/install/claude-code endpoint mints. It
  // talks JSON-RPC over stdin/stdout, so ANY stray stdout byte corrupts the
  // stream. Branch here — BEFORE the policy scrub / autostart / Start Menu
  // registration, all of which console.log on success — and let the shim own
  // stdout. The daemon is already running; no tray/daemon spawn, no network
  // update. (Design: "--mcp stdio discipline", Codex P0.)
  if (argv.includes('--mcp')) {
    require('./bundle-mcp-server.js');
    return;
  }

  // --pair <code>: redeem a PRE-AUTHORIZED Empir3 pairing session (the install-link
  // flow). Empir3 mints the code for the already-logged-in user and bakes it into
  // the install command, so we claim it on first boot and write bridge-auth.json —
  // no second browser login. Runs here (after the --mcp stdio gate, before tray /
  // daemon spawn) so the daemon boots already paired regardless of which launch
  // flag carries it. Bounded + best-effort: any failure just falls through to the
  // normal /welcome first-run pairing, never blocking the install.
  const pairIdx = argv.indexOf('--pair');
  if (pairIdx !== -1) {
    try {
      const { claimPairingCode } = require('./bundle-pair-claim.js');
      const result = await claimPairingCode(argv[pairIdx + 1], { log: (m) => appendBridgeLog('pair: ' + m) });
      appendBridgeLog(`pair: result=${result.status}${result.user && result.user.email ? ' (' + result.user.email + ')' : ''}`);
    } catch (e) {
      appendBridgeLog('pair: claim threw: ' + (e && e.message ? e.message : String(e)));
    }
  }

  scrubLegacyForceInstallPolicy();
  registerAutostart();
  registerStartMenuShortcut();

  // Used by the native Go launcher path. The bootstrapper launches
  // Empir3Tray.exe itself after this prep step returns.
  if (argv.includes('--launcher-prep')) {
    appendBridgeLog('launcher prep complete');
    return;
  }

  // --daemon-real runs the bridge daemon directly, no tray. The tray invokes
  // this when it spawns the bootstrapper as a supervised child.
  if (argv.includes('--daemon-real')) {
    await require('./bundle-daemon.js').start();
    return;
  }

  // --daemon (the autostart target) now goes through the tray so the user
  // sees a real desktop surface. The tray spawns the daemon as its child.
  if (argv.includes('--daemon')) {
    await spawnTrayAndExit();
    return;
  }

  // First-run / double-click: spawn the tray, which spawns the daemon. The
  // daemon's splash UX (no auth → /welcome two-button page in the bridge's
  // own Chrome) replaces the previous Koba chat installer. Same code path
  // as --daemon, so re-running Empir3Setup.exe is always idempotent.
  await spawnTrayAndExit();
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[empir3-bridge] fatal:', e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { start };
