import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('all inference routes advertise or enforce the shared provider capacity contract', () => {
  assert.match(server, /startCliTurnWithProviderCapacity\('claude'/);
  assert.match(server, /startCliTurnWithProviderCapacity\('codex'/);
  assert.match(server, /startCliTurnWithProviderCapacity\(\s*'gemini'/);
  assert.match(server, /startCliTurnWithProviderCapacity\(\s*'grok'/);
  assert.match(server, /startCliTurnWithProviderCapacity\(\s*'agy'/);
  assert.match(server, /async function cliRun[\s\S]*?providerConcurrencyGate\.tryAcquire\(providerKey, id/);
  assert.match(server, /async function runCliSee[\s\S]*?providerConcurrencyGate\.tryAcquire\(providerKey, id/);
  assert.match(server, /async function runAgyCliSee[\s\S]*?providerConcurrencyGate\.tryAcquire\(providerKey, id/);
  assert.match(server, /async function runAgyCliImageGen[\s\S]*?providerConcurrencyGate\.tryAcquire\(providerKey, id/);
  assert.match(server, /customProviderConcurrencyKey\(provider\)/);
  assert.match(server, /providerConcurrencyBusyResult\(providerKey, id, configured\.name\)/);
  assert.match(server, /providerConcurrencyBusyResult\(providerKey, id, 'Higgsfield CLI'\)/);
  assert.match(server, /code: 'provider_concurrency_busy'/);
  assert.match(server, /retryable: true/);
  assert.match(server, /data-provider-capacity/);
  assert.match(server, /providerConcurrencyMax/);
});
