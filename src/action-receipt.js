/**
 * Action-receipt result summary (Work Board 11283366).
 *
 * bridge_action_log is the sanctioned way for an agent to debug a failed or
 * uncertain tool call. Screenshot-producing tools return their image as
 * base64 under several keys (thumbnail / screenshot / base64 / data.*), and
 * a receipt that carried any of them cost ~14k characters per entry — reading
 * the log to debug one failure meant paying for every screenshot before it.
 *
 * summarizeResult() copies only the small, diagnostic fields of a result into
 * the receipt (URLs, flags, paths, capture bounds, monitor ids). Image bytes
 * are never among them; captures[].path is, so the file is still reachable.
 * compactReceipt() in control-runtime.js is the second line: any key that
 * still looks like an image blob is replaced with "[image omitted]".
 */

'use strict';

const RECEIPT_RESULT_KEYS = ['url', 'clicked', 'moved', 'dragged', 'cursor', 'coordinateSpace', 'path', 'monitor', 'stitchedPath', 'running', 'engine', 'refreshed', 'highlighted', 'pressed', 'sent', 'scrolled', 'scope', 'command', 'exitCode', 'stage', 'switched', 'inputState', 'shellHeldByChild'];
const IMAGE_KEY_RE = /^(base64|thumbnail|screenshot|imageData|dataUrl|buffer|data|png|jpeg|jpg|webp)$/i;

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return undefined;
  const out = {};
  for (const key of RECEIPT_RESULT_KEYS) {
    if (result[key] === undefined) continue;
    if (IMAGE_KEY_RE.test(key)) continue;
    const value = result[key];
    // A string longer than a path or URL has no business in a receipt.
    if (typeof value === 'string' && value.length > 1000) { out[key] = `[${value.length} chars omitted]`; continue; }
    out[key] = value;
  }
  if (Array.isArray(result.captures)) {
    out.captures = result.captures.map((c) => ({ id: c?.id, path: c?.path, bounds: c?.bounds, ...(c?.width && c?.height ? { size: `${c.width}x${c.height}` } : {}) }));
  }
  if (Array.isArray(result.monitors)) {
    out.monitors = result.monitors.map((m) => ({ id: m?.id, primary: m?.primary, bounds: m?.bounds }));
  }
  if (result.image && typeof result.image === 'object' && (result.image.path || result.image.mimeType)) {
    out.image = { path: result.image.path, mimeType: result.image.mimeType, width: result.image.width, height: result.image.height, bytes: result.image.bytes };
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when a serialized receipt still carries something that looks like image bytes. */
function receiptCarriesImageBlob(receipt) {
  const text = JSON.stringify(receipt ?? '');
  return /data:image\//.test(text) || /"(base64|thumbnail|screenshot|imageData|dataUrl)":"[A-Za-z0-9+/=]{200,}/.test(text);
}

module.exports = { summarizeResult, receiptCarriesImageBlob, RECEIPT_RESULT_KEYS };
