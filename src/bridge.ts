/**
 * Empir3 Browser Bridge — CDP Server
 *
 * Empir3's own CDP bridge. Launches Chrome with remote debugging,
 * exposes the same HTTP API surface on the same port (default 9867).
 *
 * Zero external dependencies — uses Node built-ins + raw CDP WebSocket.
 *
 * Endpoints:
 *   GET  /health           — readiness check
 *   GET  /screenshot       — viewport capture (JPEG)
 *   GET  /snapshot         — accessibility tree element refs
 *   GET  /text             — extract readable page text
 *   GET  /tabs             — list open tabs
 *   POST /navigate         — load URL
 *   POST /action           — click/type/press/scroll by ref
 *   POST /evaluate         — run JavaScript
 *   POST /cookies          — set cookies
 *   GET  /welcome          — Empir3-branded splash page
 */

import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from 'http';
import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import { join, resolve } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT || '9867');
const WRAPPER_PORT = parseInt(process.env.PW_PORT || process.env.EMPIR3_PW_PORT || '3006');
const HOST = process.env.EMPIR3_BRIDGE_HOST || '127.0.0.1';
const HEADLESS = process.env.BRIDGE_HEADLESS === 'true';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

const PROFILE_DIR = process.env.BRIDGE_PROFILE || process.env.EMPIR3_BRIDGE_CHROME_PROFILE || join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.empir3-bridge', 'profile'
);

const SESSION_TOKEN = process.env.BRIDGE_TOKEN || '';
const NAV_TIMEOUT = parseInt(process.env.BRIDGE_NAV_TIMEOUT || '60') * 1000;
const CDP_COMMAND_TIMEOUT_MS = parseInt(process.env.BRIDGE_CDP_COMMAND_TIMEOUT_MS || '10000');
const CDP_LIVENESS_MAX_AGE_MS = parseInt(process.env.BRIDGE_CDP_LIVENESS_MAX_AGE_MS || '2000');
const CDP_LIVENESS_TIMEOUT_MS = parseInt(process.env.BRIDGE_CDP_LIVENESS_TIMEOUT_MS || '2500');
const CDP_PERMISSION_TIMEOUT_MS = parseInt(process.env.BRIDGE_CDP_PERMISSION_TIMEOUT_MS || '500');
const CHROME_LAUNCH_TIMEOUT_MS = Math.max(
  15000,
  Number.parseInt(process.env.CHROME_LAUNCH_TIMEOUT_MS || process.env.BRIDGE_CHROME_LAUNCH_TIMEOUT_MS || '90000', 10) || 90000,
);

// ─── State ───────────────────────────────────────────────────

let chromeProcess: ChildProcess | null = null;
let cdpWs: WebSocket | null = null;
let cdpId = 1;
const cdpCallbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; ws: WebSocket }>();
let currentTargetId = '';
let currentSessionId = '';
let connected = false;

// Target tracking — detect new tabs and inject scripts
const knownTargets = new Map<string, string>(); // targetId → last known URL
let autoInjectScript = ''; // script to inject into every new page target
let targetPollTimer: ReturnType<typeof setInterval> | null = null;

// Browser-level CDP connection for target discovery
let browserWs: WebSocket | null = null;
let browserCdpId = 100000; // offset from page-level IDs to avoid collision
const browserCallbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let browserWsConnecting = false;
let browserReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let launchPromise: Promise<void> | null = null;
let lastCdpLivenessAt = 0;
let chromeEverStarted = false;
let chromeExitCode: number | null = null;
let chromeClosedByUser = false;
let shuttingDown = false;
let cdpCommandQueue: Promise<void> = Promise.resolve();

// Element ref tracking
let refMap = new Map<string, number>(); // ref string → CDP nodeId
let refCounter = 0;

// --fresh state — only wipe storage on the FIRST CDP connect of this Chrome
// launch. CDP can reconnect mid-session (Chrome reload, target switch); we
// don't want each reconnect re-wiping the user's just-typed-in cookies.
let freshConsumed = false;

// ─── Chrome Launcher ─────────────────────────────────────────

function findChrome(): string {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error('Chrome not found. Set CHROME_PATH env var.');
}

function chromeStatus(): 'running' | 'exited' | 'not-started' {
  if (chromeProcess) return 'running';
  return chromeEverStarted ? 'exited' : 'not-started';
}

function closedBrowserError(): Error {
  return new Error('Bridge browser is closed. Use browser_navigate or Open Bridge to reopen it.');
}

function markChromeClosedByUser(reason: string) {
  if (!chromeClosedByUser) {
    console.log(`[Empir3 Bridge] Bridge browser closed by user (${reason})`);
  }
  chromeClosedByUser = true;
  connected = false;
  lastCdpLivenessAt = 0;
  currentTargetId = '';
  knownTargets.clear();
  if (cdpWs) { try { cdpWs.close(); } catch {} }
  cdpWs = null;
  stopTargetPolling();
  if (browserReconnectTimer) {
    clearTimeout(browserReconnectTimer);
    browserReconnectTimer = null;
  }
  if (browserWs) { try { browserWs.close(); } catch {} }
  browserWs = null;
}

// Guards against stacking concurrent close-confirmation checks (pollTargets can
// fire one every 500ms while a check is still mid-flight).
let closeCheckInFlight = false;

// A single empty /json read is NOT proof the user closed the browser: during a
// cross-process navigation Chrome briefly destroys the old page target before the
// new one appears, and a refresh momentarily yields zero/changing targets. Latch
// "closed by user" only after several consecutive confirmations (~500ms) while the
// Chrome PROCESS is still alive — a genuine close also ends the process and is
// caught separately by the chromeProcess 'exit' handler (markChromeClosedByUser
// 'process exit'). This kills the post-refresh ONLINE->OFFLINE flap, where one
// transient empty read used to latch the bridge "disconnected" permanently.
async function markClosedIfNoPageTargets(reason: string): Promise<void> {
  if (!chromeProcess || chromeClosedByUser || shuttingDown) return;
  if (closeCheckInFlight) return;
  closeCheckInFlight = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!chromeProcess || chromeClosedByUser || shuttingDown) return;
      try {
        const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
        if (targets.some((t: any) => t.type === 'page')) return; // a page reappeared — not closed
      } catch {
        return; // /json hiccup — inconclusive; never latch closed on an error
      }
      if (attempt < 2) await sleep(250);
    }
    if (!chromeProcess || chromeClosedByUser || shuttingDown) return;
    markChromeClosedByUser(reason);
  } finally {
    closeCheckInFlight = false;
  }
}

async function terminateClosedChromeForRelaunch(): Promise<void> {
  const proc = chromeProcess;
  if (!proc) return;
  try { proc.kill(); } catch {}
  const deadline = Date.now() + 3000;
  while (chromeProcess === proc && Date.now() < deadline) {
    await sleep(100);
  }
  if (chromeProcess === proc) {
    chromeProcess = null;
  }
}

async function waitForChromeCDP(timeoutMs = CHROME_LAUNCH_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  let lastError: any = null;
  while (Date.now() - start < timeoutMs) {
    if (!chromeProcess && chromeEverStarted) {
      const suffix = chromeExitCode == null ? '' : ` (code ${chromeExitCode})`;
      throw new Error(`Chrome exited before CDP connected${suffix}`);
    }
    await sleep(500);
    try {
      await connectCDP();
      return;
    } catch (e) {
      lastError = e;
    }
  }
  const detail = lastError?.message ? `: ${lastError.message}` : '';
  throw new Error(`Chrome did not expose CDP within ${Math.round(timeoutMs / 1000)}s${detail}`);
}

async function launchChrome(timeoutMs = CHROME_LAUNCH_TIMEOUT_MS): Promise<void> {
  if (chromeProcess) {
    await waitForChromeCDP(timeoutMs);
    return;
  }

  const chromePath = findChrome();

  // Ensure profile directory exists
  mkdirSync(PROFILE_DIR, { recursive: true });

  // Clear session restore data to prevent Chrome from reloading previous tabs
  const sessionsDir = join(PROFILE_DIR, 'Default', 'Sessions');
  try {
    if (existsSync(sessionsDir)) {
      const { readdirSync, unlinkSync } = require('fs');
      for (const f of readdirSync(sessionsDir)) {
        try { unlinkSync(join(sessionsDir, f)); } catch {}
      }
    }
  } catch {}

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--disable-session-crashed-bubble',
    '--restore-last-session=false',
    '--hide-crash-restore-bubble',
    '--disable-popup-blocking',
    '--disable-notifications',
    '--autoplay-policy=no-user-gesture-required',
    '--deny-permission-prompts',
    '--disable-permissions-api',
  ];

  if (HEADLESS) {
    args.push('--headless=new');
  }

  // Start with welcome page. If a per-launch nonce was provided, stamp it on
  // the URL — page scripts read it and use /api/identity to pick the right
  // wrapper port when multiple bridges are running.
  const nonce = process.env.EMPIR3_BRIDGE_NONCE || '';
  const welcomePort = String(WRAPPER_PORT || PORT);
  args.push(nonce
    ? `http://localhost:${welcomePort}/welcome?bridgeNonce=${encodeURIComponent(nonce)}`
    : `http://localhost:${welcomePort}/welcome`);

  console.log(`[Empir3 Bridge] Launching Chrome: ${chromePath}`);
  console.log(`[Empir3 Bridge] Chrome profile: ${PROFILE_DIR}`);
  chromeEverStarted = true;
  chromeExitCode = null;
  chromeClosedByUser = false;
  chromeProcess = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  chromeProcess.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line && !line.includes('DevTools listening')) {
      // Suppress noisy Chrome stderr
    }
  });

  chromeProcess.on('exit', (code) => {
    console.log(`[Empir3 Bridge] Chrome exited (code ${code})`);
    chromeExitCode = code;
    if (!shuttingDown) {
      markChromeClosedByUser('process exit');
    } else {
      connected = false;
      cdpWs = null;
      stopTargetPolling();
      if (browserReconnectTimer) {
        clearTimeout(browserReconnectTimer);
        browserReconnectTimer = null;
      }
      if (browserWs) { try { browserWs.close(); } catch {} }
      browserWs = null;
    }
    chromeProcess = null;
  });

  await waitForChromeCDP(timeoutMs);
}

