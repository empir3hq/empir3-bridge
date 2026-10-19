/**
 * Chunk large desktop:file:pull replies below the app server's 5 MiB
 * WebSocket frame ceiling. A single base64 reply above that ceiling is
 * discarded before CompanionToolService can resolve the request, so merely
 * extending the timeout can never make a large pull succeed.
 */

'use strict';

const { createHash } = require('crypto');

/** Leave ample room for the JSON envelope and future metadata. */
const FILE_PULL_SINGLE_FRAME_SAFE_CHARS = 3 * 1024 * 1024;
/** Multiple of four so every non-final slice remains valid base64. */
const FILE_PULL_CHUNK_CHARS = 2 * 1024 * 1024;

function buildChunkedFilePullTransfer(id, result, options = {}) {
  const data = typeof result?.data === 'string' ? result.data : '';
  const threshold = Number(options.thresholdChars || FILE_PULL_SINGLE_FRAME_SAFE_CHARS);
  const chunkChars = Number(options.chunkChars || FILE_PULL_CHUNK_CHARS);
  if (!id || result?.success === false || !data || data.length <= threshold) return null;
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 4 || chunkChars % 4 !== 0) {
    throw new Error('file-pull chunk size must be a positive multiple of four');
  }

  const totalChunks = Math.ceil(data.length / chunkChars);
  const frames = [];
  for (let index = 0; index < totalChunks; index += 1) {
    frames.push({
      type: 'desktop:file:pull:chunk',
      payload: {
        id,
        index,
        totalChunks,
        encoding: 'base64',
        data: data.slice(index * chunkChars, (index + 1) * chunkChars),
      },
    });
  }

  let raw;
  const suppliedSize = Number(result.sizeBytes);
  const sizeBytes = Number.isSafeInteger(suppliedSize) && suppliedSize >= 0
    ? suppliedSize
    : (raw = Buffer.from(data, 'base64')).byteLength;
  const suppliedSha256 = String(result.sha256 || '').toLowerCase();
  const sha256 = /^[a-f0-9]{64}$/.test(suppliedSha256)
    ? suppliedSha256
    : createHash('sha256').update(raw || Buffer.from(data, 'base64')).digest('hex');
  return {
    frames,
    final: {
      type: 'desktop:file:pull:result',
      payload: {
        id,
        success: true,
        chunked: true,
        encoding: 'base64',
        totalChunks,
        filename: result.filename,
        sizeBytes,
        sourcePath: result.sourcePath,
        sha256,
      },
    },
  };
}

module.exports = {
  FILE_PULL_SINGLE_FRAME_SAFE_CHARS,
  FILE_PULL_CHUNK_CHARS,
  buildChunkedFilePullTransfer,
};
