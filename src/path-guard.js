/**
 * Path read-guard — decides whether an already-resolved absolute path may be
 * read by desktop:file:pull.
 *
 * Why this exists: validateReadableFilePath was written for Windows and its
 * blocklist compares lowercased `c:\windows`-shaped prefixes. On Linux zero
 * of those prefixes match, so the moment the POSIX shell/file branch works,
 * `cat /etc/sudoers` — and every other system file — is reachable with NO
 * guard at all. This module is the POSIX twin, shipped in the same commit as
 * the POSIX branch it protects.
 *
 * Design choices:
 *  - Block by PATH BOUNDARY, never bare substring: `/etc` catches `/etc` and
 *    `/etc/passwd` but not `/etcetera`. Substring matching both over-blocks
 *    (legitimate `/opt/etc-tools`) and is trivially bypassed.
 *  - Keep `/var/log /srv /opt /home /usr/local` READABLE. A fleet agent
 *    legitimately reads logs and app dirs; over-blocking drives users to
 *    disable the guard entirely, which is worse than a tuned blocklist.
 *  - EMPIR3_ALLOWED_ROOTS turns on allowlist mode for enterprises: if set,
 *    ONLY paths under one of those roots are readable (blocklist still also
 *    applies, so an allowlisted /home can't reach /home/user/.ssh).
 *  - As on Windows, a blocklist is a speed bump. The real boundary on Linux
 *    is the systemd service user + ProtectSystem=full. See docs/SAFETY.md.
 */

'use strict';

const path = require('path');

// Directory roots that must never be read on POSIX. Matched at a path
// boundary (the dir itself or anything beneath it).
const POSIX_BLOCKED_ROOTS = [
  '/etc', '/root', '/boot', '/sys', '/proc', '/dev',
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/lib', '/lib64',
  '/var/lib', '/var/run', '/run',
];

// Fragments that mark a credential/secret file anywhere in the path.
// Directory fragments end in '/' and match as substrings; file fragments
// match only at a path-component boundary (`/environ` catches
// /proc/self/environ but NOT /notes/environment.md).
const POSIX_BLOCKED_FRAGMENTS = [
  '/.ssh/', '/.aws/', '/.gnupg/', '/.kube/', '/.azure/', '/.docker/',
  '/.npmrc', '/.netrc', '/.pgpass', '/.git-credentials',
  '/id_rsa', '/id_ed25519', '/id_ecdsa', '/id_dsa',
  '/shadow', '/gshadow', '/sudoers', '/environ',
  '/authorized_keys', '/known_hosts',
];

/** Fragment test with component-boundary semantics for file fragments. */
function containsBlockedFragment(p, frag) {
  if (frag.endsWith('/')) return p.includes(frag);
  return p.endsWith(frag) || p.includes(frag + '/') || p.includes(frag + '.');
}

// Basenames (case-insensitive) that are secrets wherever they live.
const BLOCKED_BASENAMES = /^(shadow|gshadow|passwd|sudoers|\.pgpass|\.netrc|\.npmrc|id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts)$/i;

function toPosixLower(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Boundary-aware prefix test: is `target` equal to `root` or nested under it?
 * Both are forward-slash strings. Comparison is case-sensitive (correct for
 * POSIX; the Windows guard has its own case-insensitive path).
 */
function isUnder(target, root) {
  if (target === root) return true;
  const withSlash = root.endsWith('/') ? root : root + '/';
  return target.startsWith(withSlash);
}

/**
 * Decide whether a resolved absolute POSIX path is blocked for reading.
 *
 * @param {string} target   already-resolved absolute path (POSIX form)
 * @param {object} [opts]
 * @param {string[]} [opts.allowedRoots]  EMPIR3_ALLOWED_ROOTS list; when
 *                                        non-empty, allowlist mode is on.
 * @returns {string|null}   block reason, or null when readable
 */
function blockedPosixReadPath(target, opts = {}) {
  const p = toPosixLower(target);
  const base = p.slice(p.lastIndexOf('/') + 1);

  // Allowlist mode (enterprise): must be under an allowed root first.
  const allowedRoots = (opts.allowedRoots || []).map(toPosixLower).filter(Boolean);
  if (allowedRoots.length && !allowedRoots.some(root => isUnder(p, root))) {
    return 'Access denied: path is outside the configured allowed roots';
  }

  for (const root of POSIX_BLOCKED_ROOTS) {
    if (isUnder(p, root)) return `Access denied: system directory (${root})`;
  }
  for (const frag of POSIX_BLOCKED_FRAGMENTS) {
    if (containsBlockedFragment(p, frag)) return `Cannot read credential/secret file (${frag})`;
  }
  if (BLOCKED_BASENAMES.test(base)) return 'Cannot read credential/system file';

  return null;
}

/**
 * Parse EMPIR3_ALLOWED_ROOTS (path-separator or comma delimited) into a
 * resolved list. Returns [] when unset.
 */
function parseAllowedRoots(env = process.env) {
  const raw = env.EMPIR3_ALLOWED_ROOTS;
  if (!raw) return [];
  return String(raw)
    .split(/[;,\n]|:(?=\/)/) // comma/newline, or a colon that precedes an absolute path
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      try { return path.resolve(s); } catch { return s; }
    });
}

module.exports = {
  blockedPosixReadPath,
  parseAllowedRoots,
  isUnder,
  POSIX_BLOCKED_ROOTS,
  POSIX_BLOCKED_FRAGMENTS,
  BLOCKED_BASENAMES,
};