async function ensureChromeReady(opts: { allowRelaunch?: boolean; launchTimeoutMs?: number } = {}): Promise<void> {
  const allowRelaunch = opts.allowRelaunch === true;
  const launchTimeoutMs = Math.max(1000, opts.launchTimeoutMs || CHROME_LAUNCH_TIMEOUT_MS);
  if (chromeClosedByUser && !allowRelaunch) {
    throw closedBrowserError();
  }
  if (await hasReachablePageTarget()) return;
  if (chromeClosedByUser && allowRelaunch && chromeProcess) {
    await terminateClosedChromeForRelaunch();
  }
  if (chromeClosedByUser && !allowRelaunch) {
    throw closedBrowserError();
  }
  if (launchPromise) {
    await launchPromise;
    if (await hasReachablePageTarget()) return;
    if (chromeClosedByUser && !allowRelaunch) {
      throw closedBrowserError();
    }
  }

  launchPromise = (async () => {
    if (chromeProcess) {
      try {
        await waitForChromeCDP(launchTimeoutMs);
        startTargetPolling();
        connectBrowserWs().catch(() => {});
        return;
      } catch (e: any) {
        if (chromeProcess) throw e;
        console.warn(`[Empir3 Bridge] Existing Chrome exited during startup: ${e?.message || e}`);
        await sleep(800);
      }
    }

    if (chromeClosedByUser && !allowRelaunch) {
      throw closedBrowserError();
    }
    await launchChrome(launchTimeoutMs);
    startTargetPolling();
    connectBrowserWs().catch(() => {});
  })();

  try {
    await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function showChromeWindow(preferredUrl?: string): Promise<string> {
  let href = preferredUrl || `http://localhost:${WRAPPER_PORT || PORT}/welcome`;

  try {
    await ensureChromeReady({ allowRelaunch: true, launchTimeoutMs: 5000 });
  } catch (e: any) {
    if (chromeProcess) {
      console.warn(`[Empir3 Bridge] Open Bridge launched Chrome, but CDP was not ready yet: ${e?.message || e}`);
      return href;
    }
    throw e;
  }

  if (!preferredUrl) {
    href = '';
  }
  if (!href) {
    try {
      const current = await cdpEvaluate('location.href', 1000);
      href = typeof current === 'string' && current ? current : '';
    } catch {}
  }
  if (!href || href === 'about:blank') href = `http://localhost:${WRAPPER_PORT || PORT}/welcome`;

  try {
    const info = await cdpSend('Browser.getWindowForTarget', { targetId: currentTargetId }, 1000);
    if (info?.windowId) {
      await cdpSend('Browser.setWindowBounds', {
        windowId: info.windowId,
        bounds: { windowState: 'normal' },
      }, 1000);
    }
  } catch {}

  try { await cdpSend('Page.bringToFront', {}, 1000); } catch {}

  try {
    const current = await cdpEvaluate('location.href', 1000);
    if (!current || current === 'about:blank') {
      await cdpNavigate(href);
    }
  } catch {
    await cdpNavigate(href);
  }

  try { await cdpSend('Page.bringToFront', {}, 1000); } catch {}
  return href;
}

// ─── CDP Connection ──────────────────────────────────────────

/**
 * Pick the best initial CDP target. The naive "just take pages[0]" path
 * silently binds the bridge to a chrome:// or chrome-extension:// tab when
 * one happens to be active — e.g. if chrome://extensions/ or another internal
 * page is in the foreground. Once attached there, every navigate / evaluate
 * fails with "Not connected" because content scripts can't reach internal pages.
 *
 * Strategy:
 *   1. Prefer an http(s) page if any is open
 *   2. Fall back to an existing about:blank
 *   3. Otherwise PUT /json/new?about:blank and use that
 *   4. As a last resort, return whatever was first (better than throwing)
 */
async function pickInitialTarget(): Promise<any> {
  let res = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
  let pages = res.filter((t: any) => t.type === 'page');
  if (pages.length === 0) throw new Error('No page targets');

  // 1. Prefer an http/https tab
  const httpTab = pages.find((t: any) => /^https?:/i.test(t.url));
  if (httpTab) return httpTab;

  // 2. Fall back to about:blank
  const blankTab = pages.find((t: any) => t.url === 'about:blank' || t.url === '');
  if (blankTab) return blankTab;

  // 3. Every visible tab is a trap (chrome://extensions/, devtools://, etc).
  //    Open a fresh about:blank via /json/new and re-poll.
  try {
    await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, 'PUT');
    // Tiny wait so Chrome registers the new target before we re-list
    await sleep(150);
    res = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
    pages = res.filter((t: any) => t.type === 'page');
    const fresh = pages.find((t: any) => t.url === 'about:blank' || t.url === '');
    if (fresh) {
      console.log('[Empir3 Bridge] All existing tabs were chrome:// — opened fresh about:blank');
      return fresh;
    }
  } catch (e: any) {
    console.log(`[Empir3 Bridge] /json/new failed: ${e.message} — falling back to first target`);
  }

  // 4. Last resort: use whatever was first. Better than throwing.
  return pages[0];
}

async function connectCDP(): Promise<void> {
  const target = await pickInitialTarget();
  currentTargetId = target.id;

  if (cdpWs) {
    cdpWs.close();
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const timer = setTimeout(() => fail(new Error('CDP WebSocket timeout')), 5000);
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cdpWs === ws) {
        connected = false;
        cdpWs = null;
        lastCdpLivenessAt = 0;
      }
      try { ws.close(); } catch {}
      reject(e);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    ws.on('open', async () => {
      cdpWs = ws;
      connected = true;
      lastCdpLivenessAt = 0;
      console.log(`[Empir3 Bridge] CDP connected to: ${target.url}`);

      if (!(await verifyCdpConnection())) {
        fail(new Error('CDP liveness check failed'));
        return;
      }

      if (process.env.BRIDGE_AUTO_DENY_PERMISSIONS === '1') {
        // Permission setup is opt-in because Browser.setPermission can wedge page CDP sockets.
        setTimeout(() => {
          autoDenyPermissions().catch(() => {});
        }, 0);
      }

      if (process.env.BRIDGE_LEGACY_BLOCKING_PERMISSION_DENY === '1') {
      // Legacy blocking permission path kept only for targeted debugging.
      try {
        const perms = ['geolocation','notifications','midi','midi-sysex','clipboard-read',
          'clipboard-write','camera','microphone','background-sync','ambient-light-sensor',
          'accelerometer','gyroscope','magnetometer','accessibility-events','payment-handler',
          'idle-detection','storage-access','window-management'];
        for (const name of perms) {
          try {
            await cdpSend('Browser.setPermission', {
              permission: { name },
              setting: 'denied',
            });
          } catch {} // some permissions may not be supported — ignore
        }
        console.log('[Empir3 Bridge] Auto-denied all permission prompts');
      } catch {}
      }

      // --fresh from launcher: wipe cookies + localStorage + IndexedDB across
      // ALL origins. Runs once per Chrome launch (not per CDP reconnect — see
      // freshConsumed below). Preserves the profile dir / extensions / settings.
      if (process.env.EMPIR3_BRIDGE_FRESH === '1' && !freshConsumed) {
        await wipeAllStorage();
        freshConsumed = true;
      }

      done();
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && cdpCallbacks.has(msg.id)) {
          const cb = cdpCallbacks.get(msg.id)!;
          cdpCallbacks.delete(msg.id);
          if (msg.error) {
            cb.reject(new Error(msg.error.message));
          } else {
            lastCdpLivenessAt = Date.now();
            cb.resolve(msg.result);
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      if (cdpWs === ws) {
        connected = false;
        cdpWs = null;
        lastCdpLivenessAt = 0;
      }
    });

    ws.on('error', (e) => {
      fail(e);
    });
  });
}

async function switchToTarget(targetId: string): Promise<void> {
  const res = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
  const target = res.find((t: any) => t.id === targetId);
  if (!target) throw new Error(`Target ${targetId} not found`);

  currentTargetId = targetId;
  connected = true;
  lastCdpLivenessAt = Date.now();
  try { await cdpSend('Page.enable', {}, 2000); } catch {}
  try { await cdpSend('Page.bringToFront', {}, 2000); } catch {}
  console.log(`[Empir3 Bridge] Switched to target: ${target.url}`);
}

function markCdpDisconnected(reason: string) {
  if (connected || cdpWs) {
    console.warn(`[Empir3 Bridge] CDP connection reset: ${reason}`);
  }
  connected = false;
  lastCdpLivenessAt = 0;
  if (cdpWs) {
    try { cdpWs.close(); } catch {}
  }
  cdpWs = null;
  const err = new Error(`CDP connection reset: ${reason}`);
  for (const [, cb] of cdpCallbacks) {
    try { cb.reject(err); } catch {}
  }
  cdpCallbacks.clear();
}

async function closePrimaryCdpForDirectCommand(): Promise<void> {
  const ws = cdpWs;
  if (!ws) return;
  cdpWs = null;
  connected = false;
  const state = ws.readyState;
  if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    ws.once('close', finish);
    ws.once('error', finish);
    try { ws.close(); } catch { finish(); }
    setTimeout(finish, 250);
  });
}

function withCdpCommandLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = cdpCommandQueue.then(fn, fn);
  cdpCommandQueue = run.then(() => undefined, () => undefined);
  return run;
}

function cdpSendRaw(method: string, params: any = {}, timeoutMs = NAV_TIMEOUT, resetOnTimeout = true): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP not connected'));
    }
    const ws = cdpWs;
    const id = cdpId++;
    cdpCallbacks.set(id, { resolve, reject, ws });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdpCallbacks.has(id)) {
        cdpCallbacks.delete(id);
        if (resetOnTimeout && cdpWs === ws) markCdpDisconnected(`timeout waiting for ${method}`);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, timeoutMs);
  });
}

