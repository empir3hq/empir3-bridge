#!/usr/bin/env node
/**
 * Empir3 Bridge — headless / server entrypoint.
 *
 * THE SYSTEMD CONTRACT. `npm start` (src/launch.js) spawns both halves
 * DETACHED and then exits 0. Under `Type=simple` + `Restart=always` systemd
 * sees the main PID exit and restarts it — forever — so even with the ENOENT
 * spawn bug fixed, `ExecStart=... npm start` still crash-loops. Detached
 * children also mean a dead server leaves an orphan CDP bridge and an orphan
 * Chromium holding ports.
 *
 * This entrypoint instead runs BOTH halves in ONE foreground process, the
 * shape src/payload-daemon.ts already proves in production on Windows:
 *   require(bridge) → wait /health → require(server) → wait /api/status → block
 *
 * systemd then gets the real main PID, so Restart=, MemoryMax=, KillMode= and
 * `systemctl show -p NRestarts` all work correctly — none of which is true
 * through `bash -lc 'npm start'`.
 *
 * Usage:
 *   node src/headless-entry.js
 *   node src/headless-entry.js --pair <code>              pair, then start
 *   node src/headless-entry.js --pair <code> --pair-only  pair and exit (installer one-shot)
 *
 * Env:
 *   EMPIR3_HEADLESS=1            no tray, no update banner, no welcome page
 *   EMPIR3_CHROME_AUTOLAUNCH=0   don't start Chromium until a browser tool needs it
 *   EMPIR3_PW_PORT               HTTP wrapper port   (default 3006)
 *   EMPIR3_BRIDGE_HTTP_PORT      CDP bridge port     (default 9867)
 *   EMPIR3_CDP_PORT              Chrome CDP port     (default 9222)
 *   EMPIR3_SKIP_PREDECESSOR_REAP supervised hosts own process cleanup
 *   EMPIR3_PAIR_CODE             pre-authorized pairing code (same as --pair;
 *                                ignored when the box is already paired)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

const PW_PORT = parseInt(process.env.EMPIR3_PW_PORT || process.env.PW_PORT || '3006', 10);
const BRIDGE_PORT = parseInt(process.env.EMPIR3_BRIDGE_HTTP_PORT || process.env.EMPIR3_BRIDGE_PORT || '9867', 10);
const CDP_PORT = parseInt(process.env.EMPIR3_CDP_PORT || process.env.CDP_PORT || '9222', 10);

/**
 * A systemd install is not inherently headless. Some agent boxes expose Xvfb
 * (often without exporting DISPLAY to the service), and the shared platform
 * profile deliberately discovers those X11 sockets. Do not pin either
 * headless override here: doing so used to blind every installed box even
 * when a usable display was present. Truly display-less hosts still resolve
 * as headless through platform-profile.js and keep Chromium lazy.
 */
const { getPlatformProfile } = require('./platform-profile.js');
const hostProfile = getPlatformProfile();
if (!process.env.DISPLAY && hostProfile.x11Display) {
  process.env.DISPLAY = hostProfile.x11Display;
}
if (hostProfile.headless && process.env.EMPIR3_CHROME_AUTOLAUNCH === undefined) {
  process.env.EMPIR3_CHROME_AUTOLAUNCH = '0';
}

process.env.EMPIR3_BRIDGE_PORT = String(BRIDGE_PORT);
process.env.BRIDGE_PORT = String(BRIDGE_PORT);
process.env.PW_PORT = String(PW_PORT);
process.env.CDP_PORT = String(CDP_PORT);
if (!process.env.EMPIR3_BRIDGE_NONCE) {
  process.env.EMPIR3_BRIDGE_NONCE = crypto.randomBytes(8).toString('hex');
}

/**
 * Resolve the runtime modules. A published payload ships esbuild bundles; a
 * git clone (the Linux install path) has only TypeScript sources and needs the
 * tsx loader registered first.
 */
