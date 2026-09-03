import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { revokePriorDeviceCredential } = require('../src/account-handover.js');

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
