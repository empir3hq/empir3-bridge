/**
 * User-approved origin allowlist for browser navigation (Work Board 22e20910, P1).
 *
 * Default policy still blocks loopback / private / link-local / file: (SSRF
 * protection). A developer iterating on http://localhost:3000 approves the
 * exact origin on the Permissions page; it persists in bridge-settings.json
 * and is compared here. These tests pin: the default stays blocked, the
 * blocked error points at the dashboard, exact allowlisted origins pass,
 * near-misses (other port, other scheme, path-only entries) do not, file:
 * needs an explicit prefix, and entries are canonicalised and validated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBrowserNavigationUrl,
  normalizeNavigationAllowlistEntry,
  normalizeNavigationAllowlist,
  navigationAllowlisted,
  NAVIGATION_ALLOWLIST_MAX_ENTRIES,
} from '../src/browser-navigation-policy.mjs';

const canon = (list) => normalizeNavigationAllowlist(list).entries;

test('default policy: loopback, private, link-local and file: stay blocked with a dashboard pointer', () => {
  for (const url of ['http://127.0.0.1:8899/test.html', 'http://localhost:3000/', 'http://192.168.1.20:8080/', 'http://169.254.1.1/', 'http://10.1.2.3/']) {
    const r = validateBrowserNavigationUrl(url, { allowedLocalPorts: [3006] });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /Loopback, private-network, and link-local navigation is blocked/);
    assert.match(r.error, /Permissions page under "Local & private origins"/);
  }
  const file = validateBrowserNavigationUrl('file:///tmp/x/test.html', {});
  assert.equal(file.ok, false);
  assert.match(file.error, /URL scheme file: is blocked/);
  assert.match(file.error, /file:\/\/\/tmp\/x\//, 'suggests the folder prefix to allow');
});

test('own control surface on the bridge port is still allowed without an allowlist', () => {
  const r = validateBrowserNavigationUrl('http://localhost:3006/console', { allowedLocalPorts: [3006] });
  assert.equal(r.ok, true);
  assert.equal(r.allowlisted, false);
});

test('an exact allowlisted origin passes; other ports, schemes and hosts do not', () => {
  const allowed = canon(['http://localhost:3000', 'http://127.0.0.1:8899']);
  assert.equal(validateBrowserNavigationUrl('http://localhost:3000/app?x=1#y', { allowedOrigins: allowed }).ok, true);
  assert.equal(validateBrowserNavigationUrl('http://localhost:3000/app', { allowedOrigins: allowed }).allowlisted, true);
  assert.equal(validateBrowserNavigationUrl('http://127.0.0.1:8899/test.html', { allowedOrigins: allowed }).ok, true);
  assert.equal(validateBrowserNavigationUrl('http://localhost:3001/', { allowedOrigins: allowed }).ok, false, 'other port');
  assert.equal(validateBrowserNavigationUrl('https://localhost:3000/', { allowedOrigins: allowed }).ok, false, 'other scheme');
  assert.equal(validateBrowserNavigationUrl('http://127.0.0.1:3000/', { allowedOrigins: allowed }).ok, false, 'localhost entry does not cover the literal address');
  assert.equal(validateBrowserNavigationUrl('http://192.168.1.20:3000/', { allowedOrigins: allowed }).ok, false, 'LAN host not listed');
});

test('default ports are canonicalised so http://localhost and http://localhost:80 are the same entry', () => {
  const allowed = canon(['http://localhost', 'https://app.internal']);
  assert.deepEqual(allowed, ['http://localhost:80', 'https://app.internal:443']);
  assert.equal(validateBrowserNavigationUrl('http://localhost/', { allowedOrigins: allowed }).ok, true);
  assert.equal(validateBrowserNavigationUrl('http://localhost:80/x', { allowedOrigins: allowed }).ok, true);
  // A listed public-looking hostname skips the private-DNS check: the user
  // approved that exact origin.
  const internal = validateBrowserNavigationUrl('https://app.internal/login', { allowedOrigins: allowed });
  assert.equal(internal.ok, true);
  assert.equal(internal.requiresDnsCheck, false);
  const unlisted = validateBrowserNavigationUrl('https://example.com/', { allowedOrigins: allowed });
  assert.equal(unlisted.requiresDnsCheck, true, 'unlisted public hosts keep the DNS check');
});

test('file: navigation needs an explicit prefix entry; the prefix is honoured exactly', () => {
  const prefix = canon(['file:///home/me/project/']);
  assert.equal(validateBrowserNavigationUrl('file:///home/me/project/index.html', { allowedOrigins: prefix }).ok, true);
  assert.equal(validateBrowserNavigationUrl('file:///home/me/project/sub/page.html', { allowedOrigins: prefix }).ok, true);
  assert.equal(validateBrowserNavigationUrl('file:///home/me/projects/index.html', { allowedOrigins: prefix }).ok, false, 'sibling folder');
  assert.equal(validateBrowserNavigationUrl('file:///etc/passwd', { allowedOrigins: prefix }).ok, false);
  const all = canon(['file://']);
  assert.equal(validateBrowserNavigationUrl('file:///etc/hosts', { allowedOrigins: all }).ok, true);
  // An http allowlist never unlocks file:, and vice versa.
  assert.equal(validateBrowserNavigationUrl('file:///home/me/project/index.html', { allowedOrigins: canon(['http://localhost:3000']) }).ok, false);
  assert.equal(validateBrowserNavigationUrl('http://localhost:3000/', { allowedOrigins: all }).ok, false);
});

test('entries are validated: origins only, no credentials, no paths, no other schemes', () => {
  assert.deepEqual(normalizeNavigationAllowlistEntry('http://localhost:3000'), { ok: true, entry: 'http://localhost:3000', kind: 'origin' });
  assert.deepEqual(normalizeNavigationAllowlistEntry('  HTTP://LocalHost:3000/  '), { ok: true, entry: 'http://localhost:3000', kind: 'origin' });
  assert.deepEqual(normalizeNavigationAllowlistEntry('http://[::1]:8080'), { ok: true, entry: 'http://[::1]:8080', kind: 'origin' });
  assert.deepEqual(normalizeNavigationAllowlistEntry('file:///home/me/project/'), { ok: true, entry: 'file:///home/me/project/', kind: 'file' });
  assert.deepEqual(normalizeNavigationAllowlistEntry('file://'), { ok: true, entry: 'file://', kind: 'file' });
  assert.match(normalizeNavigationAllowlistEntry('http://localhost:3000/app').error, /origins .* drop the path/);
  assert.match(normalizeNavigationAllowlistEntry('http://user:pw@localhost:3000').error, /credentials/);
  assert.match(normalizeNavigationAllowlistEntry('ftp://localhost').error, /Only http, https and file/);
  assert.match(normalizeNavigationAllowlistEntry('localhost:3000').error, /Only http, https and file entries are allowed/);
  assert.match(normalizeNavigationAllowlistEntry('not a url').error, /must be an origin/);
  assert.match(normalizeNavigationAllowlistEntry('').error, /empty/);
  assert.match(normalizeNavigationAllowlistEntry('file://server/share').error, /remote host/);
});

test('a whole list is de-duplicated, capped, and rejected on the first bad entry', () => {
  assert.deepEqual(normalizeNavigationAllowlist(['http://localhost:3000', 'http://localhost:3000/', 'http://LOCALHOST:3000']), { ok: true, entries: ['http://localhost:3000'] });
  assert.deepEqual(normalizeNavigationAllowlist(undefined), { ok: true, entries: [] });
  assert.equal(normalizeNavigationAllowlist('http://localhost:3000').ok, false);
  const bad = normalizeNavigationAllowlist(['http://localhost:3000', 'nope']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nope/);
  const tooMany = normalizeNavigationAllowlist(Array.from({ length: NAVIGATION_ALLOWLIST_MAX_ENTRIES + 1 }, (_, i) => `http://localhost:${4000 + i}`));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /at most/);
});

test('navigationAllowlisted compares canonical origins only', () => {
  assert.equal(navigationAllowlisted(new URL('http://localhost:3000/x'), ['http://localhost:3000']), true);
  assert.equal(navigationAllowlisted(new URL('http://localhost:3000/x'), []), false);
  assert.equal(navigationAllowlisted(new URL('http://localhost:3000/x'), 'http://localhost:3000'), false, 'non-array is ignored');
  assert.equal(navigationAllowlisted(new URL('ws://localhost:3000/x'), ['ws://localhost:3000']), false);
});
