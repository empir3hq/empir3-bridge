/**
 * bridge_reliability_smoke trusted-click check runs in a scratch tab
 * (Work Board 533bec00): the caller's live tab is never navigated and is
 * re-activated afterwards, so unsaved in-page state survives the smoke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { runTrustedClickCheck, CLICK_TEST_URL, EXPECTED_RESULT } = require_('../src/smoke-click-check.js');

function fakeBridge({ clickResult = EXPECTED_RESULT, failCreate = false } = {}) {
  const log = [];
  let current = 'LIVE';
  return {
    log,
    adapter: {
      currentTargetId: async () => current,
      createTab: async (url) => { log.push(['create', url]); if (failCreate) throw new Error('Target.createTarget failed'); current = 'SCRATCH'; return 'SCRATCH'; },
      click: async (x, y) => { log.push(['click', current, x, y]); },
      evaluate: async (expr) => { log.push(['evaluate', current, expr]); return { result: clickResult }; },
      closeTab: async (id) => { log.push(['close', id]); if (current === id) current = ''; },
      activate: async (id) => { log.push(['activate', id]); current = id; },
      sleep: async () => {},
    },
    current: () => current,
  };
}

test('passes on a trusted click without ever navigating or clicking the live tab', async () => {
  const b = fakeBridge();
  const r = await runTrustedClickCheck(b.adapter);
  assert.equal(r.ok, true);
  assert.equal(r.detail.scratchTab, 'SCRATCH');
  assert.equal(r.detail.restoredTab, 'LIVE');
  assert.ok(!b.log.some(([op]) => op === 'navigate'), 'no navigate call exists on the adapter at all');
  assert.deepEqual(b.log.filter(([op]) => op === 'click').map(([, tab]) => tab), ['SCRATCH'], 'the click landed in the scratch tab');
  assert.equal(b.log[0][1], CLICK_TEST_URL, 'scratch tab opens straight on the data: page');
  assert.deepEqual(b.log.slice(-2), [['close', 'SCRATCH'], ['activate', 'LIVE']], 'scratch closed, live tab restored, in that order');
  assert.equal(b.current(), 'LIVE');
});

test('a synthetic click is reported as a failure, and the live tab is still restored', async () => {
  const b = fakeBridge({ clickResult: 'synthetic click' });
  const r = await runTrustedClickCheck(b.adapter);
  assert.equal(r.ok, false);
  assert.equal(r.detail.result, 'synthetic click');
  assert.deepEqual(b.log.slice(-2), [['close', 'SCRATCH'], ['activate', 'LIVE']]);
});

test('when the scratch tab cannot be created the check fails with the reason and touches nothing', async () => {
  const b = fakeBridge({ failCreate: true });
  const r = await runTrustedClickCheck(b.adapter);
  assert.equal(r.ok, false);
  assert.match(r.detail.error, /createTarget failed/);
  assert.ok(!b.log.some(([op]) => op === 'click' || op === 'close'));
  assert.equal(b.current(), 'LIVE');
});

test('server wires the smoke through the scratch-tab check and no longer navigates the live tab', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /const click = await runTrustedClickCheck\(\{/);
  assert.match(server, /createTab: async \(url\) => String\(\(await cdpPost\('\/create-tab', \{ url \}\)\)\?\.targetId \|\| ''\)/);
  assert.doesNotMatch(server, /The click-test navigates the active tab to a data: page/);
  assert.doesNotMatch(server, /if \(prevUrl\) \{\n\s*try \{ await cdpPost\('\/navigate', \{ url: prevUrl \}\); \} catch \{\}/);
});