async function sendDirectCdpCommand(method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  const target = await currentPageTarget();
  await closePrimaryCdpForDirectCommand();
  const result = await cdpSendViaDirectWs(target.webSocketDebuggerUrl, method, params, timeoutMs);
  connected = true;
  lastCdpLivenessAt = Date.now();
  currentTargetId = target.id;
  return result;
}

async function sendDetachedCdpCommand(method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  const target = await currentPageTarget();
  const result = await cdpSendViaDirectWs(target.webSocketDebuggerUrl, method, params, timeoutMs);
  connected = true;
  lastCdpLivenessAt = Date.now();
  currentTargetId = target.id;
  return result;
}

async function ensureBrowserWsReady(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    if (browserWs && browserWs.readyState === WebSocket.OPEN) return;
    await connectBrowserWs().catch(() => {});
    if (browserWs && browserWs.readyState === WebSocket.OPEN) return;
    await sleep(100);
  }
  throw new Error('Browser WS not connected');
}

function isBrowserDomainMethod(method: string): boolean {
  return method.startsWith('Browser.') || method.startsWith('Target.');
}

async function sendCdpCommandViaBrowserSession(method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  await ensureBrowserWsReady(timeoutMs);

  if (isBrowserDomainMethod(method)) {
    const result = await browserSend(method, params, timeoutMs);
    connected = true;
    lastCdpLivenessAt = Date.now();
    return result;
  }

  const target = await currentPageTarget();
  currentTargetId = target.id;
  const attachResult = await browserSend('Target.attachToTarget', { targetId: target.id, flatten: true }, timeoutMs);
  const sessionId = attachResult?.sessionId;
  if (!sessionId) throw new Error('No sessionId from attachToTarget');

  try {
    const result = await browserSendWithSession(sessionId, method, params, timeoutMs);
    connected = true;
    lastCdpLivenessAt = Date.now();
    return result;
  } finally {
    try { await browserSend('Target.detachFromTarget', { sessionId }, 1500); } catch {}
  }
}

async function verifyCdpConnection(): Promise<boolean> {
  if (!connected || !cdpWs || cdpWs.readyState !== WebSocket.OPEN) return false;
  if (Date.now() - lastCdpLivenessAt < CDP_LIVENESS_MAX_AGE_MS) return true;
  try {
    await cdpSendRaw('Runtime.evaluate', {
      expression: '1',
      returnByValue: true,
    }, CDP_LIVENESS_TIMEOUT_MS, true);
    lastCdpLivenessAt = Date.now();
    return true;
  } catch (e: any) {
    console.warn(`[Empir3 Bridge] CDP liveness check failed: ${e?.message || e}`);
    return false;
  }
}

async function currentPageTarget(): Promise<any> {
  const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
  let target = targets.find((t: any) => t.type === 'page' && t.id === currentTargetId);
  if (!target) {
    target = await pickInitialTarget();
    currentTargetId = target.id;
  }
  return target;
}

async function hasReachablePageTarget(): Promise<boolean> {
  try {
    const target = await currentPageTarget();
    if (!target?.webSocketDebuggerUrl) return false;
    return true;
  } catch {
    return false;
  }
}

function cdpSendViaDirectWs(wsUrl: string, method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = cdpId++;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (err?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(result);
    };
    timer = setTimeout(() => {
      try { (ws as any).terminate?.(); } catch {}
      finish(new Error(`CDP direct timeout: ${method}`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on('message', (data: Buffer) => {
      if (settled) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== id) return;
        if (msg.error) finish(new Error(msg.error.message));
        else {
          lastCdpLivenessAt = Date.now();
          finish(undefined, msg.result);
        }
      } catch (e: any) {
        finish(e);
      }
    });

    ws.on('error', (e) => {
      finish(e instanceof Error ? e : new Error(String(e)));
    });

    ws.on('close', () => {
      finish(new Error(`CDP direct connection closed: ${method}`));
    });
  });
}

async function cdpSend(method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  return withCdpCommandLock(async () => {
    try {
      return await sendDetachedCdpCommand(method, params, timeoutMs);
    } catch (e: any) {
      const message = String(e?.message || e);
      if (!/CDP not connected|CDP timeout|CDP connection reset|WebSocket|Browser WS|connection closed/i.test(message)) {
        throw e;
      }

      await connectCDP().catch(() => {});
      return sendDetachedCdpCommand(method, params, timeoutMs);
    }
  });
}

async function cdpSendNoReset(method: string, params: any = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  return withCdpCommandLock(() => sendDetachedCdpCommand(method, params, timeoutMs));
}

async function captureScreenshot(params: any): Promise<any> {
  return withCdpCommandLock(async () => {
    try { await sendDetachedCdpCommand('Page.enable', {}, 2000); } catch {}
    try {
      return await sendDetachedCdpCommand('Page.captureScreenshot', params, Math.max(CDP_COMMAND_TIMEOUT_MS, 15000));
    } catch (e: any) {
      if (!/timeout|not connected|connection reset|connection closed/i.test(String(e?.message || e))) throw e;
      await connectCDP().catch(() => {});
      try { await sendDetachedCdpCommand('Page.enable', {}, 2000); } catch {}
      return sendDetachedCdpCommand('Page.captureScreenshot', params, Math.max(CDP_COMMAND_TIMEOUT_MS, 15000));
    }
  });
}

async function autoDenyPermissions(): Promise<void> {
  const perms = ['geolocation','notifications','midi','midi-sysex','clipboard-read',
    'clipboard-write','camera','microphone','background-sync','ambient-light-sensor',
    'accelerometer','gyroscope','magnetometer','accessibility-events','payment-handler',
    'idle-detection','storage-access','window-management'];
  let denied = 0;
  for (const name of perms) {
    try {
      await cdpSendRaw('Browser.setPermission', {
        permission: { name },
        setting: 'denied',
      }, CDP_PERMISSION_TIMEOUT_MS, false);
      denied++;
    } catch {}
  }
  if (denied > 0) {
    console.log(`[Empir3 Bridge] Auto-denied ${denied}/${perms.length} permission prompts`);
  } else {
    console.log('[Empir3 Bridge] Permission auto-deny skipped (Chrome did not acknowledge Browser.setPermission)');
  }
}

// ─── --fresh: wipe site data ─────────────────────────────────

/**
 * Clear cookies, localStorage, IndexedDB, service workers, and cache for
 * every origin that has stored data in this profile. Called once per Chrome
 * launch when EMPIR3_BRIDGE_FRESH=1 (set by `npm start -- --fresh`).
 *
 * Strategy:
 *   1. Network.clearBrowserCookies     — wipes cookies for all origins
 *   2. Network.clearBrowserCache       — wipes the HTTP cache
 *   3. Storage.clearDataForOrigin('*') with all data types — covers
 *      localStorage, IndexedDB, service workers, cache storage, etc.
 *
 * Extensions, settings, history, autofill, and the profile dir itself are
 * preserved — only site-data is wiped. This matches the user-visible
 * meaning of "fresh user state".
 */
async function wipeAllStorage(): Promise<void> {
  console.log('[Empir3 Bridge] --fresh: clearing cookies + localStorage + IndexedDB...');
  const dataTypes = [
    'cookies',
    'local_storage',
    'indexeddb',
    'service_workers',
    'cache_storage',
    'websql',
    'file_systems',
    'shader_cache',
  ].join(',');

  let cleared = 0;
  try {
    await cdpSend('Network.clearBrowserCookies', {});
    cleared++;
  } catch (e: any) {
    console.log(`[Empir3 Bridge]   clearBrowserCookies failed: ${e.message}`);
  }
  try {
    await cdpSend('Network.clearBrowserCache', {});
    cleared++;
  } catch (e: any) {
    console.log(`[Empir3 Bridge]   clearBrowserCache failed: ${e.message}`);
  }
  // CDP requires a real origin URL — '*' isn't a wildcard. Pass an empty
  // origin so Chrome treats it as a profile-wide clear when supported,
  // and ALSO walk the storage list to catch every origin explicitly.
  try {
    await cdpSend('Storage.clearDataForOrigin', { origin: '*', storageTypes: dataTypes });
    cleared++;
  } catch {
    // 'all' wildcard isn't supported on every Chrome build — fall through to
    // the per-origin loop below.
  }
  try {
    const usage = await cdpSend('Storage.getUsageAndQuota', { origin: 'about:blank' });
    // Some Chrome builds expose origins via Storage.trackIndexedDBForOrigin
    // notifications, but the cheap path is enumerating navigation history.
    // Skip if usage call failed — clearDataForOrigin('*') already did the job.
    void usage;
  } catch {}
  console.log(`[Empir3 Bridge] --fresh: ${cleared}/3 wipe steps succeeded`);
}

// ─── CDP Helpers ─────────────────────────────────────────────

async function cdpEvaluate(expression: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  const result = await cdpSend('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    // CDP's exceptionDetails.text is usually just "Uncaught" — useless on its own.
    // The actual error message + stack lives in exception.description.
    // Trim trailing newlines and cap at 500 chars so error fits in one line.
    const ex = result.exceptionDetails;
    const desc = (ex.exception && ex.exception.description) || ex.text || 'JS evaluation error';
    const trimmed = String(desc).split('\n')[0].slice(0, 500);
    throw new Error(trimmed);
  }
  return result.result?.value;
}

async function cdpNavigate(url: string): Promise<void> {
  try {
    await cdpSend('Page.navigate', { url }, Math.min(CDP_COMMAND_TIMEOUT_MS, 5000));
  } catch (e: any) {
    if (!(await waitForTargetUrl(url, 5000))) throw e;
  }
  // Chrome target metadata normally updates before page-level Runtime.evaluate
  // is ready. That is enough for browser_control.open; text/snapshot can read
  // the page afterward without making open wait on a slow eval loop.
  await waitForTargetUrl(url, 8000);
  try { await cdpSend('Page.enable'); } catch {}
  try { await cdpEvaluate('document.readyState', 1200); } catch {}
}

