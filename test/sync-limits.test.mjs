/**
 * Sync limits — the I-002 contract.
 *
 * The bug these pin: srv-01 drops WS frames over 5MB, but the sync loop
 * capped files by ON-DISK size (10MB). A 4.47MB video base64-inflated to a
 * 5,960,256-byte frame the server dropped every time; the file re-queued
 * forever and the socket cycled 1006 while health beats kept landing — the
 * box looked online on every dashboard while every real feature was dead.
 *
 * Two rules under test:
 *  1. Caps are computed on the ENCODED size (base64 ×4/3, JSON escaping for
 *     text) and the pre-read cap makes the exact poisoned file unreadable.
 *  2. Headless servers never run mirror sync at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SYNC_SERVER_FRAME_CAP,
  MAX_SYNC_CONTENT_BYTES,
  MAX_SYNC_FILE_BYTES,
  SYNC_BINARY_EXT_RE,
  encodedSyncBytes,
  fitsSyncFrame,
  projectMirrorAllowed,
} = require('../src/sync-limits.js');

test('the exact poisoned file (4.47MB video) is over the pre-read cap', () => {
  const poisonedBytes = 4.47 * 1024 * 1024;
  assert.ok(
    poisonedBytes > MAX_SYNC_FILE_BYTES,
    `a ${poisonedBytes}B file must exceed the ${MAX_SYNC_FILE_BYTES}B cap — this is the file that killed host.empir3.com's socket`,
  );
  assert.ok(SYNC_BINARY_EXT_RE.test('.mp4'), 'the poisoned file type is classified binary');
});

test('any file passing the pre-read cap fits a frame once base64-encoded', () => {
  // Worst case: a binary file at exactly the cap.
  const encoded = Math.ceil(MAX_SYNC_FILE_BYTES / 3) * 4;
  assert.ok(
    encoded <= MAX_SYNC_CONTENT_BYTES,
    `base64(${MAX_SYNC_FILE_BYTES}) = ${encoded} must fit in ${MAX_SYNC_CONTENT_BYTES}`,
  );
  assert.ok(
    MAX_SYNC_CONTENT_BYTES < SYNC_SERVER_FRAME_CAP,
    'content cap leaves envelope headroom under the server frame cap',
  );
});

test('encodedSyncBytes measures base64 content as-is', () => {
  const b64 = Buffer.alloc(3000).toString('base64'); // 4000 chars
  assert.equal(encodedSyncBytes(b64, true), 4000);
});

test('encodedSyncBytes measures text AFTER JSON escaping — newline-heavy text can double', () => {
  const raw = '\n'.repeat(1000);
  const measured = encodedSyncBytes(raw, false);
  assert.ok(measured >= 2000, `1000 newlines escape to >= 2000 bytes (got ${measured})`);
});

test('fitsSyncFrame catches a text file whose ON-DISK size passes but whose escaped size does not', () => {
  // On disk this is comfortably under MAX_SYNC_FILE_BYTES; JSON-escaped it
  // doubles past the content cap. The on-disk cap alone would have sent a
  // frame the server drops — exactly the I-002 failure mode, text edition.
  const raw = '\n'.repeat(MAX_SYNC_FILE_BYTES - 1024);
  assert.ok(raw.length <= MAX_SYNC_FILE_BYTES, 'fixture sanity: passes the pre-read cap');
  assert.equal(fitsSyncFrame(raw, false), false);
});

test('a normal source file fits', () => {
  const raw = 'export const x = 1;\n'.repeat(5000); // ~100KB
  assert.equal(fitsSyncFrame(raw, false), true);
});

test('servers never mirror; workstations do; a missing profile fails open for compat', () => {
  assert.equal(projectMirrorAllowed({ deviceClass: 'server' }), false);
  assert.equal(projectMirrorAllowed({ deviceClass: 'workstation' }), true);
  assert.equal(projectMirrorAllowed(null), true);
});
