#!/usr/bin/env node
/**
 * scale.js — spin up N parallel Empir3 Bridge instances for multi-agent work.
 *
 * Each instance is a fully isolated bridge: its own wrapper port, CDP-bridge
 * port, Chrome remote-debug port, and Chrome profile dir. Because the active-tab
 * pointer (`currentTargetId`) lives inside each bridge process, two agents on two
 * instances can drive two Chromes with ZERO cross-talk — one agent per browser.
 *
 * Instance 1 is your PRIMARY/default bridge (ports 3006/9867/9222, the one the
 * MCP server auto-launches). scale.js NEVER launches or kills instance 1 — it
 * only ever reports its health. Extras are instances 2..N. This is deliberate:
 * relaunching instance 1 would kill your main Chrome session and its open tabs.
 *
 * Port scheme (+100 stride per instance, matching src/launch.js's header):
 *   #   wrapper   cdp-bridge   chrome-cdp   profile
 *   1   3006      9867         9222         ~/.empir3-bridge/profile        (primary)
 *   2   3106      9967         9322         ~/.empir3-bridge/profile-2
 *   3   3206      10067        9422         ~/.empir3-bridge/profile-3
 *   4   3306      10167        9522         ~/.empir3-bridge/profile-4
 *
 * Usage:
 *   node scripts/scale.js up 3          # ensure instances 2 and 3 are running
 *   node scripts/scale.js status 4      # health of instances 1..4
 *   node scripts/scale.js down 3        # stop extras 2 and 3 (never touches 1)
 *   node scripts/scale.js down all      # stop ALL extras it can find (2..MAX)
 *
 * Drive an extra instance (agent-facing):
 *   BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts navigate "https://example.com"
 *   BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts snapshot
 * or wire a second MCP server (see the block scale.js prints after `up`).
 */

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'src', 'launch.js');
const HOME = os.homedir();

// Highest extra index scale.js will probe/reap when asked for "all".
const MAX_INSTANCE = 8;

/** The isolated resource quadruple for instance `i` (1 = primary/default). */
function instance(i) {
  const step = i - 1; // primary = 0 offset
  return {
    index: i,
    primary: i === 1,
    pwPort: 3006 + step * 100,
    bridgePort: 9867 + step * 100,
    cdpPort: 9222 + step * 100,
    profile: i === 1
      ? path.join(HOME, '.empir3-bridge', 'profile')
      : path.join(HOME, '.empir3-bridge', `profile-${i}`),
    label: i === 1 ? 'BRIDGE' : `BRIDGE-${i}`,
    bridgeUrl: `http://localhost:${3006 + step * 100}`,
  };
}

function getJson(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function health(inst) {
  const body = await getJson(`${inst.bridgeUrl}/api/status`);
  return !!(body && body.running);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run src/launch.js for one instance with its env; resolve on wrapper health. */
function runLauncher(inst, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        EMPIR3_PW_PORT: String(inst.pwPort),
        EMPIR3_BRIDGE_HTTP_PORT: String(inst.bridgePort),
        EMPIR3_CDP_PORT: String(inst.cdpPort),
        EMPIR3_BRIDGE_PROFILE: inst.profile,
        EMPIR3_BRIDGE_LABEL: inst.label,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: out + '\n' + e.message }));
  });
}

