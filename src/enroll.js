/**
 * enroll — Fleet Phase 8 bulk enrollment (the client half of bridge 0.3.45).
 *
 * Interactive pairing is one browser-claimed code per machine; this is the
 * zero-touch path for 40 boxes: a machine boots with an ENROLL token (from a
 * golden image / Ansible / cloud-init / GPO), redeems it once at
 * POST /api/auth/pairing-sessions/enroll, and receives a DEVICE-SCOPED token
 * (audience = this one machine, relay-only, independently revocable) instead
 * of the user-scoped account token.
 *
 * Resolution chain (first hit wins):
 *   1. --enroll-token <tok>            (argv — one-shot by nature)
 *   2. EMPIR3_ENROLL_TOKEN             (env — systemd EnvironmentFile etc.)
 *   3. /etc/empir3/enroll.json         (root-owned 0600; Ansible/cloud-init)
 *   4. <settings>/bridge-enroll.json   (per-user; GPO-deployable on Windows)
 *
 * File shape: { "enrollToken": "e3en_…", "serverUrl"?: "https://…" }
 *
 * The enroll token is a BEARER credential: after a successful enrollment the
 * file sources are BURNED (best-effort delete) so the one-shot secret does
 * not linger on disk — the durable credential from then on is the
 * device-scoped token in bridge-auth.json.
 *
 * Pure CJS (platform-profile/sync-limits pattern): requireable from the TS
 * daemon, headless-entry.js, and the .mjs tests without a loader. Writes
 * bridge-auth.json in the exact shape server.ts reads (deviceToken field —
 * see server.ts BridgeAuth) using the same 0600-in-0700 discipline as
 * pair-claim.ts.
 */

'use strict';

const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } = require('fs');
const { homedir, hostname } = require('os');
const { join } = require('path');
const { request: httpRequest } = require('http');
const { request: httpsRequest } = require('https');
const { normalizeServer, classifyServer, normalizeWsUrl, DEFAULT_EMPIR3_SERVER } = require('./empir3-url.js');

// Mirror server.ts: %APPDATA%\Empir3 on Windows, ~/.empir3/Empir3 elsewhere.
const SETTINGS_DIR = join(process.env.APPDATA || join(homedir(), '.empir3'), 'Empir3');
const AUTH_FILE = join(SETTINGS_DIR, 'bridge-auth.json');
const SETTINGS_FILE = join(SETTINGS_DIR, 'bridge-settings.json');
const USER_ENROLL_FILE = join(SETTINGS_DIR, 'bridge-enroll.json');
const ETC_ENROLL_FILE = '/etc/empir3/enroll.json';

const ENROLL_TOKEN_RE = /^e3en_[0-9a-f]{48}$/;

/** Resolve the enroll token + optional server override. Returns null when no
 *  source yields a plausible token — the caller falls through to interactive
 *  pairing exactly as before. */
function resolveEnrollSource(argv = process.argv, env = process.env) {
  const flagIdx = argv.indexOf('--enroll-token');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const token = String(argv[flagIdx + 1]).trim();
    if (ENROLL_TOKEN_RE.test(token)) return { token, serverUrl: env.EMPIR3_SERVER || null, source: 'argv' };
  }
  if (env.EMPIR3_ENROLL_TOKEN && ENROLL_TOKEN_RE.test(String(env.EMPIR3_ENROLL_TOKEN).trim())) {
    return { token: String(env.EMPIR3_ENROLL_TOKEN).trim(), serverUrl: env.EMPIR3_SERVER || null, source: 'env' };
  }
  for (const [file, source] of [[ETC_ENROLL_FILE, 'etc'], [USER_ENROLL_FILE, 'settings']]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      const token = String(parsed.enrollToken || '').trim();
      if (ENROLL_TOKEN_RE.test(token)) {
        return { token, serverUrl: parsed.serverUrl || env.EMPIR3_SERVER || null, source, file };
      }
    } catch { /* unreadable/garbled file → next source */ }
  }
  return null;
}

/** 0600-in-0700 write, mirroring pair-claim.ts (writeFileSync's mode is
 *  ignored for an existing file, so chmod after the write too). */
function writeAuthFileSecurely(auth) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  if (process.platform !== 'win32') {
    try { chmodSync(SETTINGS_DIR, 0o700); } catch { /* best-effort */ }
  }
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { chmodSync(AUTH_FILE, 0o600); } catch { /* best-effort */ }
  }
}

/** The bridge's persisted deviceId (bridge-settings.json), when one exists.
 *  Passing it keeps re-enrollment idempotent on a machine that already has an
 *  identity; a fresh box lets the server assign one, persisted below. */
