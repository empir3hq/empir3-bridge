/**
 * Conflict-sidecar naming + the durable last-synced base version.
 *
 * The storm this ends (board fe5808bc / cf13a0de / aefd1a16 / 0ba01198): the
 * bridge had no record of WHICH version of a file it last synced, so a server
 * push onto any existing, byte-different local file read as a two-writer
 * conflict — including the completely ordinary case where the local file was
 * simply the PREVIOUS server version. Every routine update parked a
 * `.server-conflict-<epoch>` sidecar and left the plain file stale; every
 * reconnect re-diffed the still-stale file and minted another. One machine
 * reached 402 sidecars in ten days.
 *
 * Two facts fix it, both kept here:
 *
 *  - `files`: rel → sha256 of the last content synced in either direction
 *    (server push written locally, or local upload the server ACKED). If the
 *    local file still hashes to that value, nobody edited it locally — a
 *    server push may overwrite it in place. If it doesn't, the divergence is
 *    a real local edit and parking a sidecar is the correct, data-preserving
 *    move.
 *  - `parked`: rel → sha256 of the last server content we parked as a
 *    sidecar. Re-pushes of the same content (every reconnect re-diffs stale
 *    files) are recognized and NOT parked again — one conflict is one
 *    sidecar, not one per reconnect.
 *
 * State lives in `.empir3-sync-state.json` at each project root — excluded
 * from the sync manifest exactly like `.empir3-project.json`. Losing it is
 * safe: with no entry the code falls back to the old park-a-sidecar behavior
 * and the entry re-establishes itself on the next content match or ack.
 */

const { readFileSync, writeFileSync, renameSync } = require('fs');
const { join, basename } = require('path');

const SYNC_STATE_FILE = '.empir3-sync-state.json';

/** Sidecar namespace both ends mint — the bridge's `.server-conflict-<epoch>`
 *  and the server's `.local-conflict-<device>-<epoch>`. Anchored to the
 *  basename so a directory containing the phrase cannot quarantine its files. */
const CONFLICT_ARTIFACT_RE = /\.(?:server|local)-conflict-[^/\\]*$/i;

/** True when a project-relative path is a sync conflict sidecar. */
function isSyncConflictArtifact(relPath) {
  const base = basename(String(relPath || '').replace(/\\/g, '/'));
  return CONFLICT_ARTIFACT_RE.test(base);
}

/** projectDir → { files: {rel: hash}, parked: {rel: hash} } */
const stateCache = new Map();
const flushTimers = new Map();
const FLUSH_DELAY_MS = 500;

function emptyState() {
  return { v: 1, files: {}, parked: {} };
}

function loadState(projectDir) {
  let state = stateCache.get(projectDir);
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, SYNC_STATE_FILE), 'utf-8'));
    state = (parsed && typeof parsed === 'object')
      ? { v: 1, files: parsed.files || {}, parked: parsed.parked || {} }
      : emptyState();
  } catch {
    state = emptyState();
  }
  stateCache.set(projectDir, state);
  return state;
}

function scheduleFlush(projectDir) {
  if (flushTimers.has(projectDir)) return;
  const timer = setTimeout(() => flushSyncState(projectDir), FLUSH_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(projectDir, timer);
}

/** Write pending state to disk now. Exposed for tests and shutdown paths;
 *  everything else rides the debounce (a reconnect hydrates hundreds of files
 *  — one JSON rewrite per file would be quadratic IO). Tmp-then-rename so a
 *  crash mid-write cannot leave a truncated file (a corrupt state file parses
 *  as empty and merely reverts to the old conservative behavior). */
function flushSyncState(projectDir) {
  const timer = flushTimers.get(projectDir);
  if (timer) { clearTimeout(timer); flushTimers.delete(projectDir); }
  const state = stateCache.get(projectDir);
  if (!state) return;
  try {
    const target = join(projectDir, SYNC_STATE_FILE);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, target);
  } catch { /* best effort — absent state only means the conservative path */ }
}

/** sha256 of the last content synced in either direction, or undefined. */
function lastSyncedHash(projectDir, rel) {
  return loadState(projectDir).files[rel];
}

/** Record that the canonical copies now agree on this content. Clears any
 *  parked marker — the conflict, if there was one, is over. */
function recordSyncedHash(projectDir, rel, hash) {
  const state = loadState(projectDir);
  if (state.files[rel] === hash && !(rel in state.parked)) return;
  state.files[rel] = hash;
  delete state.parked[rel];
  scheduleFlush(projectDir);
}

/** sha256 of the last server content parked as a sidecar for rel, or undefined. */
function lastParkedHash(projectDir, rel) {
  return loadState(projectDir).parked[rel];
}

/** Remember what was parked so an identical re-push is not parked again. */
function recordParkedHash(projectDir, rel, hash) {
  const state = loadState(projectDir);
  if (state.parked[rel] === hash) return;
  state.parked[rel] = hash;
  scheduleFlush(projectDir);
}

/** A locally deleted file has no base version to compare against any more. */
function forgetSyncedPath(projectDir, rel) {
  const state = stateCache.get(projectDir);
  if (!state) return;
  if (!(rel in state.files) && !(rel in state.parked)) return;
  delete state.files[rel];
  delete state.parked[rel];
  scheduleFlush(projectDir);
}

module.exports = {
  SYNC_STATE_FILE,
  isSyncConflictArtifact,
  lastSyncedHash,
  recordSyncedHash,
  lastParkedHash,
  recordParkedHash,
  forgetSyncedPath,
  flushSyncState,
};
