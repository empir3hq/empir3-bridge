/**
 * bridge_reliability_smoke result contract (Work Board 22e20910, P2).
 *
 * Observed on Linux: the MCP caller saw a bare "Command failed" while the
 * action log recorded {"type":"reliability_smoke","ok":true}. Both came from
 * one shape: `{ ok:false }` with no `success` and no `error`. The summary
 * module now owns the verdict; these tests pin that success/ok agree, that a
 * failure explains itself, that host-inapplicable checks are skipped rather
 * than failed, and that the receipt records what the caller saw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { summarizeSmokeChecks, receiptOutcome } = require_('../src/reliability-smoke-summary.js');

test('all applicable checks passing → success and ok both true, no error', () => {
  const r = summarizeSmokeChecks([
    { name: 'wrapper_status', ok: true },
    { name: 'trusted_control_boundary', ok: true },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.ok, true);
  assert.equal(r.passed, 2);
  assert.equal(r.total, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.error, undefined);
});

test('a failed check produces success:false AND a reason naming the check', () => {
  const r = summarizeSmokeChecks([
    { name: 'wrapper_status', ok: true },
    { name: 'browser_click_xy_trusted', ok: false, detail: 'CDP browser is not connected' },
  ]);
  assert.equal(r.success, false);
  assert.equal(r.ok, false);
  assert.match(r.error, /1 of 2 reliability check\(s\) failed/);
  assert.match(r.error, /browser_click_xy_trusted \(CDP browser is not connected\)/);
  assert.deepEqual(r.failures, [{ name: 'browser_click_xy_trusted', error: 'CDP browser is not connected' }]);
});

test('desktop checks on a host without desktop control are skipped, not failed', () => {
  const reason = 'desktop control unavailable on this host — this is a Wayland session (Omarchy) with no X11 display for synthetic input. …';
  const r = summarizeSmokeChecks([
    { name: 'wrapper_status', ok: true },
    { name: 'desktop_monitors', ok: true, skipped: true, reason },
    { name: 'desktop_screenshot_primary', ok: true, skipped: true, reason },
    { name: 'trusted_control_boundary', ok: true },
  ], { desktop: { available: false, code: 'wayland_no_x11' } });
  assert.equal(r.success, true);
  assert.equal(r.skipped, 2);
  assert.equal(r.total, 2, 'skipped checks are not counted as applicable');
  assert.equal(r.passed, 2);
  assert.deepEqual(r.skippedChecks.map((c) => c.name), ['desktop_monitors', 'desktop_screenshot_primary']);
  assert.equal(r.skippedChecks[0].reason, reason);
  assert.equal(r.desktop.code, 'wayland_no_x11');
});

test('receipt outcome matches the caller: ok:false counts as failure with the result error', () => {
  assert.deepEqual(receiptOutcome({ ok: false, error: '2 of 3 reliability check(s) failed: x (y)' }), { ok: false, error: '2 of 3 reliability check(s) failed: x (y)' });
  assert.deepEqual(receiptOutcome({ success: false, error: 'Permission denied: Write disabled' }), { ok: false, error: 'Permission denied: Write disabled' });
  assert.deepEqual(receiptOutcome({ ok: false }), { ok: false, error: 'command reported failure without an error message' });
  assert.deepEqual(receiptOutcome({ success: true, ok: true }), { ok: true, error: undefined });
  assert.deepEqual(receiptOutcome({ url: 'https://example.com' }), { ok: true, error: undefined });
  assert.deepEqual(receiptOutcome(undefined), { ok: true, error: undefined });
});

test('server wires the summary into the smoke and the receipt into the action log', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.ok(server.includes('return summarizeSmokeChecks(checks, {'), 'smoke returns the shared summary');
  assert.ok(server.includes('const outcome = receiptOutcome(result);'), 'receipt uses receiptOutcome');
  assert.ok(!server.includes("ok: result?.success !== false,\n      elapsedMs"), 'old receipt verdict removed');
});
