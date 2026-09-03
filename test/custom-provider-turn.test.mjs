import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_PROVIDER_TIMEOUT_MAX_MS,
  customProviderTurnTimeoutMs,
  startCustomProviderProgress,
} from '../src/custom-provider-turn.ts';

test('custom-provider timeout honors the server dial within safe bounds', () => {
  assert.equal(customProviderTurnTimeoutMs(720_000, 900_000), 720_000);
  assert.equal(customProviderTurnTimeoutMs(undefined, 900_000), 900_000);
  assert.equal(customProviderTurnTimeoutMs(1, 900_000), 30_000);
  assert.equal(customProviderTurnTimeoutMs(Number.MAX_SAFE_INTEGER, 900_000), CUSTOM_PROVIDER_TIMEOUT_MAX_MS);
});

test('custom-provider progress is correlated, elapsed proof-of-life and stops cleanly', () => {
  let tick = null;
  let cleared = null;
  let now = 1_000;
  const events = [];
  const stop = startCustomProviderProgress({
    id: 'turn-1',
    emit: event => events.push(event),
    intervalMs: 5_000,
    now: () => now,
    setIntervalFn: callback => { tick = callback; return { unref() {} }; },
    clearIntervalFn: timer => { cleared = timer; },
  });
  now = 6_000;
  tick();
  assert.deepEqual(events, [{ id: 'turn-1', elapsed_ms: 5_000 }]);
  stop();
  assert.ok(cleared);
});
