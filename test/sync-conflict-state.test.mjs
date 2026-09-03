/**
 * Conflict-sidecar containment + the durable base version.
 *
 * The storm these pin (board fe5808bc / cf13a0de / aefd1a16 / 0ba01198): with
 * no record of which version was last synced, EVERY server push onto an
 * existing byte-different local file parked a `.server-conflict-*` sidecar and
 * left the plain file stale — including the ordinary case where the local file
 * was simply the previous server version. Sidecars then synced as ordinary
 * files, reseeding every mirror. 402 sidecars on one machine in ten days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { readFileSync as read } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const {
  SYNC_STATE_FILE,
  isSyncConflictArtifact,
  lastSyncedHash,
  recordSyncedHash,
  lastParkedHash,
  recordParkedHash,
  forgetSyncedPath,
  flushSyncState,
} = require('../src/sync-conflict-state.js');

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = read(join(here, '../src/server.ts'), 'utf-8');

test('every sidecar shape observed in the field is an artifact', () => {
  assert.equal(isSyncConflictArtifact('series/04-the-specials.server-conflict-1787022349360.html'), true);
  assert.equal(isSyncConflictArtifact('src/BlockRenderer.server-conflict-1787135550123.tsx'), true);
  assert.equal(isSyncConflictArtifact('custom-cards-and-merch-model.local-conflict-bridge-585fd99c--1786948430492.html'), true);
  assert.equal(isSyncConflictArtifact('package-lock.local-conflict-bridge-875cffaf--1787079237610.json'), true);
  assert.equal(isSyncConflictArtifact('src\\pages\\index.server-conflict-1787000000000.html'), true);
});

test('ordinary files are not artifacts', () => {
  assert.equal(isSyncConflictArtifact('src/BlockRenderer.tsx'), false);
  assert.equal(isSyncConflictArtifact('package-lock.json'), false);
  // The phrase in a DIRECTORY must not quarantine the files inside it.
  assert.equal(isSyncConflictArtifact('docs.server-conflict-notes/readme.md'), false);
  assert.equal(isSyncConflictArtifact('notes/merge-conflict-guide.md'), false);
  assert.equal(isSyncConflictArtifact(''), false);
});

test('synced hash round-trips and survives a flush to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-state-'));
  assert.equal(lastSyncedHash(dir, 'src/App.tsx'), undefined);
  recordSyncedHash(dir, 'src/App.tsx', 'aaa111');
  assert.equal(lastSyncedHash(dir, 'src/App.tsx'), 'aaa111');
  flushSyncState(dir);
  const onDisk = JSON.parse(readFileSync(join(dir, SYNC_STATE_FILE), 'utf-8'));
  assert.equal(onDisk.files['src/App.tsx'], 'aaa111');
  assert.equal(existsSync(join(dir, `${SYNC_STATE_FILE}.tmp`)), false);
});

test('a parked conflict is remembered once, and clears when copies re-agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-state-'));
  recordParkedHash(dir, 'index.html', 'server-v2');
  assert.equal(lastParkedHash(dir, 'index.html'), 'server-v2');
  // The user resolved it (or content re-agreed) — parked marker must clear so
  // a genuinely NEW conflict later parks a fresh sidecar.
  recordSyncedHash(dir, 'index.html', 'server-v2');
  assert.equal(lastParkedHash(dir, 'index.html'), undefined);
  assert.equal(lastSyncedHash(dir, 'index.html'), 'server-v2');
});

test('a deleted file loses its base version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-state-'));
  recordSyncedHash(dir, 'old.txt', 'bbb222');
  forgetSyncedPath(dir, 'old.txt');
  assert.equal(lastSyncedHash(dir, 'old.txt'), undefined);
});

test('server.ts wiring: sidecars and state files never enter the sync manifest', () => {
  const fn = serverSrc.slice(
    serverSrc.indexOf('function shouldIgnoreSyncPath'),
    serverSrc.indexOf('function fileSha256'),
  );
  assert.ok(fn.includes('isSyncConflictArtifact(rel)'));
  assert.ok(fn.includes('SYNC_STATE_FILE'));
});

test('server.ts wiring: the write path decides by base version, and parks once', () => {
  const fn = serverSrc.slice(
    serverSrc.indexOf('function writeCompanionProjectFile'),
    serverSrc.indexOf('async function handleFileCommand'),
  );
  // Three-way: unmodified-since-last-sync overwrites in place.
  assert.ok(fn.includes('lastSyncedHash(projectDir, rel) !== existingHash'));
  // Re-pushes of already-parked content do not mint another sidecar.
  assert.ok(fn.includes('lastParkedHash(projectDir, rel) === nextHash'));
  assert.ok(fn.includes('alreadyParked: true'));
  // Sidecars stay out of the mirror bookkeeping (delete-reconciler safety).
  assert.ok(fn.includes('if (!conflict) {'));
});

test('server.ts wiring: the server ack records the accepted base version', () => {
  assert.ok(serverSrc.includes("type === 'sync:local:file:ack'"));
  const ack = serverSrc.slice(
    serverSrc.indexOf("type === 'sync:local:file:ack'"),
    serverSrc.indexOf("custom:llm:probe"),
  );
  assert.ok(ack.includes('payload?.accepted === true'));
  assert.ok(ack.includes('recordSyncedHash(projectDir, rel, payload.hash)'));
});
