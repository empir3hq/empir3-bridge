import { isIP } from 'node:net';

function normalizedHost(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

export function isPrivateNetworkAddress(address) {
  const host = normalizedHost(address);
  if (!host) return true;
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (isIP(host) === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(host)) return true;
    if (host.startsWith('::ffff:')) return isPrivateNetworkAddress(host.slice(7));
    return false;
  }
  return false;
}

// ─── User-approved origin allowlist ─────────────────────────────────
//
// The default policy blocks loopback, private-network, link-local and file:
// navigation so an agent cannot use the Bridge browser as an SSRF pivot into
// the user's LAN or filesystem. The Bridge's primary audience, though, is a
// developer iterating on http://localhost:3000. Rather than a blanket
// unblock, the user approves exact origins on the Permissions page; they are
// persisted in bridge-settings.json (`navigationAllowlist`) and shown there.
// Nothing an agent does can add an entry — only the local dashboard can.
//
// Entry forms:
//   http://localhost:3000        exact scheme + host + port (default port
//                                filled in, so "http://localhost" == :80)
//   https://app.internal:8443    hostnames resolving to private space are
//                                allowed once the origin is listed
//   file:///home/me/project/     any file whose path starts with this prefix
//   file://                      every local file (broadest; still explicit)

export const NAVIGATION_ALLOWLIST_MAX_ENTRIES = 50;

/**
 * Canonicalise one allowlist entry, or explain why it is not acceptable.
 * @returns {{ok:true, entry:string, kind:'origin'|'file'} | {ok:false, error:string}}
 */
export function normalizeNavigationAllowlistEntry(raw) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'Allowlist entry is empty' };
  if (input.length > 512) return { ok: false, error: 'Allowlist entry exceeds 512 characters' };
  if (input === 'file://' || input === 'file:///') return { ok: true, entry: 'file://', kind: 'file' };
  let url;
  try { url = new URL(input); }
  catch { return { ok: false, error: `Allowlist entry must be an origin like http://localhost:3000 or a file:// prefix (got "${input}")` }; }
  if (url.protocol === 'file:') {
    if (url.hostname && url.hostname !== 'localhost') return { ok: false, error: 'file:// allowlist entries cannot name a remote host' };
    // Keep the path prefix as given (a trailing slash means "this folder").
    return { ok: true, entry: `file://${url.pathname}`, kind: 'file' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Only http, https and file entries are allowed (got ${url.protocol})` };
  }
  if (url.username || url.password) return { ok: false, error: 'Allowlist entries cannot embed credentials' };
  if (url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, error: 'Allowlist entries are origins (scheme://host:port) — drop the path, query or fragment' };
  }
  const hostname = normalizedHost(url.hostname);
  if (!hostname) return { ok: false, error: 'Allowlist entry needs a host' };
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostPart = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return { ok: true, entry: `${url.protocol}//${hostPart}:${port}`, kind: 'origin' };
}

/**
 * Validate a whole allowlist as submitted from the dashboard: canonicalise,
 * de-duplicate, cap the count, and reject on the first bad entry so the user
 * sees exactly which line is wrong.
 */
export function normalizeNavigationAllowlist(list) {
  if (list == null) return { ok: true, entries: [] };
  if (!Array.isArray(list)) return { ok: false, error: 'navigationAllowlist must be an array of origins' };
  if (list.length > NAVIGATION_ALLOWLIST_MAX_ENTRIES) {
    return { ok: false, error: `navigationAllowlist accepts at most ${NAVIGATION_ALLOWLIST_MAX_ENTRIES} entries` };
  }
  const entries = [];
  for (const raw of list) {
    const checked = normalizeNavigationAllowlistEntry(raw);
    if (!checked.ok) return checked;
    if (!entries.includes(checked.entry)) entries.push(checked.entry);
  }
  return { ok: true, entries };
}

function originOf(url) {
  const hostname = normalizedHost(url.hostname);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const hostPart = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${url.protocol}//${hostPart}:${port}`;
}

/** Is this parsed URL covered by a (canonicalised) allowlist? */
export function navigationAllowlisted(url, allowedOrigins = []) {
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  if (!list.length) return false;
  if (url.protocol === 'file:') {
    if (list.includes('file://')) return true;
    const path = url.pathname || '';
    return list.some((entry) => entry.startsWith('file:///') && entry !== 'file://' && path.startsWith(entry.slice('file://'.length)));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return list.includes(originOf(url));
}

const ALLOWLIST_HINT = 'The user can approve this origin on the Bridge Permissions page under "Local & private origins".';

export function validateBrowserNavigationUrl(raw, { allowedLocalPorts = [], allowedOrigins = [] } = {}) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'URL is required' };
  if (input.length > 4_096) return { ok: false, error: 'URL exceeds 4096 characters' };
  if (input === 'about:blank') return { ok: true, url: input, hostname: '', requiresDnsCheck: false };

  let url;
  try { url = new URL(input); }
  catch { return { ok: false, error: 'URL must be an absolute http:// or https:// address' }; }
  if (url.protocol === 'file:') {
    if (navigationAllowlisted(url, allowedOrigins)) {
      return { ok: true, url: url.href, hostname: '', requiresDnsCheck: false, allowlisted: true };
    }
    return { ok: false, error: `URL scheme file: is blocked; only http and https are allowed. ${ALLOWLIST_HINT.replace('this origin', `a file:// prefix such as file://${url.pathname.replace(/[^/]*$/, '')}`)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `URL scheme ${url.protocol} is blocked; only http and https are allowed` };
  }
  if (url.username || url.password) return { ok: false, error: 'Credentials embedded in URLs are blocked' };

  const hostname = normalizedHost(url.hostname);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const allowlisted = navigationAllowlisted(url, allowedOrigins);
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost');
  const literalPrivate = isPrivateNetworkAddress(hostname);
  if (localName || literalPrivate) {
    const ownControlSurface = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(hostname)
      && allowedLocalPorts.map(String).includes(String(port));
    if (!ownControlSurface && !allowlisted) {
      return { ok: false, error: `Loopback, private-network, and link-local navigation is blocked (${originOf(url)}). ${ALLOWLIST_HINT}` };
    }
    return { ok: true, url: url.href, hostname, requiresDnsCheck: false, allowlisted };
  }

  // A listed public-looking origin (e.g. https://app.internal:8443) is the
  // user's explicit decision; skip the private-DNS check for it.
  return { ok: true, url: url.href, hostname, requiresDnsCheck: isIP(hostname) === 0 && !allowlisted, allowlisted };
}