function readSettingsDeviceId() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    return typeof parsed.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : null;
  } catch {
    return null;
  }
}

function persistSettingsDeviceId(deviceId, deviceName) {
  try {
    let settings = {};
    try { settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')); } catch { /* fresh */ }
    if (settings.deviceId === deviceId) return;
    settings.deviceId = deviceId;
    if (!settings.deviceName && deviceName) settings.deviceName = deviceName;
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { chmodSync(SETTINGS_FILE, 0o600); } catch { /* best-effort */ }
    }
  } catch { /* server.ts ensureSettingsFile will regenerate an id if this failed */ }
}

function postJson(urlStr, body, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const payload = JSON.stringify(body);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'User-Agent': 'empir3-bridge-enroll',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let chunks = '';
      response.on('data', (c) => { chunks += c; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch { /* leave null */ }
        resolvePromise({ status: response.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.write(payload);
    req.end();
  });
}

/** Burn the one-shot secret after success: delete file sources (both paths —
 *  a machine may carry the /etc file AND a stale per-user copy). Best-effort;
 *  a failed delete is logged, never fatal (the token may already be used up
 *  or revoked server-side anyway). */
function burnEnrollSources(log) {
  for (const file of [ETC_ENROLL_FILE, USER_ENROLL_FILE]) {
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        log(`burned enroll secret: ${file}`);
      }
    } catch (e) {
      log(`could not delete ${file} (${e && e.message}) — remove it manually; the token inside may still have uses left`);
    }
  }
}

/**
 * Enroll if a token source resolves. Returns:
 *   { enrolled: true, deviceId, approvalPending, authFile }  on success
 *   { enrolled: false, reason }                              otherwise
 *
 * On success bridge-auth.json carries `deviceToken` (+ mintedAt) and NO
 * user-scoped token — the caller (server.ts startup) exits 0 so the
 * supervisor relaunches the daemon with the new auth (the exact contract
 * pairing claims already use — E-039).
 */
async function enrollIfNeeded(opts = {}) {
  const log = opts.log || ((m) => console.log(`[Enroll] ${m}`));
  const source = resolveEnrollSource(opts.argv, opts.env);
  if (!source) return { enrolled: false, reason: 'no enroll token source' };

  const serverUrl = normalizeServer(source.serverUrl || DEFAULT_EMPIR3_SERVER);
  log(`enroll token found (${source.source}) → ${serverUrl}`);

  let profile = null;
  try { profile = require('./platform-profile.js').getPlatformProfile(); } catch { /* optional */ }

  let r;
  try {
    r = await postJson(`${serverUrl}/api/auth/pairing-sessions/enroll`, {
      enrollToken: source.token,
      deviceId: readSettingsDeviceId() || undefined,
      hostname: hostname(),
      platform: profile ? profile.os : process.platform,
      deviceClass: profile ? profile.deviceClass : undefined,
      agentVersion: opts.agentVersion,
    }, 15000);
  } catch (e) {
    return { enrolled: false, reason: `enroll request failed: ${e && e.message}` };
  }

  if (r.status !== 201 || !r.body || !r.body.deviceToken) {
    // The server is deliberately opaque (one generic 403) — mirror that
    // honesty here rather than guessing at a cause.
    return { enrolled: false, reason: `enrollment refused (HTTP ${r.status})` };
  }

  const sUrl = normalizeServer(r.body.serverUrl || serverUrl);
  writeAuthFileSecurely({
    deviceToken: r.body.deviceToken,
    deviceTokenMintedAt: new Date().toISOString(),
    deviceId: r.body.deviceId,
    user: { id: r.body.userId, email: r.body.email, name: r.body.name },
    serverUrl: sUrl,
    wsUrl: normalizeWsUrl(r.body.wsUrl, sUrl),
    environment: classifyServer(sUrl),
    enrolled: true,
  });
  persistSettingsDeviceId(r.body.deviceId, r.body.deviceName);
  burnEnrollSources(log);
  log(`enrolled as device ${r.body.deviceId} for ${r.body.email || r.body.userId}${r.body.approvalPending ? ' (pending operator approval — blocked until approved)' : ''}`);
  return { enrolled: true, deviceId: r.body.deviceId, approvalPending: !!r.body.approvalPending, authFile: AUTH_FILE };
}

module.exports = {
  ENROLL_TOKEN_RE,
  ETC_ENROLL_FILE,
  USER_ENROLL_FILE,
  resolveEnrollSource,
  enrollIfNeeded,
};