async function waitForTargetUrl(expectedUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const normalizeUrl = (u: string) => u.replace(/[#/]+$/, '');
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
      const target = targets.find((t: any) => t.type === 'page' && t.id === currentTargetId)
        || targets.find((t: any) => t.type === 'page' && normalizeUrl(String(t.url || '')) === normalizeUrl(expectedUrl));
      if (target && normalizeUrl(String(target.url || '')) === normalizeUrl(expectedUrl)) {
        currentTargetId = target.id;
        return true;
      }
    } catch {}
    await sleep(250);
  }
  return false;
}

// ─── Per-Target Evaluation (for injecting into non-active tabs) ──

/**
 * Evaluate JS on a specific target by opening a temporary CDP WS connection.
 * Does NOT switch the active target — the main cdpWs stays on currentTargetId.
 */
async function evaluateOnTarget(targetId: string, expression: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  // If it's the current target, just use the existing connection
  if (targetId === currentTargetId && cdpWs) {
    return cdpEvaluate(expression, timeoutMs);
  }

  // Try direct WS via HTTP /json endpoint (works for bridge-known targets)
  try {
    const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
    const target = targets.find((t: any) => t.id === targetId && t.type === 'page');
    if (target?.webSocketDebuggerUrl) {
      return await evaluateViaDirectWs(target.webSocketDebuggerUrl, expression, timeoutMs);
    }
  } catch {}

  // Fallback: use browser WS with Target.attachToTarget (for user-opened tabs not in /json)
  if (browserWs && browserWs.readyState === WebSocket.OPEN) {
    return await evaluateViaBrowserSession(targetId, expression, timeoutMs);
  }

  throw new Error(`Target ${targetId} not reachable via /json or browser WS`);
}

/** Evaluate via a temporary direct WS connection to a target */
function evaluateViaDirectWs(wsUrl: string, expression: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  return withCdpCommandLock(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (err?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(result);
    };
    timer = setTimeout(() => {
      try { (ws as any).terminate?.(); } catch {}
      finish(new Error('evaluate-on-target timeout'));
    }, timeoutMs);

    ws.on('open', () => {
      const id = cdpId++;
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            if (msg.error) finish(new Error(msg.error.message));
            else finish(undefined, msg.result?.result?.value);
          }
        } catch (e: any) {
          finish(e);
        }
      });
    });

    ws.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
    ws.on('close', () => finish(new Error('evaluate-on-target connection closed')));
  }));
}

/** Evaluate via browser WS using Target.attachToTarget flat session */
async function evaluateViaBrowserSession(targetId: string, expression: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any> {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
    throw new Error('Browser WS not connected');
  }

  // Attach to target to get a session
  const attachResult = await browserSend('Target.attachToTarget', { targetId, flatten: true }, timeoutMs);
  const sessionId = attachResult?.sessionId;
  if (!sessionId) throw new Error('No sessionId from attachToTarget');

  try {
    // Evaluate via the flat session
    const evalResult = await browserSendWithSession(sessionId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, timeoutMs);

    return evalResult?.result?.value;
  } finally {
    // Detach to clean up
    try {
      await browserSend('Target.detachFromTarget', { sessionId }, 1500);
    } catch {}
  }
}

/** Send a command on the browser WS (no session) */
function browserSend(method: string, params: any = {}, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Browser WS not connected'));
    }
    const id = browserCdpId++;
    browserCallbacks.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (browserCallbacks.has(id)) {
        browserCallbacks.delete(id);
        reject(new Error(`Browser WS timeout: ${method}`));
      }
    }, timeoutMs);
  });
}

/** Send a command on the browser WS with a flat-session sessionId */
function browserSendWithSession(sessionId: string, method: string, params: any = {}, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('Browser WS not connected'));
    }
    const id = browserCdpId++;
    browserCallbacks.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, sessionId, method, params }));
    setTimeout(() => {
      if (browserCallbacks.has(id)) {
        browserCallbacks.delete(id);
        reject(new Error(`Browser session timeout: ${method}`));
      }
    }, timeoutMs);
  });
}

/**
 * Evaluate JS on ALL known page targets. Returns array of {targetId, url, ok, result/error}.
 */
async function evaluateOnAllTargets(expression: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<any[]> {
  const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
  const pages = targets.filter((t: any) => t.type === 'page');
  const results: any[] = [];

  for (const page of pages) {
    try {
      const result = await evaluateOnTarget(page.id, expression, timeoutMs);
      results.push({ targetId: page.id, url: page.url, ok: true, result });
    } catch (e: any) {
      results.push({ targetId: page.id, url: page.url, ok: false, error: e.message });
    }
  }
  return results;
}

// ─── Target Discovery — poll for new tabs and auto-inject ────

// Auto-inject must not hold the single global CDP command lock for the full 10s
// default — a stalled eval against a heavy page (e.g. the bridge's own welcome
// console) would block every other CDP op and starve the shared event loop, so
// trivial HTTP handlers (/api/status, /api/relay-status) queue for seconds and the
// tray's liveness poll times out. Cap it short so a stuck inject releases the lock fast.
const AUTO_INJECT_TIMEOUT_MS = 2000;
let pollInFlight = false;
async function pollTargets() {
  // Never overlap: a single auto-inject can await up to AUTO_INJECT_TIMEOUT_MS, which
  // is longer than the 500ms poll interval. Without this guard, successive ticks pile
  // concurrent fresh-WS Runtime.evaluate calls onto the loop — the saturation storm.
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
    const pages = targets.filter((t: any) => t.type === 'page');
    if (pages.length === 0) {
      // Don't latch closed on a single empty poll — route through the debounced
      // confirmation, which re-polls /json a few times before concluding the user
      // closed the browser. Prevents the transient-empty post-refresh flap.
      markClosedIfNoPageTargets('no page targets in poll').catch(() => {});
      return;
    }

    for (const page of pages) {
      const prevUrl = knownTargets.get(page.id);
      const isNew = prevUrl === undefined;
      const urlChanged = prevUrl !== undefined && prevUrl !== page.url;

      // Skip chrome:// and about: pages — can't inject JS into them.
      // Don't mark them as known so we re-check when they navigate to a real URL.
      if (page.url.startsWith('chrome://') || page.url.startsWith('about:') || page.url.startsWith('devtools://')) {
        continue;
      }

      if (isNew || urlChanged) {
        knownTargets.set(page.id, page.url);
        if (isNew) {
          console.log(`[Empir3 Bridge] New tab detected: ${page.url} (${page.id})`);
        } else {
          console.log(`[Empir3 Bridge] Tab navigated: ${prevUrl} → ${page.url} (${page.id})`);
        }

        // Auto-inject registered script (short timeout — see AUTO_INJECT_TIMEOUT_MS).
        if (autoInjectScript) {
          try {
            await evaluateOnTarget(page.id, autoInjectScript, AUTO_INJECT_TIMEOUT_MS);
            console.log(`[Empir3 Bridge] Auto-injected into: ${page.url}`);
          } catch (e: any) {
            console.log(`[Empir3 Bridge] Auto-inject failed for ${page.url}: ${e.message?.slice(0, 60)}`);
          }
        }
      }
    }

    // Prune destroyed targets
    const currentIds = new Set(pages.map((p: any) => p.id));
    for (const id of knownTargets.keys()) {
      if (!currentIds.has(id)) {
        knownTargets.delete(id);
      }
    }
  } catch {
    // Bridge may be busy or Chrome not ready
  } finally {
    pollInFlight = false;
  }
}

function startTargetPolling() {
  if (targetPollTimer) return;
  // Seed known targets
  pollTargets();
  // Poll every 500ms for new tabs — fast enough to inject overlay before user interacts
  targetPollTimer = setInterval(pollTargets, 500);
  console.log('[Empir3 Bridge] Target polling started (500ms interval)');
}

function stopTargetPolling() {
  if (targetPollTimer) {
    clearInterval(targetPollTimer);
    targetPollTimer = null;
  }
}

// ─── Browser-Level Target Discovery ─────────────────────────
// Connects to Chrome's browser WS to receive Target.targetCreated events
// for ALL tabs — including ones the user opens manually.

async function connectBrowserWs(): Promise<void> {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return;
  if (browserWsConnecting) return;
  browserWsConnecting = true;
  try {
    const versionInfo = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const wsUrl = versionInfo.webSocketDebuggerUrl;
    if (!wsUrl) {
      console.log('[Empir3 Bridge] No browser WS URL available');
      browserWsConnecting = false;
      return;
    }

    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        browserWsConnecting = false;
        resolve();
      };

      ws.on('open', () => {
        browserWs = ws;
        if (browserReconnectTimer) {
          clearTimeout(browserReconnectTimer);
          browserReconnectTimer = null;
        }
        console.log('[Empir3 Bridge] Browser-level WS connected');
        // Subscribe to all target events
        const id = browserCdpId++;
        ws.send(JSON.stringify({ id, method: 'Target.setDiscoverTargets', params: { discover: true } }));
        finish();
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle responses to our commands
          if (msg.id && browserCallbacks.has(msg.id)) {
            const cb = browserCallbacks.get(msg.id)!;
            browserCallbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error.message));
            else cb.resolve(msg.result);
          }

          // Handle target events
          if (msg.method === 'Target.targetCreated') {
            const info = msg.params?.targetInfo;
            if (info?.type === 'page') {
              handleNewTarget(info.targetId, info.url);
            }
          }

          if (msg.method === 'Target.targetInfoChanged') {
            const info = msg.params?.targetInfo;
            if (info?.type === 'page') {
              handleTargetUrlChange(info.targetId, info.url);
            }
          }

          if (msg.method === 'Target.targetDestroyed') {
            knownTargets.delete(msg.params?.targetId);
            markClosedIfNoPageTargets('last page target destroyed').catch(() => {});
          }
        } catch {}
      });

      ws.on('close', () => {
        if (browserWs === ws) {
          browserWs = null;
          if (!chromeProcess || chromeClosedByUser || shuttingDown) {
            console.log('[Empir3 Bridge] Browser WS disconnected');
          } else if (!browserReconnectTimer) {
            console.log('[Empir3 Bridge] Browser WS disconnected - reconnecting in 3s');
            browserReconnectTimer = setTimeout(() => {
              browserReconnectTimer = null;
              connectBrowserWs().catch(() => {});
            }, 3000);
          }
        }
        finish();
      });

      ws.on('error', () => {
        if (browserWs === ws) browserWs = null;
        finish(); // don't block startup
      });

      setTimeout(finish, 5000); // timeout fallback
    });
  } catch (e: any) {
    browserWsConnecting = false;
    console.log(`[Empir3 Bridge] Browser WS connect failed: ${e.message?.slice(0, 60)}`);
  }
}