async function up(target) {
  const n = Math.max(1, Math.min(MAX_INSTANCE, parseInt(target || '2', 10) || 2));
  console.log(`\n  Scaling to ${n} bridge instance(s) (instance 1 = your primary; managing extras 2..${n})\n`);

  // Instance 1: report only, never launch/kill.
  const primary = instance(1);
  const primaryUp = await health(primary);
  console.log(`  #1 ${primary.label.padEnd(9)} :${primary.pwPort}  ${primaryUp ? '✓ running (primary — left untouched)' : '✗ down (start it normally / via MCP; scale.js will not launch it)'}`);

  const ready = [primary].filter(() => primaryUp);

  for (let i = 2; i <= n; i++) {
    const inst = instance(i);
    if (await health(inst)) {
      console.log(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  ✓ already running`);
      ready.push(inst);
      continue;
    }
    process.stdout.write(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  … launching (cdp ${inst.cdpPort}, profile ${path.basename(inst.profile)})`);
    const { out } = await runLauncher(inst);
    // launch.js exits after its own health gate; confirm from our side as truth.
    let healthy = false;
    for (let t = 0; t < 40 && !healthy; t++) { healthy = await health(inst); if (!healthy) await sleep(500); }
    if (healthy) {
      console.log(`  → ✓ ready`);
      ready.push(inst);
    } else {
      console.log(`  → ✗ FAILED`);
      const tail = out.split('\n').filter(Boolean).slice(-6).join('\n      ');
      if (tail) console.log(`      ${tail}`);
    }
  }

  printConnectionInfo(ready.filter((r) => !r.primary));
  return ready;
}

function printConnectionInfo(extras) {
  if (!extras.length) {
    console.log(`\n  No extra instances running. (Instance 1 is driven by the default MCP server.)\n`);
    return;
  }
  console.log(`\n  ── Drive each extra instance ──`);
  for (const inst of extras) {
    console.log(`  #${inst.index}  BRIDGE_URL=${inst.bridgeUrl} npx tsx src/cli.ts <navigate|snapshot|click-ref|...>`);
  }
  console.log(`\n  ── Second-agent MCP registration (.mcp.json) ──`);
  const servers = {};
  for (const inst of extras) {
    servers[`empir3-bridge-${inst.index}`] = {
      type: 'stdio',
      command: 'npx',
      args: ['tsx', path.join(ROOT, 'src', 'mcp-server.ts').replace(/\\/g, '/')],
      env: { BRIDGE_URL: inst.bridgeUrl },
    };
  }
  console.log('  ' + JSON.stringify({ mcpServers: servers }, null, 2).replace(/\n/g, '\n  '));
  console.log(`\n  (Start the instance with scale.js BEFORE the MCP server connects — an extra`);
  console.log(`   MCP server only connects to BRIDGE_URL; it does not auto-launch extras.)\n`);
}

async function status(target) {
  const n = Math.max(1, Math.min(MAX_INSTANCE, parseInt(target || '4', 10) || 4));
  console.log(`\n  Bridge instances (probing 1..${n})`);
  console.log('  ' + '─'.repeat(52));
  for (let i = 1; i <= n; i++) {
    const inst = instance(i);
    const body = await getJson(`${inst.bridgeUrl}/api/status`);
    const cdp = await getJson(`http://localhost:${inst.bridgePort}/health`);
    const up = !!(body && body.running);
    const tag = inst.primary ? ' (primary)' : '';
    if (up) {
      const url = (body.currentUrl || '').slice(0, 46);
      console.log(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  ✓  cdp=${cdp && cdp.cdpPort ? cdp.cdpPort : inst.cdpPort} pid=${body.pid || '?'}${tag}`);
      if (url) console.log(`       url: ${url}`);
    } else {
      console.log(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  ·  down${tag}`);
    }
  }
  console.log();
}

async function down(target) {
  const all = String(target || '').toLowerCase() === 'all';
  const n = all ? MAX_INSTANCE : Math.max(2, Math.min(MAX_INSTANCE, parseInt(target || '2', 10) || 2));
  console.log(`\n  Stopping extra instances 2..${n} (instance 1 is never touched)\n`);
  for (let i = 2; i <= n; i++) {
    const inst = instance(i);
    if (!(await health(inst))) {
      if (!all) console.log(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  · already down`);
      continue;
    }
    process.stdout.write(`  #${i} ${inst.label.padEnd(9)} :${inst.pwPort}  … stopping`);
    await runLauncher(inst, ['--kill']);
    await sleep(800);
    const stillUp = await health(inst);
    console.log(stillUp ? `  → ✗ still up` : `  → ✓ stopped`);
  }
  console.log();
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'up': await up(arg); break;
    case 'status': case undefined: await status(arg); break;
    case 'down': await down(arg); break;
    default:
      console.log('Usage: node scripts/scale.js <up N | status [N] | down N|all>');
      process.exit(1);
  }
}

main();
