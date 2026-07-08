/**
 * pair-claim.ts — redeem a PRE-AUTHORIZED Empir3 pairing code on first run.
 *
 * The standard pairing flow (server.ts `startPairPoll`) has the BRIDGE create a
 * session and the user approve it in a browser at `/connect-bridge?code=`. This
 * module is the inverse, used by the install one-liner:
 *
 *     Empir3Setup.exe --pair <code>
 *
 * In that flow the user is ALREADY logged into Empir3 (they got the install link
 * from Vincent in chat), so Empir3 pre-authorizes a pairing session for them and
 * bakes the `code` into the command. The bridge just CLAIMS it on first boot —
 * no second login, no browser round-trip.
 *
 * Deliberately self-contained:
 *   - It runs in the bootstrapper / first-run context BEFORE the daemon
 *     (server.ts) is listening. Importing server.ts would boot the whole bridge
 *     and bind ports, so this module re-implements the small slice it needs.
 *   - It writes `bridge-auth.json` in the EXACT shape and location server.ts
 *     reads (see server.ts `saveBridgeAuth` / `AUTH_FILE` / `BridgeAuth`). Keep
 *     these in sync if the auth schema changes.
 *
 * Contract with Empir3 (must match `startPairPoll` in server.ts):
 *   GET <server>/api/auth/pairing-sessions/<code>
 *     200 { status: 'pending' }                         → keep polling
 *     200 { status: 'claimed', token, userId, email,
 *           name, role, channelId, serverUrl, wsUrl }   → write auth, done
 *     404                                                → expired / unknown code
 *
 * Never hangs the install: bounded poll, then a graceful give-up so first-run
 * falls through to the normal (interactive) pairing path.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

const DEFAULT_EMPIR3_SERVER = 'https://app.empir3.com';
const LOCAL_DEV_EMPIR3_SERVER = 'http://localhost:3005';

// Mirror server.ts: %APPDATA%\Empir3 on Windows, ~/.empir3/Empir3 elsewhere.
const SETTINGS_DIR = join(process.env.APPDATA || join(homedir(), '.empir3'), 'Empir3');
const AUTH_FILE = join(SETTINGS_DIR, 'bridge-auth.json');

export interface ClaimResult {
  ok: boolean;
  status: 'claimed' | 'expired' | 'timed_out' | 'invalid' | 'error';
  reason?: string;
  user?: { id?: string; email?: string };
  authFile?: string;
}

type ClaimOptions = {
  serverUrl?: string;
  tries?: number;
  intervalMs?: number;
  log?: (msg: string) => void;
};

// ─── server-url helpers (minimal mirror of server.ts) ───────────────────────

function normalizeServer(input?: string | null): string {
  const raw = String(input || '').trim();
  if (!raw) return DEFAULT_EMPIR3_SERVER;
  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw
    : (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);
  try {
    const u = new URL(withProtocol);
    u.pathname = u.pathname.replace(/\/+$/, '');
    if (u.pathname === '/') u.pathname = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_EMPIR3_SERVER;
  }
}

function classifyServer(serverUrl?: string | null): 'production' | 'local-dev' | 'custom' {
  const normalized = normalizeServer(serverUrl);
  let host = '';
  try { host = new URL(normalized).host.toLowerCase(); } catch { /* keep '' */ }
  if (normalized === DEFAULT_EMPIR3_SERVER || host === 'app.empir3.com') return 'production';
  if (normalized === LOCAL_DEV_EMPIR3_SERVER || host === 'localhost:3005' || host === '127.0.0.1:3005') return 'local-dev';
  return 'custom';
}

function defaultWsUrl(serverUrl: string): string {
  try {
    const u = new URL(normalizeServer(serverUrl));
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.pathname = '/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'wss://app.empir3.com/ws';
  }
}

function normalizeWsUrl(wsUrl: string | undefined | null, serverUrl: string): string {
  const fallback = defaultWsUrl(serverUrl);
  if (!wsUrl) return fallback;
  try {
    const u = new URL(wsUrl);
    if (u.pathname.replace(/\/+$/, '') === '/relay') return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

function getJson(urlStr: string, timeoutMs: number): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    let u: URL;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { 'User-Agent': 'empir3-bridge-pair', Accept: 'application/json' },
    }, (response) => {
      let chunks = '';
      response.on('data', (c) => { chunks += c; });
      response.on('end', () => {
        let parsed: any = null;
        try { parsed = JSON.parse(chunks); } catch { /* leave null */ }
        resolvePromise({ status: response.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pairing code is opaque but should look sane before we put it in a URL. */
function looksLikeCode(code: string): boolean {
  return /^[A-Za-z0-9._-]{6,128}$/.test(code);
}

/**
 * Claim a pre-authorized pairing code and persist bridge-auth.json.
 *
 * Bounded: at most `tries` polls (default 10) spaced `intervalMs` (default
 * 1500ms) apart — ~15s worst case. A pre-authorized session normally returns
 * `claimed` on the first poll; the loop only exists to absorb a brief
 * server-side propagation delay. Returns a structured result; never throws for
 * an expected outcome (expired / timeout / bad code).
 */
export async function claimPairingCode(code: string, opts: ClaimOptions = {}): Promise<ClaimResult> {
  const log = opts.log || (() => {});
  const trimmed = String(code || '').trim();
  if (!looksLikeCode(trimmed)) {
    return { ok: false, status: 'invalid', reason: 'pairing code missing or malformed' };
  }

  const serverUrl = normalizeServer(opts.serverUrl || process.env.EMPIR3_SERVER || DEFAULT_EMPIR3_SERVER);
  const tries = Math.max(1, opts.tries ?? 10);
  const intervalMs = Math.max(250, opts.intervalMs ?? 1500);
  const sessionUrl = `${serverUrl}/api/auth/pairing-sessions/${encodeURIComponent(trimmed)}`;

  let lastReason = 'no response';
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await getJson(sessionUrl, 5000);

      if (r.status === 404) {
        log(`pairing code expired or unknown (404) after ${attempt} attempt(s)`);
        return { ok: false, status: 'expired', reason: 'code expired or unknown' };
      }

      const status = r.body?.status;

      if (status === 'claimed' && r.body?.token) {
        const sUrl = normalizeServer(r.body.serverUrl || serverUrl);
        const auth = {
          legacyToken: r.body.token as string,
          user: {
            id: r.body.userId,
            email: r.body.email,
            name: r.body.name,
            role: r.body.role,
          },
          channelId: r.body.channelId || null,
          serverUrl: sUrl,
          wsUrl: normalizeWsUrl(r.body.wsUrl || r.body.relayUrl, sUrl),
          environment: classifyServer(sUrl),
        };
        mkdirSync(SETTINGS_DIR, { recursive: true });
        writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
        log(`paired as ${auth.user.email || auth.user.id || 'unknown user'} → ${AUTH_FILE}`);
        return { ok: true, status: 'claimed', user: { id: auth.user.id, email: auth.user.email }, authFile: AUTH_FILE };
      }

      if (status === 'pending') {
        lastReason = 'session still pending authorization';
      } else {
        lastReason = r.body?.error || `unexpected response (HTTP ${r.status}${status ? `, status=${status}` : ''})`;
      }
      log(`attempt ${attempt}/${tries}: ${lastReason}`);
    } catch (e: any) {
      lastReason = e?.message || String(e);
      log(`attempt ${attempt}/${tries} errored: ${lastReason}`);
    }

    if (attempt < tries) await sleep(intervalMs);
  }

  return { ok: false, status: 'timed_out', reason: lastReason };
}