function resolveRuntimeModules() {
  const bundleBridge = path.join(ROOT, 'dist', 'bundle-bridge.js');
  const bundleServer = path.join(ROOT, 'dist', 'bundle-server.js');
  if (fs.existsSync(bundleBridge) && fs.existsSync(bundleServer)) {
    return { bridge: bundleBridge, server: bundleServer, mode: 'bundle' };
  }
  return {
    bridge: path.join(ROOT, 'src', 'bridge.ts'),
    server: path.join(ROOT, 'src', 'server.ts'),
    mode: 'source',
  };
}

/** Register tsx's CJS hook so require() can load .ts. Idempotent. */
let tsLoaderReady = false;
function ensureTypeScriptLoader() {
  if (tsLoaderReady) return;
  try {
    require('tsx/cjs');
    tsLoaderReady = true;
  } catch (err) {
    throw new Error(
      `Cannot load TypeScript sources — tsx is not installed. Run \`npm ci\` in ${ROOT}. (${err && err.message})`,
    );
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mirror server.ts / pair-claim.ts: %APPDATA%\Empir3 on Windows, ~/.empir3/Empir3 elsewhere.
const AUTH_FILE = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), '.empir3'),
  'Empir3', 'bridge-auth.json',
);

/**
 * Unattended pairing (the Linux twin of `Empir3Setup.exe --pair <code>` in
 * build/payload-entry.js). The code arrives either as `--pair <code>` or as
 * EMPIR3_PAIR_CODE — the env form exists so install.sh / cloud-init can hand it
 * over without editing a command line. An explicit --pair always claims (the
 * operator may be re-pairing to a different account); an env code on an
 * already-paired box is ignored, because the service env persists across
 * restarts and must not re-pair on every boot.
 */
function parsePairRequest(argv = process.argv.slice(2), env = process.env) {
  const idx = argv.indexOf('--pair');
  const fromArgv = idx !== -1 ? String(argv[idx + 1] || '').trim() : '';
  const fromEnv = String(env.EMPIR3_PAIR_CODE || '').trim();
  const code = fromArgv || fromEnv;
  if (!code) return null;
  return { code, source: fromArgv ? 'argv' : 'env', only: argv.includes('--pair-only') };
}

async function claimPreauthorizedPairing(pair) {
  if (pair.source === 'env' && fs.existsSync(AUTH_FILE)) {
    console.log('[empir3-bridge] pair: already paired — ignoring EMPIR3_PAIR_CODE');
    return { ok: true, status: 'already_paired' };
  }
  try {
    // The published runtime ships the same bundle name as the Windows payload;
    // a git clone falls back to the TypeScript source via tsx.
    const bundle = path.join(ROOT, 'dist', 'bundle-pair-claim.js');
    if (!fs.existsSync(bundle)) ensureTypeScriptLoader();
    const { claimPairingCode } = require(fs.existsSync(bundle) ? bundle : path.join(ROOT, 'src', 'pair-claim.ts'));
    const result = await claimPairingCode(pair.code, { log: (m) => console.log(`[empir3-bridge] pair: ${m}`) });
    console.log(`[empir3-bridge] pair: result=${result.status}${result.user && result.user.email ? ` (${result.user.email})` : ''}`);
    return result;
  } catch (e) {
    console.error('[empir3-bridge] pair: claim threw:', (e && e.message) || e);
    return { ok: false, status: 'error', reason: (e && e.message) || String(e) };
  }
}

/**
 * The standalone/systemd host owns its whole Bridge process set and may reap a
 * stale predecessor before binding. A desktop supervisor can opt out after it
 * has probed its exact wrapper port; this prevents a development instance from
 * sweeping up a different installed Bridge on platforms where process
 * environment inspection is unavailable.
 */
function shouldReapPredecessors(env = process.env) {
  return env.EMPIR3_SKIP_PREDECESSOR_REAP !== '1';
}

function getJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitFor(url, label, maxWaitMs, isReady = () => true) {
  const start = Date.now();
  let lastErr = 'no response';
  while (Date.now() - start < maxWaitMs) {
    try {
      const body = await getJson(url);
      if (isReady(body)) return;
      lastErr = 'responded but not ready';
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    await wait(500);
  }
  throw new Error(`${label} did not become ready at ${url} within ${Math.round(maxWaitMs / 1000)}s (${lastErr})`);
}

let shuttingDown = false;

/**
 * Stop cleanly within systemd's TimeoutStopSec. We do not try to unwind the
 * in-process servers — exiting the process releases the ports, and any Chromium
 * we launched is a child of this process, so it goes with us.
 */
function installSignalHandlers() {
  const stop = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[empir3-bridge] ${signal} — shutting down`);
    // Give in-flight writes a moment, then exit. Never hang the unit.
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // Both halves share this process now, so an unhandled rejection in either
  // must take the unit down rather than leave a half-dead bridge that systemd
  // still believes is healthy. Restart=always then gives us a clean restart.
  process.on('unhandledRejection', (err) => {
    console.error('[empir3-bridge] unhandled rejection — exiting for restart:', err);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[empir3-bridge] uncaught exception — exiting for restart:', err);
    process.exit(1);
  });
}

async function startHeadlessRuntime() {
  const mods = resolveRuntimeModules();
  // The bundled payload is installed read-only. This marker tells the shared
  // server to place mutable runtime data under the user's Bridge state folder
  // instead of beside the bundles. Desktop hosts set the same marker before
  // spawning this entrypoint.
  if (mods.mode === 'bundle' && !process.env.EMPIR3_BRIDGE_PAYLOAD_DIR) {
    process.env.EMPIR3_BRIDGE_PAYLOAD_DIR = ROOT;
  }
  console.log(`[empir3-bridge] headless start (${mods.mode} mode) ports: wrapper=${PW_PORT} bridge=${BRIDGE_PORT} cdp=${CDP_PORT}`);
  console.log(`[empir3-bridge] chrome autolaunch=${process.env.EMPIR3_CHROME_AUTOLAUNCH === '0' ? 'off (lazy)' : 'on'}`);

  if (mods.mode === 'source') ensureTypeScriptLoader();

  // Standalone hosts reap stale predecessors. Supervising hosts deliberately
  // skip this broad fallback and let an occupied port fail closed instead.
  if (shouldReapPredecessors()) {
    try {
      const { listOwnedProcesses, reapProcesses } = require('./proc-util.js');
      const owned = listOwnedProcesses({
        root: ROOT, cdpPort: CDP_PORT, pwPort: PW_PORT, bridgePort: BRIDGE_PORT,
      });
      if (owned.length) {
        console.log(`[empir3-bridge] reaping ${owned.length} stale bridge process(es)`);
        reapProcesses(owned.map(p => p.pid), { log: (m) => console.log(m) });
        await wait(750);
      }
    } catch (e) {
      console.warn('[empir3-bridge] predecessor reap skipped:', (e && e.message) || e);
    }
  } else {
    console.log('[empir3-bridge] predecessor reap disabled by supervising host');
  }

  require(mods.bridge);
  await waitFor(`http://127.0.0.1:${BRIDGE_PORT}/health`, 'CDP bridge', 45_000,
    (body) => !!body && typeof body.status === 'string');
  console.log('[empir3-bridge] CDP bridge ready');

  require(mods.server);
  await waitFor(`http://127.0.0.1:${PW_PORT}/api/status`, 'HTTP wrapper', 30_000,
    (body) => !!body);
  console.log(`[empir3-bridge] ready on http://127.0.0.1:${PW_PORT}`);

  // Block forever. THIS is what makes the systemd contract correct: the main
  // PID stays alive for the lifetime of the service.
  await new Promise(() => {});
}

async function main() {
  const pair = parsePairRequest();
  if (pair) {
    // The code is single-use; keep it out of every child process environment.
    delete process.env.EMPIR3_PAIR_CODE;
    const result = await claimPreauthorizedPairing(pair);
    if (pair.only) process.exit(result.ok ? 0 : 1);
    // Best-effort otherwise: a failed claim falls through to the normal
    // interactive pairing path — never block the daemon from starting.
  }
  await startHeadlessRuntime();
}

if (require.main === module) {
  installSignalHandlers();
  main().catch((err) => {
    console.error('[empir3-bridge] failed to start:', (err && err.stack) || err);
    process.exit(1);
  });
}

module.exports = {
  startHeadlessRuntime,
  resolveRuntimeModules,
  installSignalHandlers,
  shouldReapPredecessors,
  parsePairRequest,
};
