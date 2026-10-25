/**
 * bridge_action_log carries no image bytes (Work Board 11283366): a
 * desktop_screenshot_zoom entry used to embed a ~14k base64 blob. Receipts
 * keep paths, bounds and flags only; compactReceipt() is the second guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { summarizeResult, receiptCarriesImageBlob } = require_('../src/action-receipt.js');
const { compactReceipt } = require_('../src/control-runtime.js');

const blob = 'iVBORw0KGgo' + 'A'.repeat(14_000);
// Shape returned by desktopScreenshotZoom (server.ts): the same base64 under
// thumbnail / screenshot / base64 and again nested under data.
const zoomResult = {
  success: true,
  captures: [{ id: 'DISPLAY1', path: 'C:/Users/me/.empir3-bridge/feedback/zoom-1.png', bounds: { x: 0, y: 0, width: 240, height: 240 }, width: 240, height: 240 }],
  stitchedPath: 'C:/Users/me/.empir3-bridge/feedback/zoom-1.png',
  thumbnail: blob,
  screenshot: blob,
  base64: blob,
  data: { thumbnail: blob, screenshot: blob, base64: blob, mimeType: 'image/png' },
  center: { x: 100, y: 100 },
  radius: 120,
};

test('summarizeResult keeps the file path and drops every image payload key', () => {
  const s = summarizeResult(zoomResult);
  assert.equal(s.captures[0].path, 'C:/Users/me/.empir3-bridge/feedback/zoom-1.png');
  assert.equal(s.captures[0].size, '240x240');
  assert.equal(s.stitchedPath, zoomResult.stitchedPath);
  for (const key of ['thumbnail', 'screenshot', 'base64', 'data']) assert.equal(key in s, false, `${key} must not be in the receipt`);
  assert.ok(JSON.stringify(s).length < 400, `receipt is small (${JSON.stringify(s).length} chars)`);
  assert.equal(receiptCarriesImageBlob(s), false);
});

test('a receipt that went through summarizeResult + compactReceipt has no blob even for unexpected keys', () => {
  const weird = { ...zoomResult, screenshot: undefined, png: blob, dataUrl: `data:image/png;base64,${blob}` };
  const receipt = compactReceipt({ type: 'desktop_screenshot_zoom', ok: true, result: summarizeResult(weird) });
  assert.equal(receiptCarriesImageBlob(receipt), false);
  assert.ok(JSON.stringify(receipt).length < 600);
});

test('non-image results keep their diagnostic fields', () => {
  const s = summarizeResult({ url: 'https://example.com/x', clicked: true, exitCode: 0, stage: 'done', inputState: 'dispatched' });
  assert.deepEqual(s, { url: 'https://example.com/x', clicked: true, exitCode: 0, stage: 'done', inputState: 'dispatched' });
  assert.equal(summarizeResult(null), undefined);
  assert.equal(summarizeResult({ irrelevant: 1 }), undefined);
});

test('server records receipts through the shared summariser', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /import \{ summarizeResult \} from '\.\/action-receipt\.js';/);
  assert.match(server, /result: summarizeResult\(result\),/);
  assert.doesNotMatch(server, /^function summarizeResult\(/m, 'the old inline summariser is gone');
});
