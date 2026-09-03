import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSanitizedBridgeLogTail, sanitizeBridgeLogLine } from '../src/bridge-log-tail.ts';

test('remote Bridge log lines redact credentials and home paths', () => {
  const line = 'C:\\Users\\vault\\.grok Bearer abc.def.ghi? token=abc123 xai-supersecretvalue123';
  const clean = sanitizeBridgeLogLine(line, 'C:\\Users\\vault');
  assert.match(clean, /%USERPROFILE%/);
  assert.match(clean, /Bearer \[REDACTED\]/);
  assert.match(clean, /token=\[REDACTED\]/);
  assert.match(clean, /\[REDACTED_KEY\]/);
  assert.doesNotMatch(clean, /supersecret|C:\\Users\\vault/i);
});

test('remote Bridge log tail is bounded and never returns its file path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-log-tail-'));
  const path = join(root, 'bridge.log');
  try {
    await writeFile(path, Array.from({ length: 30 }, (_, index) => `line-${index}`).join('\n'), 'utf8');
    const result = readSanitizedBridgeLogTail({ path, lines: 10, home: root });
    assert.equal(result.source, 'bridge.log');
    assert.equal(result.lines.length, 10);
    assert.equal(result.lines[0], 'line-20');
    assert.equal(Object.hasOwn(result, 'path'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote Bridge log tail falls back to bounded action receipts', () => {
  const result = readSanitizedBridgeLogTail({
    path: join(tmpdir(), `missing-${Date.now()}.log`),
    lines: 10,
    actionLines: ['one', 'two'],
  });
  assert.equal(result.source, 'action-log');
  assert.deepEqual(result.lines, ['one', 'two']);
});
