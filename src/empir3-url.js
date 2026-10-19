/**
 * empir3-url — the ONE place server / ws URL normalization lives.
 *
 * Extracted (Phase 8) from the duplicated copies in `pair-claim.ts` and
 * `server.ts`, which had already been hand-synced once with a "keep these in
 * sync" comment — the third consumer (enroll.js) is why the extraction
 * happened now instead of a third copy.
 *
 * Pure CJS like platform-profile/sync-limits so it loads identically from the
 * TS daemon, the bootstrapper context, headless-entry.js, and the .mjs tests.
 */

'use strict';

const DEFAULT_EMPIR3_SERVER = 'https://app.empir3.com';
const LOCAL_DEV_EMPIR3_SERVER = 'http://localhost:3005';

/** Normalize any user/server-supplied base URL to `https://host[:port][/path]`
 *  with no trailing slash, defaulting to production on garbage. Bare
 *  localhost-ish hosts get http, everything else https. */
function normalizeServer(input) {
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

function classifyServer(serverUrl) {
  const normalized = normalizeServer(serverUrl);
  let host = '';
  try { host = new URL(normalized).host.toLowerCase(); } catch { /* keep '' */ }
  if (normalized === DEFAULT_EMPIR3_SERVER || host === 'app.empir3.com') return 'production';
  if (normalized === LOCAL_DEV_EMPIR3_SERVER || host === 'localhost:3005' || host === '127.0.0.1:3005') return 'local-dev';
  return 'custom';
}

function defaultWsUrl(serverUrl) {
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

/** A stored/offered wsUrl wins unless it is missing, malformed, or points at
 *  the legacy /relay path (which direct-edit forwarding must not use). */
function normalizeWsUrl(wsUrl, serverUrl) {
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

module.exports = {
  DEFAULT_EMPIR3_SERVER,
  LOCAL_DEV_EMPIR3_SERVER,
  normalizeServer,
  classifyServer,
  defaultWsUrl,
  normalizeWsUrl,
};
