import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  FILE_PULL_SINGLE_FRAME_SAFE_CHARS,
  buildChunkedFilePullTransfer,
} = require_('../src/file-pull-transfer.js');

test('a 12 MiB pull is split into frames below the app server ceiling', () => {
  const raw = Buffer.alloc(12 * 1024 * 1024, 'x');
  const data = raw.toString('base64');
  const transfer = buildChunkedFilePullTransfer('pull-12m', {
    success: true,
    filename: 'probe.txt',
    sourcePath: '/tmp/probe.txt',
    sizeBytes: raw.byteLength,
    data,
  });

  assert.ok(transfer);
  assert.ok(transfer.frames.length > 1);
  assert.equal(transfer.frames.map((frame) => frame.payload.data).join(''), data);
  for (const frame of transfer.frames) {
    assert.equal(frame.type, 'desktop:file:pull:chunk');
    assert.ok(Buffer.byteLength(JSON.stringify(frame), 'utf8') < 5 * 1024 * 1024);
  }
  assert.equal(transfer.final.payload.sizeBytes, raw.byteLength);
  assert.equal(
    transfer.final.payload.sha256,
    createHash('sha256').update(raw).digest('hex'),
  );
  assert.equal(Object.hasOwn(transfer.final.payload, 'data'), false);
});

test('small pulls keep the backwards-compatible single-result envelope', () => {
  const data = Buffer.alloc(1024, 'x').toString('base64');
  assert.ok(data.length < FILE_PULL_SINGLE_FRAME_SAFE_CHARS);
  assert.equal(buildChunkedFilePullTransfer('pull-small', { success: true, data }), null);
});

test('chunk boundaries must preserve base64 alignment', () => {
  assert.throws(
    () => buildChunkedFilePullTransfer(
      'pull-bad',
      { success: true, data: 'a'.repeat(100) },
      { thresholdChars: 1, chunkChars: 7 },
    ),
    /multiple of four/,
  );
});
