import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { readPersistentJson, writePersistentJson } = require('../src/persistent-json.js');

function scratchDir() {
  const path = join(tmpdir(), `empir3-persistent-json-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function providerState(model = 'qwen/qwen3.5-9b') {
  return {
    deviceId: 'bridge-retention-test',
    customProviders: [{
      slug: 'lm-studio-local',
      name: 'LM Studio local',
      apiBaseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-secret-never-real',
      models: [model],
      lend: true,
    }],
  };
}

test('persistent JSON mirrors the newest provider state to a secure backup', () => {
  const dir = scratchDir();
  const primary = join(dir, 'bridge-settings.json');
  const backup = `${primary}.bak`;
  try {
    writePersistentJson(primary, providerState(), { backupPath: backup, mode: 0o600 });
    writePersistentJson(primary, providerState('qwen/qwen3.5-14b'), { backupPath: backup, mode: 0o600 });

    assert.ok(existsSync(primary));
    assert.ok(existsSync(backup));
    assert.deepEqual(JSON.parse(readFileSync(primary, 'utf8')), JSON.parse(readFileSync(backup, 'utf8')));
    assert.equal(JSON.parse(readFileSync(backup, 'utf8')).customProviders[0].models[0], 'qwen/qwen3.5-14b');
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false, 'no interrupted temp files remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated settings file restores the custom provider and preserves damaged bytes', () => {
  const dir = scratchDir();
  const primary = join(dir, 'bridge-settings.json');
  const backup = `${primary}.bak`;
  const recoveryMessages = [];
  try {
    writePersistentJson(primary, providerState(), { backupPath: backup, mode: 0o600 });
    writeFileSync(primary, '{"deviceId":"bridge-retention-test","customProviders":[', 'utf8');

    const recovered = readPersistentJson(primary, {
      backupPath: backup,
      defaultValue: () => ({ deviceId: 'wrong-default' }),
      mode: 0o600,
      onRecovery: (message) => recoveryMessages.push(message),
      writeDefault: true,
    });

    assert.equal(recovered.customProviders[0].slug, 'lm-studio-local');
    assert.equal(recovered.customProviders[0].models[0], 'qwen/qwen3.5-9b');
    assert.equal(recovered.customProviders[0].apiKey, 'test-secret-never-real');
    assert.equal(recoveryMessages.length, 1);
    assert.match(recoveryMessages[0], /Restored .* from .*\.bak/);
    const preserved = readdirSync(dir).filter((name) => name.startsWith('bridge-settings.json.corrupt-'));
    assert.equal(preserved.length, 1, 'the damaged primary remains available for support');
    assert.match(readFileSync(join(dir, preserved[0]), 'utf8'), /customProviders/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing primary restores directly from its last-known-good backup', () => {
  const dir = scratchDir();
  const primary = join(dir, 'config.json');
  const backup = `${primary}.bak`;
  try {
    writePersistentJson(primary, { apiKeys: { anthropic: 'test-key' } }, { backupPath: backup, mode: 0o600 });
    rmSync(primary);

    const recovered = readPersistentJson(primary, {
      backupPath: backup,
      defaultValue: () => ({ apiKeys: {} }),
      mode: 0o600,
      writeDefault: true,
    });

    assert.equal(recovered.apiKeys.anthropic, 'test-key');
    assert.equal(JSON.parse(readFileSync(primary, 'utf8')).apiKeys.anthropic, 'test-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first read after upgrading an older Bridge captures existing provider state', () => {
  const dir = scratchDir();
  const primary = join(dir, 'bridge-settings.json');
  const backup = `${primary}.bak`;
  try {
    writeFileSync(primary, JSON.stringify(providerState(), null, 2), 'utf8');
    assert.equal(existsSync(backup), false, 'precondition: older Bridge had no backup file');

    const loaded = readPersistentJson(primary, {
      backupPath: backup,
      defaultValue: () => ({ deviceId: 'wrong-default' }),
      mode: 0o600,
      writeDefault: true,
    });

    assert.equal(loaded.customProviders[0].slug, 'lm-studio-local');
    assert.ok(existsSync(backup), 'the first upgraded read must create a retention backup');
    assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), JSON.parse(readFileSync(primary, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
