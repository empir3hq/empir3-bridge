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
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(host)
      && resolvedPort === String(port);
  } catch {
    return false;
  }
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
