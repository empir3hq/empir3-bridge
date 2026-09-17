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
  assert.match(server, /async function cliRun[\s\S]*?await acquireProviderLeaseWithRefreshPatience\(providerKey, id\)/);
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

test('Grok admission serializes around a token refresh and advertises pool truth', () => {
  // Effective limit and probe snapshot must both flow through the refresh gate
  // so a drained pool is enforced AND advertised as capacity 1.
  assert.match(server, /if \(providerKey === 'cli:grok'\) return grokRefreshGate\.effectiveLimit\(limit\);/);
  assert.match(server, /if \(providerKey === 'cli:grok'\) snapshot\.pool_state = grokRefreshGate\.poolState\(\);/);
  // Relay turns and cli_run park briefly through a refresh window instead of
  // instantly spilling the whole fan-out to the hosted backup.
  assert.match(server, /async function acquireProviderLeaseWithRefreshPatience/);
  assert.match(server, /async function startCliTurnWithProviderCapacity[\s\S]*?await acquireProviderLeaseWithRefreshPatience\(providerKey, id\)/);
  // Auth-class failures reactively drain the pool.
  assert.match(server, /grokRefreshGate\.noteAuthFailure\(\);/);
  // The cli_run auth copy happens AFTER admission so a parked run copies the
  // rotated token, never the pre-refresh one.
  assert.match(server, /const runOnce = async \(\): Promise<CliRunRecord> => \{[\s\S]*?grokIsolation = await createGrokTurnIsolation\(id, '', \{ allowNativeTools: mode === 'agentic' \}\);/);
});
