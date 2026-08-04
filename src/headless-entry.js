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
 *
 * Env:
 *   EMPIR3_HEADLESS=1            no tray, no update banner, no welcome page
 *   EMPIR3_CHROME_AUTOLAUNCH=0   don't start Chromium until a browser tool needs it
 *   EMPIR3_PW_PORT               HTTP wrapper port   (default 3006)
 *   EMPIR3_BRIDGE_HTTP_PORT      CDP bridge port     (default 9867)
 *   EMPIR3_CDP_PORT              Chrome CDP port     (default 9222)
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
 * Headless defaults. A server has no display and usually no need for a browser
 * until something asks for one, so Chromium is opt-in rather than started at
 * boot (it costs ~300MB on a 2GB VPS and, with no DISPLAY, used to fail and
 * then poll forever).
 */
if (process.env.EMPIR3_HEADLESS === undefined) process.env.EMPIR3_HEADLESS = '1';
if (process.env.EMPIR3_HEADLESS === '1') {
  if (process.env.BRIDGE_HEADLESS === undefined) process.env.BRIDGE_HEADLESS = 'true';
  if (process.env.EMPIR3_CHROME_AUTOLAUNCH === undefined) process.env.EMPIR3_CHROME_AUTOLAUNCH = '0';
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
  console.log(`[empir3-bridge] headless start (${mods.mode} mode) ports: wrapper=${PW_PORT} bridge=${BRIDGE_PORT} cdp=${CDP_PORT}`);
  console.log(`[empir3-bridge] chrome autolaunch=${process.env.EMPIR3_CHROME_AUTOLAUNCH === '0' ? 'off (lazy)' : 'on'}`);

  if (mods.mode === 'source') ensureTypeScriptLoader();

  // Reap any stale predecessor holding our ports before we bind.
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

if (require.main === module) {
  installSignalHandlers();
  startHeadlessRuntime().catch((err) => {
    console.error('[empir3-bridge] failed to start:', (err && err.stack) || err);
    process.exit(1);
  });
}

module.exports = { startHeadlessRuntime, resolveRuntimeModules, installSignalHandlers };
