import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROVIDER_MAX_CONCURRENT,
  ProviderConcurrencyGate,
} from '../src/provider-concurrency.ts';

test('one Grok pool admits five mixed jobs, rejects the sixth, then reopens', () => {
  const gate = new ProviderConcurrencyGate();
  const leases = [
    gate.tryAcquire('cli:grok', 'turn-1', 5),
    gate.tryAcquire('cli:grok', 'research-1', 5),
    gate.tryAcquire('cli:grok', 'turn-2', 5),
    gate.tryAcquire('cli:grok', 'research-2', 5),
    gate.tryAcquire('cli:grok', 'turn-3', 5),
  ];

  assert.equal(DEFAULT_PROVIDER_MAX_CONCURRENT, 5);
  assert.ok(leases.every(Boolean));
  assert.deepEqual(gate.snapshot('cli:grok', 5), {
    isolated_sessions: true,
    max_active: 5,
    active: 5,
  });
  assert.equal(gate.tryAcquire('cli:grok', 'turn-6', 5), null);

  // Independent providers do not consume one another's channels.
  const spark = gate.tryAcquire('custom:spark', 'turn-6', 2);
  assert.ok(spark);
  assert.equal(gate.snapshot('custom:spark', 2).active, 1);

  leases[1].release();
  const replacement = gate.tryAcquire('cli:grok', 'turn-6', 5);
  assert.ok(replacement);
  assert.equal(gate.snapshot('cli:grok', 5).active, 5);

  // Release handles are idempotent, including the slot that was replaced.
  leases[1].release();
  replacement.release();
  for (const lease of leases) lease?.release();
  spark.release();
  assert.equal(gate.snapshot('cli:grok', 5).active, 0);
  assert.equal(gate.snapshot('custom:spark', 2).active, 0);
});

test('provider concurrency is configurable through 512 channels but bounded', () => {
  const gate = new ProviderConcurrencyGate();
  assert.equal(gate.snapshot('custom:qwen', '7').max_active, 7);
  assert.equal(gate.snapshot('custom:qwen', '999').max_active, 512);
  assert.equal(gate.snapshot('custom:qwen', 'invalid').max_active, 5);
});
