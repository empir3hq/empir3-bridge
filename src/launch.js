#!/usr/bin/env node
/**
 * Empir3 Browser Bridge — One-Command Launcher
 *
 * Usage:
 *   npm start              # launch the bridge + Chrome (single-bridge default)
 *   npm run kill           # shut it down
 *   npm run status         # health check
 *
 * What it does:
 *   1. Stops bridge-owned processes on its ports
 *   2. Launches src/bridge.ts (CDP bridge → Chrome)
 *   3. Waits for Chrome to connect
 *   4. Launches src/server.ts (HTTP wrapper)
 *   5. Confirms both are healthy
 *
 * Parallel bridges (advanced):
 *   Most users want one bridge. If you actually need a second one running
 *   alongside the first (e.g. an isolated test profile while your main
 *   browser keeps working), set the env vars below and re-run npm start
 *   in another terminal:
 *
 *     EMPIR3_PW_PORT=3106 \
 *     EMPIR3_BRIDGE_HTTP_PORT=9967 \
 *     EMPIR3_CDP_PORT=9322 \
 *     EMPIR3_BRIDGE_PROFILE=$HOME/.empir3-bridge/profile-test \
 *     EMPIR3_BRIDGE_LABEL=TEST \
 *     npm start
 *
 *   Then drive the parallel bridge with:
 *     BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts <command>
 *
 *   The MCP server only sees the default bridge on :3006.
 */

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { checkForUpdate } = require('./update-check.js');

const ROOT = path.resolve(__dirname, '..');
const CDP_BRIDGE = path.join(__dirname, 'bridge.ts');
const PW_BRIDGE = path.join(__dirname, 'server.ts');

// ── Config: defaults are the single-bridge user setup. Override any of these
//    env vars to spin a parallel bridge (see header comment). ──────────────────
const PW_PORT     = parseInt(process.env.EMPIR3_PW_PORT          || '3006', 10);
const BRIDGE_PORT = parseInt(process.env.EMPIR3_BRIDGE_HTTP_PORT || '9867', 10);
const CDP_PORT    = parseInt(process.env.EMPIR3_CDP_PORT         || '9222', 10);
const PROFILE     = process.env.EMPIR3_BRIDGE_PROFILE
  || path.join(os.homedir(), '.empir3-bridge', 'profile');
const LABEL       = process.env.EMPIR3_BRIDGE_LABEL
  || (PW_PORT === 3006 ? 'BRIDGE' : `BRIDGE:${PW_PORT}`);

function fetch(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function killPort(port) {
  try {
    const lines = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf-8' }).trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
      const match = line.match(/LISTENING\s+(\d+)/);
      if (match) pids.add(match[1]);
    }
    for (const pid of pids) {
      try {
        if (!isRepoBridgeProcess(pid)) {
          console.log(`  Port ${port} is used by PID ${pid}; leaving it alone`);
          continue;
        }
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        console.log(`  Stopped bridge PID ${pid} on port ${port}`);
      } catch {}
    }
  } catch {
    // No process on port — that's fine
  }
}

