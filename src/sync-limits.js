/**
 * Sync limits — the frame-size and device-class rules for project-mirror sync.
 *
 * Why this module exists (I-002, host.empir3.com 2026-07-29): srv-01 drops any
 * WS frame over 5MB ("Message too large"). The sync loop capped files by their
 * ON-DISK size (10MB), but the frame that actually crosses the wire is
 * base64-encoded (×4/3) and JSON-escaped — a 4.47MB video became a 5,960,256-
 * byte frame the server dropped every time. The file re-queued forever, the
 * socket died ~2s after every connect, and because health beats still landed
 * each cycle the box LOOKED online on every dashboard while every real
 * feature was dead.
 *
 * Two rules fall out:
 *  1. The cap that matters is the ENCODED size, not the on-disk size — both a
 *     conservative pre-read cap (so we never read hopeless files) and an exact
 *     post-encode check (JSON escaping can double newline-heavy text).
 *  2. Headless servers skip mirror sync entirely: there is no user editing
 *     files on a VPS, and the mirror machinery is the only thing that made
 *     the socket cycle. One-off file ops are unaffected.
 */

'use strict';

/** srv-01's MAX_WS_MESSAGE_SIZE — frames over this are dropped, never delivered. */
const SYNC_SERVER_FRAME_CAP = 5 * 1024 * 1024;
/** Envelope keys, hash, project name, and headroom around the content field. */
const SYNC_FRAME_SLACK = 128 * 1024;
/** Max ENCODED content bytes per sync frame (base64 string or JSON-escaped text). */
const MAX_SYNC_CONTENT_BYTES = SYNC_SERVER_FRAME_CAP - SYNC_FRAME_SLACK;
/** Max on-disk bytes worth reading at all: base64 inflates 4/3, so anything
 *  bigger can never fit a frame regardless of content. */
const MAX_SYNC_FILE_BYTES = Math.floor(MAX_SYNC_CONTENT_BYTES * 3 / 4);

/** Extensions synced as base64 rather than utf-8 text. */
const SYNC_BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|eot|mp4|mp3|zip|pdf)$/i;

/**
 * Exact encoded size of a sync frame's content field, in bytes.
 * base64 needs no JSON escaping (its alphabet is escape-free); text must be
 * measured AFTER JSON.stringify — a newline-heavy file can double.
 */
function encodedSyncBytes(content, binary) {
  if (binary) return content.length;
  return Buffer.byteLength(JSON.stringify(content), 'utf8');
}

/** True when this file's encoded content fits under the server frame cap. */
function fitsSyncFrame(content, binary) {
  return encodedSyncBytes(content, binary) <= MAX_SYNC_CONTENT_BYTES;
}

/**
 * Whether project-mirror sync may run on this device at all.
 * Servers (headless deviceClass) never mirror — see the module header.
 */
function projectMirrorAllowed(profile) {
  return !profile || profile.deviceClass !== 'server';
}

module.exports = {
  SYNC_SERVER_FRAME_CAP,
  SYNC_FRAME_SLACK,
  MAX_SYNC_CONTENT_BYTES,
  MAX_SYNC_FILE_BYTES,
  SYNC_BINARY_EXT_RE,
  encodedSyncBytes,
  fitsSyncFrame,
  projectMirrorAllowed,
};
