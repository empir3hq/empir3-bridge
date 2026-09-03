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

export function validateBrowserNavigationUrl(raw, { allowedLocalPorts = [] } = {}) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'URL is required' };
  if (input.length > 4_096) return { ok: false, error: 'URL exceeds 4096 characters' };
  if (input === 'about:blank') return { ok: true, url: input, hostname: '', requiresDnsCheck: false };

  let url;
  try { url = new URL(input); }
  catch { return { ok: false, error: 'URL must be an absolute http:// or https:// address' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `URL scheme ${url.protocol} is blocked; only http and https are allowed` };
  }
  if (url.username || url.password) return { ok: false, error: 'Credentials embedded in URLs are blocked' };

  const hostname = normalizedHost(url.hostname);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost');
  const literalPrivate = isPrivateNetworkAddress(hostname);
  if (localName || literalPrivate) {
    const ownControlSurface = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(hostname)
      && allowedLocalPorts.map(String).includes(String(port));
    if (!ownControlSurface) {
      return { ok: false, error: 'Loopback, private-network, and link-local navigation is blocked' };
    }
    return { ok: true, url: url.href, hostname, requiresDnsCheck: false };
  }

  return { ok: true, url: url.href, hostname, requiresDnsCheck: isIP(hostname) === 0 };
}
