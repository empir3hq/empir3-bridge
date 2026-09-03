/**
 * POSIX read-path guard tests.
 *
 * THE HOLE THIS GUARDS: validateReadableFilePath's blocklist compared
 * lowercased `c:\windows`-shaped prefixes, so on Linux ZERO prefixes matched —
 * the moment the POSIX shell/file branch landed, /etc/sudoers, /etc/shadow and
 * /proc/self/environ were all readable with no guard at all. path-guard.js is
 * the POSIX twin, and this suite pins its contract:
 *   - boundary matching (/etc blocked, /etcetera NOT blocked)
 *   - fleet-legitimate paths stay readable (/var/log, /srv, /opt, /home)
 *   - credential fragments blocked anywhere (~/.ssh/, /.aws/, environ)
 *   - EMPIR3_ALLOWED_ROOTS allowlist mode
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  blockedPosixReadPath,
  parseAllowedRoots,
  isUnder,
} = require_('../src/path-guard.js');

// ── system directories are denied ──

for (const p of [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/passwd',
  '/etc',
  '/proc/self/environ',
  '/proc/1/cmdline',
  '/sys/kernel/config',
  '/root/.bashrc',
  '/boot/grub/grub.cfg',
  '/dev/sda',
  '/bin/sh',
  '/usr/bin/sudo',
  '/var/lib/empir3/state.db',
  '/run/secrets/token',
]) {
  test(`denied: ${p}`, () => {
    assert.notEqual(blockedPosixReadPath(p), null, `${p} must be blocked`);
  });
}

// ── fleet-legitimate paths stay readable ──

for (const p of [
  '/var/log/syslog',
  '/var/log/nginx/access.log',
  '/srv/app/config.yaml',
  '/opt/tool/readme.txt',
  '/home/deploy/app/index.js',
  '/usr/local/etc-notes.txt',
  '/usr/local/share/doc.md',
  '/tmp/build.log',
  '/etcetera/file.txt', // boundary check: NOT under /etc
  '/home/user/proc-notes/environment.md', // 'environ' must match as a boundary-ish fragment, not this
]) {
  test(`readable: ${p}`, () => {
    assert.equal(blockedPosixReadPath(p), null, `${p} must be readable`);
  });
}

// ── credential fragments blocked anywhere ──

for (const p of [
  '/home/deploy/.ssh/id_rsa',
  '/home/deploy/.ssh/authorized_keys',
  '/home/deploy/.aws/credentials',
  '/home/deploy/.aws/config',
  '/home/deploy/.gnupg/secring.gpg',
  '/home/deploy/.kube/config',
  '/home/deploy/.npmrc',
  '/home/deploy/.netrc',
  '/srv/backup/etc/shadow', // blocked by basename even outside /etc
]) {
  test(`credential denied: ${p}`, () => {
    assert.notEqual(blockedPosixReadPath(p), null, `${p} must be blocked`);
  });
}

// ── allowlist mode ──

test('allowlist mode: inside an allowed root passes', () => {
  assert.equal(
    blockedPosixReadPath('/srv/app/data.json', { allowedRoots: ['/srv/app'] }),
    null,
  );
});

test('allowlist mode: outside every allowed root is denied', () => {
  assert.match(
    String(blockedPosixReadPath('/home/deploy/notes.txt', { allowedRoots: ['/srv/app'] })),
    /outside the configured allowed roots/,
  );
});

test('allowlist mode: blocklist still applies inside an allowed root', () => {
  assert.notEqual(
    blockedPosixReadPath('/home/deploy/.ssh/id_rsa', { allowedRoots: ['/home/deploy'] }),
    null,
    'an allowlisted /home must not expose ~/.ssh',
  );
});

test('allowlist boundary: /srv/app does not admit /srv/app-secrets', () => {
  assert.notEqual(
    blockedPosixReadPath('/srv/app-secrets/key.txt', { allowedRoots: ['/srv/app'] }),
    null,
  );
});

// ── parseAllowedRoots ──

test('parseAllowedRoots: unset → []', () => {
  assert.deepEqual(parseAllowedRoots({}), []);
});

test('parseAllowedRoots: comma-separated', () => {
  const roots = parseAllowedRoots({ EMPIR3_ALLOWED_ROOTS: '/srv/app,/var/log' });
  assert.equal(roots.length, 2);
});

test('parseAllowedRoots: colon-separated absolute POSIX paths', () => {
  const roots = parseAllowedRoots({ EMPIR3_ALLOWED_ROOTS: '/srv/app:/var/log' });
  assert.equal(roots.length, 2);
});

// ── isUnder boundary semantics ──

test('isUnder: exact match and nested are true, sibling-prefix is false', () => {
  assert.equal(isUnder('/etc', '/etc'), true);
  assert.equal(isUnder('/etc/ssh/sshd_config', '/etc'), true);
  assert.equal(isUnder('/etcetera', '/etc'), false);
});
