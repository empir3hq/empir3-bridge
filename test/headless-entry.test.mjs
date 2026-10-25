import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shouldReapPredecessors, parsePairRequest } = require('../src/headless-entry.js');

test('standalone headless host retains stale predecessor cleanup by default', () => {
  assert.equal(shouldReapPredecessors({}), true);
});

test('a supervising desktop host can disable broad predecessor cleanup', () => {
  assert.equal(shouldReapPredecessors({ EMPIR3_SKIP_PREDECESSOR_REAP: '1' }), false);
});

test('no pairing request without a code', () => {
  assert.equal(parsePairRequest([], {}), null);
  assert.equal(parsePairRequest(['--pair-only'], {}), null);
  assert.equal(parsePairRequest(['--pair'], {}), null);
  assert.equal(parsePairRequest([], { EMPIR3_PAIR_CODE: '   ' }), null);
});

test('--pair <code> is an explicit argv request', () => {
  assert.deepEqual(parsePairRequest(['--pair', 'abc123'], {}), {
    code: 'abc123', source: 'argv', only: false,
  });
});

test('--pair-only makes the claim a one-shot (installer flow)', () => {
  assert.deepEqual(parsePairRequest(['--pair', 'abc123', '--pair-only'], {}), {
    code: 'abc123', source: 'argv', only: true,
  });
});

test('EMPIR3_PAIR_CODE is accepted from the environment and trimmed', () => {
  assert.deepEqual(parsePairRequest([], { EMPIR3_PAIR_CODE: ' abc123 ' }), {
    code: 'abc123', source: 'env', only: false,
  });
});

test('an explicit --pair beats the environment code', () => {
  assert.deepEqual(parsePairRequest(['--pair', 'argvcode'], { EMPIR3_PAIR_CODE: 'envcode' }), {
    code: 'argvcode', source: 'argv', only: false,
  });
});
