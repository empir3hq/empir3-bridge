import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { revokePriorDeviceCredential, revokeCurrentDeviceCredential, queuePendingRetire, readPendingRetire, retirePendingCredentials } = require('../src/account-handover.js');

function fixture() {
  const root = join(tmpdir(), `e3-handover-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const settingsBase = join(root, 'settings');
  const dir = join(settingsBase, 'Empir3');
  mkdirSync(dir, { recursive: true });
  return { root, settingsBase, authFile: join(dir, 'bridge-auth.json'), settingsFile: join(dir, 'bridge-settings.json') };
}

function seed(f, previous, deviceId = 'bridge-device-123') {
  writeFileSync(f.authFile, JSON.stringify(previous), 'utf8');
  writeFileSync(f.settingsFile, JSON.stringify({ deviceId }), 'utf8');
}

test('sign-out retires a device token without relying on stale local identity', async () => {
  const f = fixture();
  try {
    seed(f, { deviceToken: 'e3dt_test', serverUrl: 'https://example.com' }, 'stale-id');
    let captured;
    const result = await revokeCurrentDeviceCredential({ ...f, request: async (...args) => {
      captured = args; return { status: 200, body: { success: true } };
    } });
    assert.equal(result.revoked, true);
    assert.deepEqual(captured, ['https://example.com', 'e3dt_test']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('sign-out is idempotent for revoked tokens and does not revoke user sessions', async () => {
  assert.equal((await revokeCurrentDeviceCredential({ previousAuth: { legacyToken: 'session' }, request: () => assert.fail('must not revoke session') })).attempted, false);
  const result = await revokeCurrentDeviceCredential({ previousAuth: { deviceToken: 'e3dt_revoked' }, request: async () => ({ status: 403 }) });
  assert.equal(result.revoked, true);
  assert.equal(result.alreadyRevoked, true);
});

test('sign-out reports an unavailable or malformed retirement without claiming success', async () => {
  for (const request of [async () => ({ status: 503 }), async () => ({ status: 200, body: {} }), async () => { throw Error('offline'); }]) {
    const result = await revokeCurrentDeviceCredential({ previousAuth: { deviceToken: 'e3dt_test' }, request });
    assert.equal(result.attempted, true);
    assert.equal(result.revoked, false);
  }
});

test('same-account pairing never revokes the current device token', async () => {
  const f = fixture();
  try {
    const previous = { deviceToken: 'e3dt_old', user: { id: 'u1' }, serverUrl: 'https://app.empir3.com' };
    seed(f, previous);
    let called = false;
    const result = await revokePriorDeviceCredential(
      { legacyToken: 'new', user: { id: 'u1' }, serverUrl: 'https://app.empir3.com/' },
      { ...f, request: async () => { called = true; } },
    );
    assert.equal(result.reason, 'same-account');
    assert.equal(called, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('account switch self-revokes with the old token and persisted device id', async () => {
  const f = fixture();
  try {
    seed(f, { deviceToken: 'e3dt_old-secret', user: { id: 'u1' }, serverUrl: 'https://old.example' });
    let captured;
    const result = await revokePriorDeviceCredential(
      { legacyToken: 'new', user: { id: 'u2' }, serverUrl: 'https://new.example' },
      { ...f, request: async (...args) => { captured = args; return { status: 200, body: { success: true } }; } },
    );
    assert.equal(result.revoked, true);
    assert.deepEqual(captured, ['https://old.example', 'e3dt_old-secret', 'bridge-device-123']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('handover failure is structured and does not block saving the new account', async () => {
  const f = fixture();
  try {
    seed(f, { deviceToken: 'e3dt_old', user: { id: 'u1' }, serverUrl: 'https://app.empir3.com' });
    const result = await revokePriorDeviceCredential(
      { legacyToken: 'new', user: { id: 'u2' }, serverUrl: 'https://app.empir3.com' },
      { ...f, request: async () => ({ status: 404, body: null }) },
    );
    assert.equal(result.attempted, true);
    assert.equal(result.revoked, false);
    assert.equal(result.status, 404);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---- card 8c9c2aab: a sign-out the server could not confirm is retried ----

test('an unconfirmed sign-out hands back what a retry needs, and only the device token', async () => {
  const result = await revokeCurrentDeviceCredential({
    previousAuth: { deviceToken: 'e3dt_pending', legacyToken: 'account-bearer', serverUrl: 'http://localhost:3005' },
    request: async () => ({ status: 429 }),
  });
  assert.equal(result.revoked, false);
  assert.deepEqual(result.pending, { deviceToken: 'e3dt_pending', serverUrl: 'http://localhost:3005' });
});

test('queued retirements are retried until the server answers 200 or 403, then forgotten', async () => {
  const f = fixture();
  try {
    queuePendingRetire({ deviceToken: 'e3dt_one', serverUrl: 'https://app.empir3.com' }, f);
    queuePendingRetire({ deviceToken: 'e3dt_two', serverUrl: 'http://localhost:3005' }, f);
    queuePendingRetire({ deviceToken: 'e3dt_one', serverUrl: 'https://app.empir3.com' }, f); // de-duplicated
    assert.equal(readPendingRetire(f).length, 2);

    // Server still down: nothing is dropped.
    let r = await retirePendingCredentials({ ...f, request: async () => { throw Error('ECONNREFUSED'); } });
    assert.deepEqual(r, { retired: 0, remaining: 2 });
    r = await retirePendingCredentials({ ...f, request: async () => ({ status: 429 }) });
    assert.deepEqual(r, { retired: 0, remaining: 2 });

    // One confirms, one is already unusable: both are done.
    const seen = [];
    r = await retirePendingCredentials({ ...f, request: async (url, token) => { seen.push([url, token]); return { status: token === 'e3dt_one' ? 200 : 403, body: { success: true } }; } });
    assert.deepEqual(r, { retired: 2, remaining: 0 });
    assert.deepEqual(seen.map((x) => x.join(' ')).sort(), ['http://localhost:3005 e3dt_two', 'https://app.empir3.com e3dt_one']);
    assert.equal(readPendingRetire(f).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a sign-out queued during retirement survives the in-flight retry', async () => {
  const f = fixture();
  try {
    queuePendingRetire({ deviceToken: 'e3dt_old' }, f);
    let finish;
    const retry = retirePendingCredentials({ ...f, request: () => new Promise(resolve => { finish = resolve; }) });
    queuePendingRetire({ deviceToken: 'e3dt_new' }, f);
    finish({ status: 200, body: { success: true } });
    assert.deepEqual(await retry, { retired: 1, remaining: 1 });
    assert.deepEqual(readPendingRetire(f).map(e => e.deviceToken), ['e3dt_new']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('retirement retries require a confirmed success body and do not resurrect entries removed by another retry', async () => {
  const f = fixture();
  try {
    queuePendingRetire({ deviceToken: 'e3dt_old' }, f);
    assert.deepEqual(await retirePendingCredentials({ ...f, request: async () => ({ status: 200, body: {} }) }), { retired: 0, remaining: 1 });
    let finish;
    const older = retirePendingCredentials({ ...f, request: () => new Promise(resolve => { finish = resolve; }) });
    assert.deepEqual(await retirePendingCredentials({ ...f, request: async () => ({ status: 403 }) }), { retired: 1, remaining: 0 });
    finish({ status: 503 });
    assert.deepEqual(await older, { retired: 0, remaining: 0 });
    assert.deepEqual(readPendingRetire(f), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the pending queue lives beside, not inside, the auth file', async () => {
  const f = fixture();
  try {
    seed(f, { deviceToken: 'e3dt_live', serverUrl: 'https://app.empir3.com' });
    queuePendingRetire({ deviceToken: 'e3dt_old', serverUrl: 'https://app.empir3.com' }, f);
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(f.authFile, 'utf8'), /e3dt_live/);
    assert.doesNotMatch(readFileSync(f.authFile, 'utf8'), /e3dt_old/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