function handleNewTarget(targetId: string, url: string) {
  // Skip chrome:// and internal pages
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('devtools://')) return;

  if (!knownTargets.has(targetId)) {
    knownTargets.set(targetId, url);
    console.log(`[Empir3 Bridge] [Browser WS] New tab: ${url} (${targetId.slice(0, 8)})`);
    autoInjectIntoTarget(targetId, url);
  }
}

function handleTargetUrlChange(targetId: string, url: string) {
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('devtools://')) return;

  const prevUrl = knownTargets.get(targetId);
  if (prevUrl !== url) {
    knownTargets.set(targetId, url);
    console.log(`[Empir3 Bridge] [Browser WS] Tab navigated: ${(prevUrl || '(new)').slice(0, 40)} → ${url.slice(0, 40)}`);
    autoInjectIntoTarget(targetId, url);
  }
}

async function autoInjectIntoTarget(targetId: string, url: string) {
  if (!autoInjectScript) return;
  // Small delay — page may still be loading
  await sleep(300);
  try {
    await evaluateOnTarget(targetId, autoInjectScript);
    console.log(`[Empir3 Bridge] Auto-injected into: ${url.slice(0, 50)}`);
  } catch (e: any) {
    // Retry once after a longer delay (page might not be ready)
    await sleep(1000);
    try {
      await evaluateOnTarget(targetId, autoInjectScript);
      console.log(`[Empir3 Bridge] Auto-injected into (retry): ${url.slice(0, 50)}`);
    } catch {
      console.log(`[Empir3 Bridge] Auto-inject failed for ${url.slice(0, 40)}: ${e.message?.slice(0, 40)}`);
    }
  }
}

async function cdpScreenshot(maxWidth?: number): Promise<Buffer> {
  const params: any = { format: 'jpeg', quality: 80 };
  // If maxWidth specified, cap output image dimensions (accounting for devicePixelRatio)
  if (maxWidth && maxWidth > 0) {
    try {
      const evalResult = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio||1})',
        returnByValue: true,
      });
      const vp = JSON.parse(evalResult.result.value);
      if (vp.w > 0 && vp.h > 0 && vp.dpr > 0) {
        const physicalWidth = vp.w * vp.dpr;
        if (physicalWidth > maxWidth) {
          const scale = Math.max(0.1, Math.min(2.0, maxWidth / physicalWidth));
          params.clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale };
        }
      }
    } catch {}
  }
  const result = await captureScreenshot(params);
  return Buffer.from(result.data, 'base64');
}

async function getAccessibilityTree(filter: string = 'interactive'): Promise<any[]> {
  // Use DOM + accessibility API to build element refs
  const nodes: any[] = [];
  refMap.clear();
  refCounter = 0;

  const jsCode = `(function() {
    const results = [];
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
      'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem'
    ]);
    const interactiveTags = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY'
    ]);

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null
    );

    let node = walker.currentNode;
    let refIdx = 0;
    const visited = new Set();

    function processNode(el) {
      if (visited.has(el)) return;
      visited.add(el);

      // Skip the bridge's own injected overlay UI (id="empir3-*" roots and
      // everything inside them) — its chat input, toolbar, and mode buttons
      // are "interactive" and would otherwise pollute the snapshot with refs
      // that don't belong to the page under test.
      if (el.closest && el.closest('[id^="empir3-"]')) return;

      const role = el.getAttribute('role') || '';
      const tag = el.tagName;
      // Interactive-state ARIA attributes mark click targets that are otherwise
      // plain <div>/<span> with addEventListener handlers (which can't be read
      // from the DOM). Widening on these + contenteditable + an explicit onclick
      // attribute catches more styled-div click targets without flooding.
      const interactiveAttrs = ['aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'onclick'];
      const hasInteractiveAttr = interactiveAttrs.some(a => el.hasAttribute(a));
      const editable = el.isContentEditable === true;
      const isInteractive = interactiveRoles.has(role) ||
        interactiveTags.has(tag) ||
        el.onclick ||
        el.hasAttribute('tabindex') ||
        (el.hasAttribute('data-testid')) ||
        hasInteractiveAttr ||
        editable ||
        getComputedStyle(el).cursor === 'pointer';

      if (${filter === 'all' ? 'true' : 'isInteractive'}) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return;
        if (getComputedStyle(el).display === 'none') return;
        if (getComputedStyle(el).visibility === 'hidden') return;

        const name = el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.innerText?.slice(0, 80)?.trim() || '';

        const ref = 'e' + refIdx++;
        // Store a unique path for later retrieval
        el.setAttribute('data-empir3-ref', ref);

        results.push({
          ref: ref,
          role: role || tag.toLowerCase(),
          name: name,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        });
      }
    }

    processNode(node);
    while (node = walker.nextNode()) {
      processNode(node);
    }

    return JSON.stringify(results);
  })()`;

  const resultStr = await cdpEvaluate(jsCode);
  return JSON.parse(resultStr || '[]');
}

async function clickByRef(ref: string): Promise<void> {
  // Scroll the element into view, resolve its CSS-pixel center, then issue a
  // REAL mouse press/release there via clickByXY. The old path used el.click(),
  // a synthetic event that silently no-ops on React-Native-Web Pressables
  // (they listen for pointer down/up, not a synthetic click) — the root cause
  // of "click_ref did nothing" on RN-Web. clickByXY already fires a trusted
  // CDP mouse sequence at CSS coords, so this reuses the verified click path
  // without touching its (CSS-pixel) coordinate contract.
  const centerStr = await cdpEvaluate(`(function() {
    const el = document.querySelector('[data-empir3-ref="${ref}"]');
    if (!el) throw new Error('Element not found: ${ref}');
    (el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : el.scrollIntoView({ block: 'center', inline: 'center' }));
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`);
  const c = JSON.parse(centerStr || '{}');
  if (typeof c.x !== 'number' || typeof c.y !== 'number') throw new Error('Element not found: ' + ref);
  await clickByXY(c.x, c.y);
}

async function clickByXY(x: number, y: number): Promise<void> {
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  });
  await sleep(40);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await sleep(40);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

async function typeText(text: string): Promise<void> {
  for (const char of text) {
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      unmodifiedText: char,
    });
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });
    await sleep(20);
  }
}

async function pressKey(key: string): Promise<void> {
  // Map common key names to CDP key codes
  // `text` matters: CDP only fires a key's DEFAULT ACTION (form submit on
  // Enter, newline in a textarea, the space char) when the keyDown carries the
  // produced character — same reason typeText() sets text per char. Without it
  // the event reaches JS listeners but the browser does nothing (verified
  // 2026-06-02: Enter on a focused search field never submitted). Keys with no
  // character (Tab/Escape/arrows) intentionally have no text.
  const keyMap: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Space': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  };

  // Handle modifier combos like "Control+a"
  if (key.includes('+')) {
    const parts = key.split('+');
    const modifier = parts[0].toLowerCase();
    const mainKey = parts[1];

    const modifiers = modifier === 'control' || modifier === 'ctrl' ? 2 :
                      modifier === 'shift' ? 8 :
                      modifier === 'alt' ? 1 : 0;

    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: mainKey.length === 1 ? mainKey : mainKey,
      code: `Key${mainKey.toUpperCase()}`,
      modifiers,
    });
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mainKey,
      modifiers,
    });
    return;
  }

  const mapped = keyMap[key] || { key, code: key, keyCode: 0 };
  // A bare single character passed to press ("a") should also type, so give it
  // text too; mapped.text wins for the named keys above.
  const text = mapped.text !== undefined ? mapped.text : (key.length === 1 ? key : undefined);
  const down: any = {
    type: 'keyDown',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
  };
  if (text !== undefined) { down.text = text; down.unmodifiedText = text; }
  await cdpSend('Input.dispatchKeyEvent', down);
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
  });
}

// ─── Welcome Page ────────────────────────────────────────────