function isRepoBridgeProcess(pid) {
  try {
    const out = execSync(`wmic process where "ProcessId=${pid}" get CommandLine /value`, { encoding: 'utf-8' });
    const cmd = out.toLowerCase();
    const root = ROOT.toLowerCase().replace(/\//g, '\\');
    return cmd.includes(root) && (
      cmd.includes('src\\bridge.ts') ||
      cmd.includes('src\\server.ts') ||
      cmd.includes('src/bridge.ts') ||
      cmd.includes('src/server.ts')
    );
  } catch {
    return false;
  }
}

async function waitForHealth(url, label, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const data = await fetch(url);
      if (data && (data.status || data.running !== undefined)) {
        return data;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become healthy within ${maxWait/1000}s`);
}

async function status() {
  console.log(`\n  Bridge Status [${LABEL}]`);
  console.log('  ' + '─'.repeat(40));

  try {
    const cdp = await fetch(`http://localhost:${BRIDGE_PORT}/health`, 2000);
    console.log(`  CDP Bridge (:${BRIDGE_PORT})    ✓ ${cdp.status || 'running'}`);
  } catch {
    console.log(`  CDP Bridge (:${BRIDGE_PORT})    ✗ not running`);
  }

  try {
    const pw = await fetch(`http://localhost:${PW_PORT}/api/status`, 2000);
    console.log(`  HTTP Wrapper (:${PW_PORT})  ✓ ${pw.running ? 'running' : 'error'}`);
    if (pw.currentUrl) console.log(`  Current URL:              ${pw.currentUrl}`);
  } catch {
    console.log(`  HTTP Wrapper (:${PW_PORT})  ✗ not running`);
  }

  console.log(`  Profile dir:              ${PROFILE}`);
  console.log();
}

async function kill() {
  console.log(`\n  Shutting down [${LABEL}] bridge...`);
  killPort(PW_PORT);
  killPort(BRIDGE_PORT);
  // Kill the Chrome instance launched by THIS bridge (identified by --remote-debugging-port=CDP_PORT)
  try {
    const procs = execSync('wmic process where "name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf-8' });
    for (const line of procs.split('\n')) {
      if (line.includes(`--remote-debugging-port=${CDP_PORT}`)) {
        const pid = line.trim().split(',').find(p => /^\d+$/.test(p.trim()));
        if (pid) {
          try { execSync(`taskkill /PID ${pid.trim()} /F`, { stdio: 'ignore' }); console.log(`  Killed bridge Chrome PID ${pid.trim()}`); } catch {}
        }
      }
    }
  } catch {}
  console.log('  Done.\n');
}

