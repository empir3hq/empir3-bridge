import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shouldReapPredecessors } = require('../src/headless-entry.js');

test('standalone headless host retains stale predecessor cleanup by default', () => {
  assert.equal(shouldReapPredecessors({}), true);
});

test('a supervising desktop host can disable broad predecessor cleanup', () => {
  assert.equal(shouldReapPredecessors({ EMPIR3_SKIP_PREDECESSOR_REAP: '1' }), false);
});
