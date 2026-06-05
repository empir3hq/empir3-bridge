import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const PAYLOAD_DIR = process.env.EMPIR3_BRIDGE_PAYLOAD_DIR || __dirname;
const BRIDGE_BUNDLE = join(PAYLOAD_DIR, 'bundle-bridge.js');
const SERVER_BUNDLE = join(PAYLOAD_DIR, 'bundle-server.js');

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
  process.env.EMPIR3_BRIDGE_PORT = String(bridgePort);
  process.env.BRIDGE_PORT = String(bridgePort);
  process.env.PW_PORT = String(wrapperPort);
  const nonce = ensureBridgeNonce();

  console.log(`[empir3-bridge] starting payload runtime v${process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || 'dev'} nonce=${nonce.slice(0, 6)}...`);
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
