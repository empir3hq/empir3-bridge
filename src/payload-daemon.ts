import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const PAYLOAD_DIR = process.env.EMPIR3_BRIDGE_PAYLOAD_DIR || __dirname;
const BRIDGE_BUNDLE = join(PAYLOAD_DIR, 'bundle-bridge.js');
const SERVER_BUNDLE = join(PAYLOAD_DIR, 'bundle-server.js');

// ── Single-instance guard ───────────────────────────────────────────
// This daemon binds the bridge + wrapper ports in-process. Only ONE bridge
// can own them, so any predecessor still holding a port must be reaped before
// we bind — otherwise a second daemon launched while a stale/wedged one is
// still up collides (EADDRINUSE, zombie Chrome, "CDP direct timeout"). A new
// daemon launch always means "replace whatever is there", so we reap then bind.
// (Callers only launch a fresh daemon when they want one — the MCP server
// reuses a daemon that already answers /api/status instead of relaunching.)

/** PIDs LISTENING on a TCP port (Windows). */
function listenerPids(port: number): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf-8' });
    const pids = new Set<number>();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // Proto  LocalAddress  ForeignAddress  State  PID
      if (parts.length >= 5 && /^LISTENING$/i.test(parts[3]) && parts[1].endsWith(`:${port}`)) {
        const pid = Number(parts[4]);
        if (pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** Image name for a PID (e.g. "node.exe"), lowercased. */
function processName(pid: number): string {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' });
    const m = out.match(/^"([^"]+)"/);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function killPid(pid: number): void {
  try { execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' }); } catch {}
}

/**
 * Reap any predecessor bridge holding our ports so we can bind a fresh one.
 * Only kills node.exe (a bridge daemon) and chrome.exe (its driven Chrome) —
 * never an unrelated app that merely happens to use the port.
 */
function reapPredecessors(bridgePort: number, wrapperPort: number, cdpPort: number): void {
  if (process.platform !== 'win32') return;
  const pids = new Set<number>([
    ...listenerPids(bridgePort),
    ...listenerPids(wrapperPort),
    ...listenerPids(cdpPort),
  ]);
  pids.delete(process.pid);
  let reaped = 0;
  for (const pid of pids) {
    const name = processName(pid);
    if (name === 'node.exe' || name === 'chrome.exe') {
      console.log(`[empir3-bridge] reaping predecessor ${name} PID ${pid} (held bridge port)`);
      killPid(pid);
      reaped++;
    } else if (name) {
      console.log(`[empir3-bridge] port held by ${name} PID ${pid} — leaving it alone`);
    }
  }
  if (reaped > 0) {
    // Give the OS a moment to release the ports (TIME_WAIT) before we bind.
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* brief spin so binding doesn't race the kill */ }
  }
}

function ensureBridgeNonce(): string {
  const nonce = process.env.EMPIR3_BRIDGE_NONCE || randomBytes(8).toString('hex');
  process.env.EMPIR3_BRIDGE_NONCE = nonce;

  try {
    const dir = join(homedir(), '.empir3-bridge');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nonce'), nonce, 'utf-8');
  } catch (e: any) {
    console.warn(`[empir3-bridge] failed to write bridge nonce: ${e?.message || e}`);
  }

  return nonce;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  url: string,
  label: string,
  maxWaitMs: number,
  isReady: (body: any) => boolean = () => true,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        if (isReady(body)) return;
      }
    } catch {}
    await wait(500);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function loadBundle(script: string, label: string): void {
  if (!existsSync(script)) {
    throw new Error(`Missing ${label} bundle: ${script}`);
  }
  console.log(`[empir3-bridge] loading ${label}: ${script}`);
  require(script);
}

export async function start() {
  const bridgePort = Number(process.env.EMPIR3_BRIDGE_PORT || process.env.EMPIR3_BRIDGE_HTTP_PORT || 9867);
  const wrapperPort = Number(process.env.EMPIR3_PW_PORT || process.env.PW_PORT || 3006);
  const cdpPort = Number(process.env.CDP_PORT || 9222);
  process.env.EMPIR3_BRIDGE_PORT = String(bridgePort);
  process.env.BRIDGE_PORT = String(bridgePort);
  process.env.PW_PORT = String(wrapperPort);
  const nonce = ensureBridgeNonce();

  console.log(`[empir3-bridge] starting payload runtime v${process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || 'dev'} nonce=${nonce.slice(0, 6)}...`);

  // Replace any stale/wedged predecessor holding our ports before we bind.
  reapPredecessors(bridgePort, wrapperPort, cdpPort);

  loadBundle(BRIDGE_BUNDLE, 'cdp bridge');
  await waitFor(
    `http://127.0.0.1:${bridgePort}/health`,
    'CDP bridge HTTP server',
    30_000,
    (body) => body?.port === bridgePort && typeof body?.status === 'string',
  );

  loadBundle(SERVER_BUNDLE, 'http wrapper');
  await waitFor(`http://127.0.0.1:${wrapperPort}/api/status`, 'HTTP wrapper', 30_000);

  await new Promise<void>(() => {});
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[empir3-bridge] payload runtime failed:', e?.stack || e?.message || e);
    process.exit(1);
  });
}
