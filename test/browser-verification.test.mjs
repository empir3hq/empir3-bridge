import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCURACY_LAB_TARGET_COUNT,
  MAX_BROWSER_CHECK_STEPS,
  accuracyLabStatsPass,
  compactBrowserStepResult,
  normalizeBrowserCheckPlan,
} from '../src/browser-verification.ts';

const server = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
const bridge = readFileSync(fileURLToPath(new URL('../src/bridge.ts', import.meta.url)), 'utf8');
const defaults = readFileSync(fileURLToPath(new URL('../src/tool-defaults.ts', import.meta.url)), 'utf8');

test('bounded browser check plans reject model-loop escape hatches', () => {
  assert.deepEqual(normalizeBrowserCheckPlan([
    { action: 'click_ref', params: { ref: 'e4' }, label: 'Open card' },
    { action: 'wait', params: { ms: 99_000 } },
    { action: 'text' },
  ]), [
    { action: 'click_ref', params: { ref: 'e4' }, label: 'Open card' },
    { action: 'wait', params: { ms: 2_000 } },
    { action: 'text', params: {} },
  ]);
  assert.throws(() => normalizeBrowserCheckPlan([{ action: 'navigate' }]), /unsupported action/);
  assert.throws(() => normalizeBrowserCheckPlan([{ action: 'evaluate' }]), /unsupported action/);
  assert.throws(() => normalizeBrowserCheckPlan(Array.from({ length: MAX_BROWSER_CHECK_STEPS + 1 }, () => ({ action: 'text' }))), /at most/);
});

test('step receipts omit bulky bridge payloads', () => {
  assert.deepEqual(compactBrowserStepResult({ success: true, text: 'x'.repeat(3_000), base64: 'secretly-huge' }), {
    success: true,
    text: 'x'.repeat(2_000),
  });
});

test('accuracy lab pass requires 103 trusted bridge-owned receipts', () => {
  const stats = {
    registeredTargets: ACCURACY_LAB_TARGET_COUNT,
    totalClicks: ACCURACY_LAB_TARGET_COUNT,
    hits: ACCURACY_LAB_TARGET_COUNT,
    uniqueHits: ACCURACY_LAB_TARGET_COUNT,
    misses: 0,
    remaining: 0,
    worstOffset: 1.9,
  };
  assert.equal(accuracyLabStatsPass(stats, ACCURACY_LAB_TARGET_COUNT), true);
  assert.equal(accuracyLabStatsPass(stats, 0), false);
  assert.equal(accuracyLabStatsPass({ ...stats, totalClicks: 0 }, ACCURACY_LAB_TARGET_COUNT), false);
});

test('Bridge wires the compact audit and batch through explicit safety gates', () => {
  assert.match(server, /audit_page: 'browser_audit_page'/);
  assert.match(server, /browser_audit_page: 'read'/);
  assert.match(server, /run_checks: 'browser_run_checks'/);
  assert.match(server, /browser_run_checks: 'execute'/);
  assert.match(server, /fullPage: 'true'/);
  assert.match(bridge, /params\.captureBeyondViewport = true/);
  assert.match(defaults, /name: 'browser_audit_page', group: 'read'/);
  assert.match(defaults, /name: 'browser_run_checks', group: 'interact'/);
});

test('Accuracy sweep uses distinct registered targets and real desktop clicks', () => {
  assert.match(server, /new Set\(probe\.ids\)\.size !== ACCURACY_LAB_TARGET_COUNT/);
  assert.match(server, /const click = await desktopClick/);
  assert.match(server, /proof\?\.last\?\.trusted === true/);
  assert.match(server, /trustedReceipts = receipts\.filter/);
  assert.match(defaults, /name: 'browser_accuracy_lab_sweep', group: 'desktop'/);
});
