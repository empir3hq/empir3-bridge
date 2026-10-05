/**
 * Three things that made agent-driven QA lie to the agent — smoke 2026-09-15.
 *
 * These are source contracts rather than live-driving tests: reproducing them
 * needs a running Chrome, an emulated device and a flaky capture. What can be
 * pinned cheaply is that each mechanism is present and reachable, so a later
 * edit cannot quietly undo them.
 *
 *  1f29b85e — the driven tab reported document.visibilityState 'hidden' after
 *             browser_navigate, and browser_status never said so. Everything the
 *             page gates on visibility went quiet, and the agent read a frozen
 *             UI as a product bug. It cost this smoke a false "stuck loading"
 *             finding that resolved the instant the tab was activated.
 *
 *  fc799543 — browser_screenshot returned a bare 500 on ~half its first calls
 *             (an immediate identical retry always worked), and screenshots
 *             appeared nowhere in bridge_action_log — successes or failures — so
 *             the tool whose job is "read recent receipts for debugging failed
 *             tool calls" could not debug them.
 *
 *  50477945 — with device emulation active, every click failed with
 *             `CDP gesture timeout: Input.dispatchTouchEvent`. Click tools
 *             deliberately switch to touch under emulation because RN-Web
 *             ignores mouse events there, so there was NO working click at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');

/** The `case 'status':` body, as the relay contract test also slices it. */
function statusBody() {
  const start = server.indexOf("case 'status': {", server.indexOf('async function executeCommand('));
  assert.ok(start > 0, "status case not found");
  return server.slice(start, server.indexOf("case 'bridge_scale':", start));
}

test('1f29b85e — browser_status reports whether the driven tab is visible', () => {
  const body = statusBody();
  assert.match(body, /document\.visibilityState/, 'status must probe visibility');
  assert.match(body, /visibilityState/, 'and report it');
  assert.match(body, /hasFocus/, 'focus too — a visible-but-unfocused tab still suppresses some work');
});

test('1f29b85e — the visibility probe can never fail a status call', () => {
  const body = statusBody();
  const probeAt = body.indexOf('document.visibilityState');
  const catchAt = body.indexOf('catch', probeAt);
  assert.ok(catchAt > probeAt, 'the probe must sit inside a try/catch');
});

test('1f29b85e — the status case stays free of TypeScript-only syntax', () => {
  // relay-browser-status.test.mjs eval's this body as plain JS in a vm. A type
  // annotation here breaks it with "Unexpected token ':'" — which is exactly
  // what the first draft of this fix did.
  const body = statusBody();
  assert.doesNotMatch(body, /\blet\s+\w+\s*:\s*\{/, 'no typed let declarations');
  assert.doesNotMatch(body, /\bas\s+any\b/, 'no `as` assertions');
});

test('1f29b85e — navigate tells the caller when the page it loaded is not visible', () => {
  const start = server.indexOf("case 'navigate': {");
  assert.ok(start > 0);
  const body = server.slice(start, start + 4000);
  assert.match(body, /document\.visibilityState/, 'navigate probes visibility');
  assert.match(body, /bridge_control_activate/, 'and names the remedy rather than just the symptom');
});

test('fc799543 — a transient 5xx on an idempotent read is retried, not surfaced raw', () => {
  const start = server.indexOf('async function cdpGetRaw');
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf('async function cdpPost', start));
  assert.match(body, /res\.status >= 500/, 'retries a 5xx');
  assert.match(body, /attempt < 2/, 'bounded, not an infinite retry');
  assert.match(body, /\$\{res\.status\} \$\{text\}/, 'and the thrown error carries the body');
});

test('fc799543 — screenshots leave a receipt, pass or fail', () => {
  const start = server.indexOf("case 'screenshot': {");
  assert.ok(start > 0);
  const body = server.slice(start, start + 3000);
  const receipts = body.match(/recordActionReceipt\(/g) || [];
  assert.equal(receipts.length, 2, 'one receipt on success, one on failure');
  assert.match(body, /ok: true/);
  assert.match(body, /ok: false/);
});

test('fc799543 — a screenshot receipt never carries the image itself', () => {
  const start = server.indexOf("case 'screenshot': {");
  const body = server.slice(start, start + 3000);
  // Inspect ONLY the receipt object literals. An earlier draft of this test
  // sliced a fixed window and caught the `return { ... base64 ... }` below them,
  // which is the legitimate response payload — the receipt is what must stay lean.
  let from = 0;
  let checked = 0;
  for (;;) {
    const call = body.indexOf('recordActionReceipt({', from);
    if (call === -1) break;
    const close = body.indexOf('} as any);', call);
    assert.ok(close > call, 'receipt literal should terminate');
    const literal = body.slice(call, close);
    assert.doesNotMatch(literal, /base64/, 'a receipt log is not a frame buffer');
    assert.doesNotMatch(literal, /screenshot:/, 'no image payload on the receipt');
    checked += 1;
    from = close;
  }
  assert.equal(checked, 2, 'both receipts inspected');
});

test('50477945 — touch is enabled on the session that dispatches the gesture', () => {
  assert.match(bridge, /Emulation\.setTouchEmulationEnabled/, 'touch must be enabled per gesture session');
  const tapAt = bridge.indexOf('async function tapAtXY');
  assert.ok(tapAt > 0);
  const tap = bridge.slice(tapAt, tapAt + 900);
  assert.match(tap, /ensureTouchOnSession/, 'tap enables touch before dispatching');
  assert.ok(
    tap.indexOf('ensureTouchOnSession') < tap.indexOf('dispatchTouchEvent'),
    'and does it BEFORE the dispatch, which is the whole point',
  );
});

test('50477945 — enabling touch can never break a gesture that would have worked', () => {
  const at = bridge.indexOf('async function ensureTouchOnSession');
  assert.ok(at > 0);
  const fn = bridge.slice(at, at + 600);
  assert.match(fn, /catch/, 'an older target refusing the command must not fail the tap');
});

test('50477945 — a touch timeout explains itself and names a way forward', () => {
  assert.match(bridge, /Touch input did not complete/, 'honest message, not a bare CDP string');
  assert.match(bridge, /desktop_click/, 'and points at the escalation that does work');
});
