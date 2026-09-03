import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseCodexJsonl } = require('../src/codex-jsonl.js');

test('Codex JSONL parser returns the final agent message', () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'agent_message', text: 'first' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'));
  assert.equal(parsed.text, 'final');
  assert.equal(parsed.failed, false);
  assert.equal(parsed.eventCount, 4);
});

test('Codex JSONL parser treats a zero-exit turn.failed event as failure', () => {
  const providerError = JSON.stringify({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', message: 'Upgrade the Codex CLI' },
  });
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }),
    JSON.stringify({ type: 'error', message: providerError }),
    JSON.stringify({ type: 'turn.failed', error: { message: providerError } }),
  ].join('\n'));
  assert.equal(parsed.text, '');
  assert.equal(parsed.failed, true);
  assert.equal(parsed.failure, 'Upgrade the Codex CLI');
});

test('Codex JSONL parser leaves non-JSON legacy output available for fallback', () => {
  const parsed = parseCodexJsonl('plain legacy output');
  assert.equal(parsed.eventCount, 0);
  assert.equal(parsed.text, '');
  assert.equal(parsed.failed, false);
});