async function launch() {
  console.log('\n  ╔═══════════════════════════════════════╗');
  console.log(`  ║  Empir3 Browser Bridge [${LABEL.padEnd(8)}]    ║`);
  console.log('  ╚═══════════════════════════════════════╝\n');
  console.log(`  Ports: bridge=${BRIDGE_PORT}, chrome-cdp=${CDP_PORT}, wrapper=${PW_PORT}`);
  console.log(`  Profile: ${PROFILE}\n`);

  // Non-blocking version check — prints a yellow banner if we're outdated.
  // Always wrapped in try so a bad GitHub response can never block startup.
  try { await checkForUpdate(); } catch {}

  // Step 1: Clean up — kill OUR ports + OUR Chrome instance only
  console.log('  [1/4] Cleaning up old processes on these ports...');
  killPort(PW_PORT);
  killPort(BRIDGE_PORT);
  // Kill only Chrome with our specific CDP port (leaves user's Chrome alone)
  try {
    const procs = execSync('wmic process where "name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf-8' });
    for (const line of procs.split('\n')) {
      if (line.includes(`--remote-debugging-port=${CDP_PORT}`)) {
        const pid = line.trim().split(',').find(p => /^\d+$/.test(p.trim()));
        if (pid) {
          try { execSync(`taskkill /PID ${pid.trim()} /F`, { stdio: 'ignore' }); console.log(`  Killed bridge Chrome PID ${pid.trim()}`); } catch {}
        }
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 1500));

  // Per-launch nonce — lets the overlay / page scripts match the right Chrome
  // to the right bridge when multiple bridges are running. Bridge stamps it on
  // the welcome URL; server exposes it on /api/identity; page scripts cache it
  // and prefer the matching port. Single-bridge users hit the first-up fallback.
  const BRIDGE_NONCE = crypto.randomBytes(8).toString('hex');

  // Build env for child processes — pass through our port + profile choices
  const childEnv = {
    ...process.env,
    BRIDGE_PORT: String(BRIDGE_PORT),
    CDP_PORT: String(CDP_PORT),
    BRIDGE_PROFILE: PROFILE,
    PW_PORT: String(PW_PORT),
    EMPIR3_BRIDGE_PORT: String(BRIDGE_PORT),
    EMPIR3_BRIDGE_NONCE: BRIDGE_NONCE,
    // bridge.ts reads this and runs Storage.clearDataForOrigin('*') right
    // after CDP connects. Cleared once per launch — not on every request.
    ...(FRESH ? { EMPIR3_BRIDGE_FRESH: '1' } : {}),
  };

  if (FRESH) {
    console.log('  --fresh: cookies + localStorage + IndexedDB will be cleared post-connect');
  }

  // Step 2: Launch CDP bridge
  console.log('  [2/4] Launching CDP bridge (Chrome)...');
  spawn('cmd', ['/c', 'start', '/b', 'npx', 'tsx', CDP_BRIDGE], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  }).unref();

  try {
    const health = await waitForHealth(`http://localhost:${BRIDGE_PORT}/health`, 'CDP Bridge', 45000);
    console.log(`         ✓ Chrome connected (${health.status})`);
  } catch (e) {
    console.error(`         ✗ ${e.message}`);
    process.exit(1);
  }

  // Step 3: Launch HTTP wrapper
  console.log('  [3/4] Launching HTTP wrapper...');
  spawn('cmd', ['/c', 'start', '/b', 'npx', 'tsx', PW_BRIDGE], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  }).unref();

  try {
    await waitForHealth(`http://localhost:${PW_PORT}/api/status`, 'HTTP Wrapper', 20000);
    console.log(`         ✓ Bridge ready on :${PW_PORT}`);
  } catch (e) {
    console.error(`         ✗ ${e.message}`);
    process.exit(1);
  }

  // Step 4: Confirm
  console.log('  [4/4] Verifying...');
  await status();

  console.log('  Ready!');
  if (PW_PORT === 3006) {
    console.log('  MCP tools should now be available (empir3-browser).');
  } else {
    console.log(`  Drive this bridge with:`);
    console.log(`    BRIDGE_URL=http://localhost:${PW_PORT} npx tsx src/cli.ts <command>`);
    console.log(`  (MCP only auto-discovers the default :3006 bridge.)`);
  }

  // Wave 1.5 — surface chat-with-Claude readiness so first-run users
  // know which knob to turn. We read the config JSON directly here so
  // launch.js doesn't have to load TS modules.
  try {
    const cfgPath = path.join(os.homedir(), '.empir3-bridge', 'config.json');
    const legacyCfgPath = path.join(os.homedir(), '.claude-bridge', 'config.json');
    let mode = null, hasKey = false, cliPath = '', model = '';
    const readableCfgPath = fs.existsSync(cfgPath) ? cfgPath : fs.existsSync(legacyCfgPath) ? legacyCfgPath : '';
    if (readableCfgPath) {
      const cfg = JSON.parse(fs.readFileSync(readableCfgPath, 'utf-8'));
      mode = cfg.mode || null;
      hasKey = !!(cfg.anthropicApiKey && cfg.anthropicApiKey.length > 0);
      cliPath = cfg.claudeCliPath || '';
      model = cfg.model || '';
    }
    const cliOnPath = !cliPath ? detectClaudeOnPath() : cliPath;
    const ready = (mode === 'api' && hasKey) || (mode === 'cli' && cliOnPath) || (!mode && cliOnPath);
    if (ready) {
      const effectiveMode = mode || (cliOnPath ? 'cli' : 'api');
      const detail = effectiveMode === 'cli'
        ? `mode=cli, ${cliOnPath || 'auto-detect'}${model ? ', model=' + model : ''}`
        : `mode=api, key set${model ? ', model=' + model : ''}`;
      console.log(`  empir3 Chat: configured (${detail})`);
    } else {
      console.log(`  empir3 Chat: NOT configured - open http://localhost:${PW_PORT}/settings to set up.`);
    }
  } catch { /* config check is best-effort; never block startup */ }
  console.log('');
}

function detectClaudeOnPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return '';
    if (process.platform === 'win32') {
      const cmdShim = lines.find(l => l.toLowerCase().endsWith('.cmd'));
      if (cmdShim) return cmdShim;
    }
    return lines[0];
  } catch { return ''; }
}

// ── CLI ──
const args = process.argv.slice(2);
// `--fresh` (alias `--clean`) hard-clears cookies + localStorage + IndexedDB
// for every origin BEFORE returning. Use it for smoke tests, demos, or any
// time you want a guaranteed clean-user state. Extensions, settings, and the
// profile dir itself are preserved — only site data is wiped.
const FRESH = args.includes('--fresh') || args.includes('--clean');
if (args.includes('--kill')) kill();
else if (args.includes('--status')) status();
else launch();