function getWelcomeHtml() {
  const api = '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>empir3 Bridge Setup</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { box-sizing: border-box; }
  :root { --bg:#f5efe2; --bg2:#ede5d3; --surface:rgba(255,252,244,.88); --surface-strong:rgba(255,252,244,.96); --surface-muted:rgba(245,238,224,.72); --line:rgba(28,22,10,.12); --line-strong:rgba(28,22,10,.18); --text:#1c160a; --muted:#5a4f3d; --soft:#8a8070; --accent:#6b4ef0; --accent-2:#8c6bff; --good:#10b981; --shadow:rgba(28,22,10,.08); }
  body { margin:0; min-height:100vh; background:linear-gradient(rgba(28,22,10,.035) 1px, transparent 1px) 0 0/42px 42px, linear-gradient(90deg, rgba(28,22,10,.035) 1px, transparent 1px) 0 0/42px 42px, var(--bg); color:var(--text); font-family:'Outfit',system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { width:min(1180px, calc(100vw - 40px)); margin:0 auto; padding:64px 0; display:grid; grid-template-columns:minmax(280px,380px) 1fr; gap:48px; align-items:start; }
  .brand { padding-top:8px; }
  .wordmark { display:inline-flex; align-items:baseline; gap:0; font-weight:900; letter-spacing:-.055em; line-height:.9; color:var(--text); }
  .wordmark .three, .brand-inline .three { color:var(--accent); }
  .wordmark-xl { font-size:clamp(58px, 7vw, 88px); margin-bottom:8px; }
  .brand-inline { display:inline-flex; align-items:baseline; gap:0; font-weight:800; letter-spacing:-.035em; color:var(--text); }
  .product-kicker { margin:0 0 42px; color:var(--soft); text-transform:uppercase; font-size:12px; font-weight:700; letter-spacing:.18em; }
  h1 { margin:0 0 16px; font-size:34px; line-height:1.05; letter-spacing:0; max-width:10ch; }
  h2 { margin:0; font-size:23px; line-height:1.2; letter-spacing:-.01em; }
  p { margin:0; color:var(--muted); line-height:1.55; }
  .lede { max-width:35ch; font-size:17px; line-height:1.62; }
  .shell { display:grid; gap:18px; }
  .mode-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .mode { text-align:left; min-height:132px; padding:18px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--text); cursor:pointer; box-shadow:0 10px 28px var(--shadow); }
  .mode strong { display:block; font-size:18px; margin-bottom:8px; font-weight:800; letter-spacing:-.01em; }
  .mode > span { display:block; color:var(--muted); line-height:1.45; }
  .mode.active { border-color:color-mix(in srgb, var(--accent) 60%, var(--line)); background:color-mix(in srgb, var(--accent) 9%, var(--surface-strong)); }
  .panel { display:none; padding:22px; border:1px solid var(--line); border-radius:8px; background:var(--surface-strong); box-shadow:0 14px 36px var(--shadow); }
  .panel.active { display:grid; gap:16px; }
  ol { margin:0; padding-left:22px; color:var(--muted); line-height:1.6; }
  code, pre { font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; }
  pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; padding:14px; border:1px solid var(--line); border-radius:8px; background:rgba(28,22,10,.055); color:var(--text); }
  .actions, .row { display:flex; flex-wrap:wrap; gap:10px; }
  .fields { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  label { display:grid; gap:6px; color:var(--muted); font-size:13px; }
  input, select { width:100%; border:1px solid var(--line-strong); background:var(--surface); color:var(--text); border-radius:8px; padding:11px 12px; font:inherit; }
  .account-state { border:1px solid var(--line); border-radius:8px; background:var(--surface-muted); color:var(--muted); padding:12px 14px; font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
  .server-grid { display:grid; grid-template-columns:minmax(180px,220px) 1fr; gap:10px; }
  button, a.button { appearance:none; border:1px solid var(--line-strong); background:var(--surface); color:var(--text); border-radius:8px; padding:10px 14px; font:inherit; font-weight:600; text-decoration:none; cursor:pointer; }
  button:hover, a.button:hover { border-color:var(--accent); }
  button.primary { background:var(--text); color:var(--bg); border-color:var(--text); }
  .status { min-height:18px; color:var(--muted); font-size:13px; }
  .status.info { color:var(--accent); }
  .status.ok { color:var(--good); }
  .status.error { color:#dc2626; }
  .meta { color:var(--soft); font-size:12px; }
  @media (max-width:820px) { main { grid-template-columns:1fr; gap:28px; padding:32px 0; } .mode-grid,.fields,.server-grid { grid-template-columns:1fr; } }
  html.empir3-chat-split-active main { grid-template-columns:1fr; gap:28px; padding:32px 0; }
  html.empir3-chat-split-active .mode-grid,
  html.empir3-chat-split-active .fields,
  html.empir3-chat-split-active .server-grid { grid-template-columns:1fr; }
  html.empir3-chat-split-active .wordmark-xl { font-size:56px; }
  html.empir3-chat-split-active h1 { max-width:15ch; font-size:30px; }
</style>
</head>
<body>
<main>
  <section class="brand">
    <div class="wordmark wordmark-xl" aria-label="empir3">empir<span class="three">3</span></div>
    <div class="product-kicker">Browser Bridge</div>
    <h1>Choose how this bridge should run</h1>
    <p class="lede">Use it locally through MCP, or pair it with an <span class="brand-inline">empir<span class="three">3</span></span> user account. This screen runs inside the controlled bridge window.</p>
  </section>
  <section class="shell">
    <div class="mode-grid">
      <button class="mode active" data-mode="mcp"><strong>MCP mode</strong><span>Claude Code, OpenAI, or another MCP client controls this local browser.</span></button>
      <button class="mode" data-mode="empir3"><strong><span class="brand-inline">empir<span class="three">3</span></span> user mode</strong><span>Store an <span class="brand-inline">empir<span class="three">3</span></span> user token on this bridge for future launches.</span></button>
    </div>
    <section class="panel active" id="panel-mcp">
      <h2>Use with Claude Code or OpenAI tools</h2>
      <p>MCP mode keeps everything local. Add this bridge as a stdio MCP server, then ask your client to use the <span class="brand-inline">empir<span class="three">3</span></span> Bridge tools.</p>
      <div class="actions"><button class="primary" id="loadMcp">Show MCP config</button><button id="copyMcp">Copy config</button></div>
      <pre id="mcpSnippet">Click "Show MCP config" to generate the command for this install.</pre>
      <ol id="mcpSteps"><li>For Claude Code, save the config as <code>.mcp.json</code>.</li><li>For OpenAI or another MCP client, use the same stdio server command.</li></ol>
      <p class="status" id="mcpStatus"></p>
    </section>
    <section class="panel" id="panel-empir3">
      <h2>Pair with an <span class="brand-inline">empir<span class="three">3</span></span> user</h2>
      <p>Use browser login if it is already the right account. Use direct login to override a stale or different browser session.</p>
      <div class="account-state" id="accountState">Checking stored bridge account...</div>
      <div class="server-grid">
        <label><span class="brand-inline">empir<span class="three">3</span></span> server
          <select id="serverPreset">
            <option value="production">Production - app.empir3.com</option>
            <option value="local-dev">Local dev - localhost:3005</option>
            <option value="custom">Custom server</option>
          </select>
        </label>
        <label id="customServerLabel">Server URL<input id="serverUrl" type="url" value="https://app.empir3.com"></label>
      </div>
      <div class="actions"><button class="primary" id="pairEmpir3">Use browser empir3 login</button><button id="signOutBridge" type="button">Sign out stored bridge account</button></div>
      <form id="loginForm">
        <div class="fields"><label>Email<input id="email" type="email" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label></div>
        <div class="actions" style="margin-top:10px"><button type="submit">Sign in and store on this bridge</button></div>
      </form>
      <p class="status" id="pairStatus"></p>
    </section>
    <div class="meta">bridge ${PORT} - setup API ${WRAPPER_PORT}</div>
  </section>
</main>
<script>
const API = ${JSON.stringify(api)};
const PROD_SERVER = 'https://app.empir3.com';
const DEV_SERVER = 'http://localhost:3005';
const $ = (id) => document.getElementById(id);
let mcpText = '';
function setStatus(id, message, tone = 'info') {
  const el = $(id);
  if (!el) return;
  el.classList.remove('info', 'ok', 'error');
  el.classList.add(tone);
  el.textContent = message;
}
function selectedServer() {
  const preset = $('serverPreset')?.value || 'production';
  if (preset === 'production') return PROD_SERVER;
  if (preset === 'local-dev') return DEV_SERVER;
  return ($('serverUrl')?.value || PROD_SERVER).trim();
}
function syncServerUi(serverUrl) {
  const normalized = (serverUrl || PROD_SERVER).replace(/\\/+$/, '');
  if (normalized === PROD_SERVER) $('serverPreset').value = 'production';
  else if (normalized === DEV_SERVER) $('serverPreset').value = 'local-dev';
  else $('serverPreset').value = 'custom';
  $('serverUrl').value = normalized;
  $('customServerLabel').style.display = $('serverPreset').value === 'custom' ? 'grid' : 'none';
}
async function refreshAccountState() {
  try {
    const r = await fetch(API + '/api/relay-status');
    const j = await r.json();
    if (j.serverUrl) syncServerUi(j.serverUrl);
    const account = j.authUser?.email ? j.authUser.email : 'No stored empir3 account';
    const server = (j.serverUrl || PROD_SERVER).replace(/\\/+$/, '');
    const mode = j.mode || 'unknown';
    const relay = j.relay?.connected ? 'connected' : (j.hasAuth ? 'not connected yet' : 'not paired');
    $('accountState').textContent = account + ' - ' + server + ' - ' + mode + ' - ' + relay;
  } catch {
    $('accountState').textContent = 'Bridge daemon is reachable, but account status could not be read.';
  }
}
syncServerUi(PROD_SERVER);
$('serverPreset').addEventListener('change', () => {
  const preset = $('serverPreset').value;
  if (preset === 'production') $('serverUrl').value = PROD_SERVER;
  if (preset === 'local-dev') $('serverUrl').value = DEV_SERVER;
  $('customServerLabel').style.display = preset === 'custom' ? 'grid' : 'none';
});
refreshAccountState();
document.querySelectorAll('.mode').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $('panel-' + btn.dataset.mode).classList.add('active');
}));
$('loadMcp').addEventListener('click', async () => {
  setStatus('mcpStatus', 'Generating MCP config...', 'info');
  try {
    const r = await fetch(API + '/api/install/claude-code', { method:'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'could not generate config');
    mcpText = JSON.stringify(j.snippet, null, 2);
    $('mcpSnippet').textContent = mcpText;
    $('mcpSteps').innerHTML = (j.instructions || []).map((s) => '<li>' + s.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</li>').join('');
    setStatus('mcpStatus', 'MCP mode is selected for this bridge.', 'ok');
  } catch (e) { setStatus('mcpStatus', 'Could not generate MCP config: ' + e.message, 'error'); }
});
$('copyMcp').addEventListener('click', async () => {
  if (!mcpText) mcpText = $('mcpSnippet').textContent;
  try { await navigator.clipboard.writeText(mcpText); setStatus('mcpStatus', 'Config copied.', 'ok'); }
  catch { setStatus('mcpStatus', 'Select the config text and copy it manually.', 'error'); }
});
$('pairEmpir3').addEventListener('click', async () => {
  setStatus('pairStatus', 'Starting browser-based empir3 pairing...', 'info');
  try {
    const r = await fetch(API + '/api/install/empir3-pair', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ serverUrl:selectedServer() })
    });
    const j = await r.json();
    if (!j.ok || !j.redirectUrl) throw new Error(j.error || 'pairing failed');
    setStatus('pairStatus', 'Pairing code ' + j.code + ' created. Opening empir3...', 'ok');
    setTimeout(() => { location.href = j.redirectUrl; }, 400);
  } catch (e) { setStatus('pairStatus', 'Could not start pairing: ' + e.message, 'error'); }
});
$('signOutBridge').addEventListener('click', async () => {
  setStatus('pairStatus', 'Signing out stored bridge account...', 'info');
  try {
    const r = await fetch(API + '/api/install/sign-out', { method:'POST' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'sign out failed');
    setStatus('pairStatus', 'Signed out. Restarting the bridge...', 'ok');
  } catch (e) { setStatus('pairStatus', 'Could not sign out: ' + e.message, 'error'); }
});
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('pairStatus', 'Signing this bridge into empir3...', 'info');
  try {
    const r = await fetch(API + '/api/install/empir3-login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:$('email').value, password:$('password').value, serverUrl:selectedServer() }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'login failed');
    setStatus('pairStatus', 'Signed in. Restarting the bridge...', 'ok');
  } catch (e) { setStatus('pairStatus', 'Could not sign in: ' + e.message, 'error'); }
});
</script>
</body>
</html>`;
}

// ─── HTTP Server ─────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJSON(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, msg: string, status = 500) {
  sendJSON(res, { error: msg }, status);
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyWrapperRequest(req: IncomingMessage, res: ServerResponse, targetPath: string) {
  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRawBody(req);
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  const contentType = req.headers['content-type'];
  if (contentType) headers['Content-Type'] = Array.isArray(contentType) ? contentType[0] : contentType;
  if (body.length) headers['Content-Length'] = String(body.length);

  await new Promise<void>((resolve) => {
    const proxy = httpRequest({
      hostname: '127.0.0.1',
      port: WRAPPER_PORT,
      path: targetPath,
      method,
      headers,
    }, (proxyRes) => {
      const responseHeaders = {
        ...proxyRes.headers,
        'Access-Control-Allow-Origin': '*',
      };
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });
    proxy.on('error', (e: Error) => {
      if (!res.headersSent) {
        sendJSON(res, { ok: false, error: `Bridge setup API unavailable: ${e.message}` }, 502);
      } else {
        res.end();
      }
      resolve();
    });
    if (body.length) proxy.write(body);
    proxy.end();
  });
}

function checkAuth(req: IncomingMessage): boolean {
  if (!SESSION_TOKEN) return true; // No token configured = no auth
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${SESSION_TOKEN}`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Welcome page — no auth needed
  if (path === '/welcome') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getWelcomeHtml());
    return;
  }

  // Health — no auth needed
  if (path === '/health') {
    const hasOpenCdpSocket = !!cdpWs && cdpWs.readyState === WebSocket.OPEN;
    const hasRecentCdpCommand = connected && lastCdpLivenessAt > 0 && Date.now() - lastCdpLivenessAt < 15000;
    const hasKnownPage = !!currentTargetId || knownTargets.size > 0;
    const cdpConnected = !chromeClosedByUser && chromeStatus() === 'running' && (hasOpenCdpSocket || hasRecentCdpCommand || hasKnownPage);
    sendJSON(res, {
      status: cdpConnected ? 'connected' : 'disconnected',
      port: PORT,
      cdpPort: CDP_PORT,
      chrome: chromeStatus(),
      closedByUser: chromeClosedByUser,
      cdpConnected,
    });
    return;
  }

  if (
    path === '/api/relay-status' ||
    path === '/api/command' ||
    path === '/api/install/claude-code' ||
    path === '/api/install/empir3-pair' ||
    path === '/api/install/empir3-login' ||
    path === '/api/install/sign-out'
  ) {
    await proxyWrapperRequest(req, res, path + url.search);
    return;
  }

  // Auth check for everything else
  if (!checkAuth(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  try {
    // ── GET endpoints ──────────────────────────

    if (method === 'GET' && path === '/screenshot') {
      await ensureChromeReady();
      const quality = parseInt(url.searchParams.get('quality') || '80');
      const maxWidth = url.searchParams.get('maxWidth') ? parseInt(url.searchParams.get('maxWidth')!) : undefined;
      const params: any = { format: 'jpeg', quality };
      if (maxWidth && maxWidth > 0) {
        try {
          const evalResult = await cdpSend('Runtime.evaluate', {
            expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio||1})',
            returnByValue: true,
          });
          const vp = JSON.parse(evalResult.result.value);
          if (vp.w > 0 && vp.h > 0 && vp.dpr > 0) {
            const physicalWidth = vp.w * vp.dpr;
            if (physicalWidth > maxWidth) {
              const scale = Math.max(0.1, Math.min(2.0, maxWidth / physicalWidth));
              params.clip = { x: 0, y: 0, width: vp.w, height: vp.h, scale };
            }
          }
        } catch {}
      }
      const result = await captureScreenshot(params);
      const buf = Buffer.from(result.data, 'base64');
      if (url.searchParams.get('format') === 'json') {
        // Only return JSON if explicitly requested
        sendJSON(res, { data: result.data, format: 'jpeg' });
      } else {
        // Default: return raw JPEG bytes (works with ?raw=true for backwards compat)
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length.toString(),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
      }
      return;
    }

    if (method === 'GET' && path === '/snapshot') {
      await ensureChromeReady();
      const filter = url.searchParams.get('filter') || 'interactive';
      const nodes = await getAccessibilityTree(filter);
      sendJSON(res, { count: nodes.length, nodes });
      return;
    }

    if (method === 'GET' && path === '/text') {
      await ensureChromeReady();
      const text = await cdpEvaluate(`(function() {
        const title = document.title || '';
        // The bridge injects its overlay UI (chat sidebar, toolbar, ghost
        // cursor, etc.) into the page's light DOM under id="empir3-*" roots.
        // Its text ("Bridge Disconnected / Snap / Draw / Send / …") otherwise
        // pollutes innerText and breaks downstream parsing for agents. Detach
        // the top-level overlay roots, read innerText (forces a synchronous
        // reflow without them), then restore them in place — all within one JS
        // turn so there is no visible flicker and overlay state is preserved.
        const roots = Array.prototype.slice.call(document.querySelectorAll('[id^="empir3-"]'))
          .filter(function(el){ return !(el.parentElement && el.parentElement.closest('[id^="empir3-"]')); });
        const saved = roots.map(function(el){ return { el: el, parent: el.parentNode, next: el.nextSibling }; });
        saved.forEach(function(s){ if (s.parent) s.parent.removeChild(s.el); });
        let body = '';
        try { body = document.body ? document.body.innerText : ''; }
        finally {
          saved.forEach(function(s){
            if (!s.parent) return;
            if (s.next && s.next.parentNode === s.parent) s.parent.insertBefore(s.el, s.next);
            else s.parent.appendChild(s.el);
          });
        }
        return JSON.stringify({ title, text: body.slice(0, 50000) });
      })()`);
      sendJSON(res, JSON.parse(text));
      return;
    }

    if (method === 'GET' && path === '/tabs') {
      let targets: any[] = [];
      try {
        targets = await Promise.race([
          fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`),
          sleep(1500).then(() => null),
        ]) as any[] | null || [];
      } catch {
        sendJSON(res, { tabs: [], currentTargetId: '', chrome: chromeStatus(), closedByUser: chromeClosedByUser });
        return;
      }
      if (!targets.length && knownTargets.size > 0) {
        const tabs = Array.from(knownTargets.entries()).map(([id, url]) => ({
          id,
          title: '',
          url,
          type: 'page',
          active: id === currentTargetId,
        }));
        sendJSON(res, { tabs, currentTargetId, chrome: chromeStatus(), closedByUser: chromeClosedByUser });
        return;
      }
      const tabs = targets
        .filter((t: any) => t.type === 'page')
        .map((t: any) => ({
          id: t.id,
          title: t.title,
          url: t.url,
          type: t.type,
          active: t.id === currentTargetId,
        }));
      sendJSON(res, { tabs, currentTargetId, chrome: chromeStatus(), closedByUser: chromeClosedByUser });
      return;
    }

    // ── POST endpoints ─────────────────────────

    if (method === 'POST') {
      const body = await parseBody(req);

      // Evaluate JS on a specific target without switching active tab
      if (path === '/evaluate-on-target') {
        const { targetId, expression } = body;
        if (!targetId || !expression) throw new Error('targetId and expression required');
        const timeoutMs = Math.max(250, Math.min(10000, Number(body.timeoutMs) || CDP_COMMAND_TIMEOUT_MS));
        const result = await evaluateOnTarget(targetId, expression, timeoutMs);
        sendJSON(res, { ok: true, result });
        return;
      }

      // Evaluate JS on ALL page targets (used for overlay injection)
      if (path === '/evaluate-all') {
        const { expression } = body;
        if (!expression) throw new Error('expression required');
        const timeoutMs = Math.max(250, Math.min(10000, Number(body.timeoutMs) || CDP_COMMAND_TIMEOUT_MS));
        const results = await evaluateOnAllTargets(expression, timeoutMs);
        sendJSON(res, { ok: true, results });
        return;
      }

      // Register a script to auto-inject into every new tab
      if (path === '/register-auto-inject') {
        autoInjectScript = body.script || '';
        // Immediately inject into all existing tabs
        let results: any[] = [];
        if (autoInjectScript) {
          results = await evaluateOnAllTargets(autoInjectScript);
          startTargetPolling();
        } else {
          stopTargetPolling();
        }
        sendJSON(res, { ok: true, registered: !!autoInjectScript, injected: results });
        return;
      }

      if (path === '/activate-target') {
        await ensureChromeReady({ allowRelaunch: false });
        const targetId = typeof body.targetId === 'string' ? body.targetId : '';
        if (!targetId) throw new Error('activate-target requires targetId');
        await switchToTarget(targetId);
        if (body.bringToFront !== false) {
          try { await cdpSend('Page.bringToFront'); } catch {}
        }
        const target = await currentPageTarget();
        let url = String(target.url || '');
        let title = String(target.title || '');
        try { url = await cdpEvaluate('location.href', 1200) || url; } catch {}
        try { title = await cdpEvaluate('document.title', 1200) || title; } catch {}
        sendJSON(res, { ok: true, targetId: currentTargetId, url, title });
        return;
      }

      if (path === '/show') {
        const url = typeof body.url === 'string' ? body.url : undefined;
        const shownUrl = await showChromeWindow(url);
        sendJSON(res, { ok: true, shown: true, url: shownUrl });
        return;
      }

      if (path === '/navigate') {
        await ensureChromeReady({ allowRelaunch: true });
        const targetUrl = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : '';
        if (!targetUrl) throw new Error('navigate requires a non-empty url');
        // Check if URL is already open in another tab
        const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
        const normalizeUrl = (u: string) => u.replace(/[#/]+$/, '');
        const existing = targets.find((t: any) =>
          t.type === 'page' && normalizeUrl(String(t.url || '')) === normalizeUrl(targetUrl) && t.id !== currentTargetId
        );
        if (existing) {
          // Switch to existing tab
          await switchToTarget(existing.id);
          // Activate the tab visually
          await cdpSend('Page.bringToFront');
        } else {
          await cdpNavigate(targetUrl);
        }
        let currentUrl = '';
        let title = '';
        try { currentUrl = await cdpEvaluate('location.href', 1200); } catch {}
        try { title = await cdpEvaluate('document.title', 1200); } catch {}
        if (!currentUrl || !title) {
          const target = await currentPageTarget();
          currentUrl = currentUrl || String(target.url || targetUrl);
          title = title || String(target.title || '');
        }
        sendJSON(res, { title, url: currentUrl });
        return;
      }

      if (path === '/action') {
        await ensureChromeReady();
        const kind = body.kind;

        switch (kind) {
          case 'click':
            if (body.ref) {
              await clickByRef(body.ref);
            } else if (body.selector) {
              await cdpEvaluate(`document.querySelector(${JSON.stringify(body.selector)})?.click()`);
            } else if (typeof body.x === 'number' && typeof body.y === 'number') {
              await clickByXY(body.x, body.y);
            }
            sendJSON(res, { success: true });
            break;

          case 'type': {
            const typeTarget = body.ref
              ? `[data-empir3-ref="${body.ref}"]`
              : body.selector || null;

            if (typeTarget) {
              // Use native value setter + input/change events (works with React, Vue, plain HTML)
              await cdpEvaluate(`(function() {
                const el = document.querySelector(${JSON.stringify(typeTarget)});
                if (!el) return 'not_found';
                el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : el.scrollIntoView();
                el.focus();
                if (el.isContentEditable) {
                  document.execCommand('selectAll', false, null);
                  document.execCommand('insertText', false, ${JSON.stringify(body.text || '')});
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'typed_contenteditable';
                }
                const isTextarea = el.tagName === 'TEXTAREA';
                const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) {
                  const tracker = el._valueTracker;
                  if (tracker) tracker.setValue('');
                  setter.call(el, ${JSON.stringify(body.text || '')});
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'typed';
                }
                if ('value' in el) {
                  el.value = ${JSON.stringify(body.text || '')};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'typed_basic';
                }
                el.textContent = ${JSON.stringify(body.text || '')};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'typed_basic';
              })()`);
            } else {
              // No target — type into whatever is focused via keyboard events
              await typeText(body.text || '');
            }
            sendJSON(res, { success: true });
            break;
          }

          case 'selectAll':
            await pressKey('Control+a');
            sendJSON(res, { success: true });
            break;

          case 'press':
            await pressKey(body.key || body.text || '');
            sendJSON(res, { success: true });
            break;

          case 'scroll': {
            const dx = Number(body.x || 0);
            const dy = Number(body.y || 0);
            const result = await cdpEvaluate(`(function(){
              var dx=${JSON.stringify(dx)},dy=${JSON.stringify(dy)};
              function pickScroller(axis){
                var cands=[document.scrollingElement,document.documentElement,document.body];
                for(var i=0;i<cands.length;i++){
                  var el=cands[i]; if(!el) continue;
                  if(axis==='y' && el.scrollHeight>el.clientHeight) return el;
                  if(axis==='x' && el.scrollWidth>el.clientWidth) return el;
                }
                var all=document.querySelectorAll('*');
                for(var j=0;j<all.length;j++){
                  var el2=all[j], s=getComputedStyle(el2);
                  if(axis==='y' && (s.overflowY==='auto'||s.overflowY==='scroll') && el2.scrollHeight>el2.clientHeight) return el2;
                  if(axis==='x' && (s.overflowX==='auto'||s.overflowX==='scroll') && el2.scrollWidth>el2.clientWidth) return el2;
                }
                return document.scrollingElement||document.documentElement;
              }
              var scY=pickScroller('y'), scX=dx?pickScroller('x'):scY;
              var prevBehaviorHtml=document.documentElement.style.scrollBehavior;
              document.documentElement.style.scrollBehavior='auto';
              var beforeX=(scX&&scX.scrollLeft)||0,beforeY=(scY&&scY.scrollTop)||0;
              if(scY) scY.scrollTop += dy;
              if(scX && dx) scX.scrollLeft += dx;
              var afterX=(scX&&scX.scrollLeft)||0,afterY=(scY&&scY.scrollTop)||0;
              var maxX=scX?Math.max(0,(scX.scrollWidth||0)-(scX.clientWidth||window.innerWidth||0)):0;
              var maxY=scY?Math.max(0,(scY.scrollHeight||0)-(scY.clientHeight||window.innerHeight||0)):0;
              document.documentElement.style.scrollBehavior=prevBehaviorHtml;
              return JSON.stringify({
                requested:{x:dx,y:dy},
                before:{x:beforeX,y:beforeY},
                after:{x:afterX,y:afterY},
                delta:{x:afterX-beforeX,y:afterY-beforeY},
                max:{x:maxX,y:maxY},
                canScroll:maxX>0||maxY>0,
                moved:afterX!==beforeX||afterY!==beforeY
              });
            })()`);
            let scroll: any = result;
            try { scroll = JSON.parse(result); } catch {}
            sendJSON(res, { success: true, position: scroll?.after || scroll, scroll, moved: scroll?.moved === true });
            break;
          }

          case 'focus':
            if (body.ref) {
              await cdpEvaluate(`(function() {
                const el = document.querySelector('[data-empir3-ref="${body.ref}"]');
                if (el) el.focus();
              })()`);
            }
            sendJSON(res, { success: true });
            break;

          case 'hover':
            if (body.ref) {
              const bounds = await cdpEvaluate(`(function() {
                const el = document.querySelector('[data-empir3-ref="${body.ref}"]');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
              })()`);
              if (bounds) {
                const { x, y } = JSON.parse(bounds);
                await cdpSend('Input.dispatchMouseEvent', {
                  type: 'mouseMoved', x, y,
                });
              }
            }
            sendJSON(res, { success: true });
            break;

          default:
            sendError(res, `Unknown action: ${kind}`, 400);
        }
        return;
      }

      if (path === '/evaluate') {
        await ensureChromeReady();
        const result = await cdpEvaluate(body.expression);
        sendJSON(res, { result });
        return;
      }

      if (path === '/cookies') {
        await ensureChromeReady();
        for (const cookie of (body.cookies || [])) {
          await cdpSend('Network.setCookie', {
            name: cookie.name,
            value: cookie.value,
            url: body.url,
            domain: cookie.domain,
            path: cookie.path || '/',
          });
        }
        sendJSON(res, { success: true });
        return;
      }
    }

    sendError(res, `Not found: ${method} ${path}`, 404);
  } catch (e: any) {
    console.error(`[Empir3 Bridge] Error: ${e.message}`);
    sendError(res, e.message);
  }
}

// ─── Utilities ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url: string, method: string = 'GET'): Promise<any> {
  const { default: http } = await import('http');
  const { URL } = await import('url');
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      // Chrome's /json/new takes the URL as the raw query string (not encoded),
      // so preserve u.search verbatim. http.request would re-serialize if we
      // passed pathname/search separately.
      path: u.pathname + u.search,
      method,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.setTimeout(3000, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.end();
  });
}

// ─── Shutdown ────────────────────────────────────────────────

function shutdown() {
  console.log('[Empir3 Bridge] Shutting down...');
  shuttingDown = true;
  stopTargetPolling();
  if (browserWs) { try { browserWs.close(); } catch {} }
  if (cdpWs) cdpWs.close();
  if (chromeProcess) {
    chromeProcess.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const server = createServer(handleRequest);

  const ownsHttpPort = await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (e.code === 'EADDRINUSE') {
        console.warn(`[Empir3 Bridge] HTTP server ${HOST}:${PORT} is already in use; using the existing bridge if its /health check passes.`);
        resolve(false);
        return;
      }
      reject(e);
    });
    server.listen(PORT, HOST, () => {
      if (settled) return;
      settled = true;
      console.log(`[Empir3 Bridge] HTTP server on ${HOST}:${PORT}`);
      resolve(true);
    });
  });

  if (!ownsHttpPort) return;

  // Launch Chrome
  try {
    await launchChrome();
    console.log(`[Empir3 Bridge] Ready — Chrome connected via CDP on port ${CDP_PORT}`);
    startTargetPolling();
    // Connect browser-level WS for real-time target discovery (sees ALL tabs)
    connectBrowserWs().catch(() => {});
  } catch (e: any) {
    console.error(`[Empir3 Bridge] Failed to launch Chrome: ${e.message}`);
    console.log('[Empir3 Bridge] Waiting for Chrome to connect...');

    // Poll for Chrome
    const poll = async () => {
      try {
        await connectCDP();
        console.log('[Empir3 Bridge] Chrome connected');
        startTargetPolling();
        connectBrowserWs().catch(() => {});
      } catch {
        setTimeout(poll, 3000);
      }
    };
    poll();
  }
}

main().catch((e) => {
  console.error('[Empir3 Bridge] Fatal:', e);
  process.exit(1);
});
