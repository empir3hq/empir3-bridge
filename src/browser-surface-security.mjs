/**
 * Browser-facing trust boundary for the local Bridge server.
 *
 * Browser pages are hostile even when they are displayed in the Bridge-owned
 * Chrome profile. Only the localhost control surface may act as a user. Native
 * CLI clients use a WebSocket implementation that sends no Origin header.
 */

export function isTrustedLocalBridgeOrigin(origin, port) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const resolvedPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return origin === url.origin && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(host)
      && resolvedPort === String(port);
  } catch {
    return false;
  }
}

/** Check the authority before returning ANY page, nonce, CORS reply, or WS
 * handshake. DNS resolving a hostile hostname to loopback does not trust it. */
export function isTrustedLocalBridgeHost(host, port) {
  if (typeof host !== 'string') return false;
  return ['localhost', '127.0.0.1', '[::1]'].some(name =>
    host.toLowerCase() === `${name}:${port}` || (String(port) === '80' && host.toLowerCase() === name));
}

export function localBridgeRequestRefusal({ headers, method = 'GET', port, hasNonce = false }) {
  if (!isTrustedLocalBridgeHost(headers.host, port)) return 'Untrusted Bridge host';
  const origin = headers.origin;
  if (origin && isTrustedLocalBridgeOrigin(origin, port)) return null;
  if (hasNonce) return null;
  // A preflight reveals no state. Its actual request still needs the nonce.
  if (method === 'OPTIONS' && String(headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).includes('x-empir3-nonce')) return null;
  // Opening the dashboard from a link is allowed. Subresources/fetches from
  // unrelated pages cannot read local state, even when Origin is omitted.
  if (!origin && method === 'GET' && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document') return null;
  if (origin || ['cross-site', 'same-site'].includes(headers['sec-fetch-site'])) return 'Untrusted browser request';
  return null; // Native local tools deliberately send neither browser header.
}

export function classifyBridgeWebSocket({ role, origin, port }) {
  if (role === 'cli') {
    return origin ? { accepted: false, reason: 'browser origins cannot claim the cli role' } : { accepted: true, role: 'cli' };
  }
  if (role === 'control') {
    return isTrustedLocalBridgeOrigin(origin, port)
      ? { accepted: true, role: 'control' }
      : { accepted: false, reason: 'control role requires the trusted localhost origin' };
  }
  return { accepted: false, reason: 'unsupported browser socket role' };
}
