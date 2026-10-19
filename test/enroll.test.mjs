/**
 * enroll — Fleet Phase 8 zero-touch enrollment (client half).
 *
 * What is pinned:
 *  - the resolution chain's precedence (argv > env > settings file) and that
 *    malformed tokens are rejected at every source;
 *  - a successful enrollment writes bridge-auth.json with the DEVICE token
 *    (0600), persists the server-assigned deviceId, and BURNS the file source;
 *  - a refusal writes NOTHING (no half-enrolled state on disk).
 *
 * The settings dir is redirected via APPDATA before enroll.js is required, so
 * the test can never touch a real bridge's auth. (enroll.js resolves its
 * paths at require time — that's why the env is set at the very top.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const SANDBOX = mkdtempSync(join(tmpdir(), 'empir3-enroll-test-'));
process.env.APPDATA = SANDBOX; // MUST precede the require below
const require = createRequire(import.meta.url);
const { resolveEnrollSource, enrollIfNeeded, ENROLL_TOKEN_RE, USER_ENROLL_FILE } = require('../src/enroll.js');

const SETTINGS_DIR = join(SANDBOX, 'Empir3');
const AUTH_FILE = join(SETTINGS_DIR, 'bridge-auth.json');
const VALID = 'e3en_' + 'a'.repeat(48);
const VALID2 = 'e3en_' + 'b'.repeat(48);

test('sandbox actually redirected — refuse to run against a real profile', () => {
  assert.ok(USER_ENROLL_FILE.startsWith(SANDBOX), `enroll paths must live under the sandbox (got ${USER_ENROLL_FILE})`);
});

test('resolution chain: argv beats env beats settings file; malformed tokens rejected everywhere', () => {
  const env = { EMPIR3_ENROLL_TOKEN: VALID2 };
  const argvHit = resolveEnrollSource(['node', 'x', '--enroll-token', VALID], env);
  assert.equal(argvHit?.token, VALID);
  assert.equal(argvHit?.source, 'argv');

  const envHit = resolveEnrollSource(['node', 'x'], env);
  assert.equal(envHit?.token, VALID2);
  assert.equal(envHit?.source, 'env');

  assert.equal(resolveEnrollSource(['node', 'x', '--enroll-token', 'not-a-token'], {}), null);
  assert.equal(resolveEnrollSource(['node', 'x'], { EMPIR3_ENROLL_TOKEN: 'e3en_SHORT' }), null);
  assert.equal(resolveEnrollSource(['node', 'x'], {}), null, 'no source resolves to null');
  assert.ok(ENROLL_TOKEN_RE.test(VALID) && !ENROLL_TOKEN_RE.test('e3dt_' + 'a'.repeat(48)), 'device tokens are not enroll tokens');
});

test('successful enrollment: device-scoped auth written 0600, deviceId persisted, file source burned', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        userId: 'u-1', email: 'v•••@empir3.com', name: 'VK',
        deviceId: 'bridge-assigned-by-server', deviceName: 'test-box',
        deviceToken: 'e3dt_' + 'c'.repeat(48),
        approvalPending: false,
        serverUrl: `http://127.0.0.1:${server.address().port}`,
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(USER_ENROLL_FILE, JSON.stringify({ enrollToken: VALID, serverUrl: base }), { mode: 0o600 });
  try {
    const result = await enrollIfNeeded({ argv: ['node', 'x'], env: {}, agentVersion: '0.3.45-test', log: () => {} });
    assert.equal(result.enrolled, true);
    assert.equal(result.deviceId, 'bridge-assigned-by-server');

    assert.equal(requests[0].url, '/api/auth/pairing-sessions/enroll');
    assert.equal(requests[0].body.enrollToken, VALID);
    assert.equal(requests[0].body.agentVersion, '0.3.45-test');

    const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
    assert.equal(auth.deviceToken, 'e3dt_' + 'c'.repeat(48));
    assert.equal(auth.deviceId, 'bridge-assigned-by-server');
    assert.ok(auth.deviceTokenMintedAt, 'mintedAt recorded for the rotation clock');
    assert.equal(auth.legacyToken, undefined, 'no user-scoped token on an enrolled machine');
    if (process.platform !== 'win32') {
      assert.equal(statSync(AUTH_FILE).mode & 0o777, 0o600, 'auth file is 0600');
    }

    const settings = JSON.parse(readFileSync(join(SETTINGS_DIR, 'bridge-settings.json'), 'utf-8'));
    assert.equal(settings.deviceId, 'bridge-assigned-by-server', 'server-assigned id persisted for the connect path');

    assert.equal(existsSync(USER_ENROLL_FILE), false, 'the one-shot secret is burned after success');
  } finally {
    // closeAllConnections too: node 19+ keeps client sockets alive on the
    // global agent, and a lingering keep-alive socket holds the test process
    // open past every runner timeout (observed as a silent 300s hang through
    // a tail pipe).
    server.closeAllConnections?.();
    server.close();
  }
});

test('a refusal writes nothing', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Enrollment refused.' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, 'utf-8') : null;
    const result = await enrollIfNeeded({
      argv: ['node', 'x', '--enroll-token', VALID2],
      env: { EMPIR3_SERVER: base },
      log: () => {},
    });
    assert.equal(result.enrolled, false);
    assert.match(result.reason, /403/);
    const after = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, 'utf-8') : null;
    assert.equal(after, before, 'a refused enrollment must not touch the auth file');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
