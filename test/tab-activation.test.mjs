/**
 * Verified tab activation (Work Board 22e20910, P2).
 *
 * Observed: bridge_control_activate returned success:true with
 * agentControlled:false / bridgeCurrent:false and the next browser_evaluate
 * still hit the old tab; two browser_tab_focus calls for equivalent state
 * returned contradictory flags. The activation outcome is now derived from a
 * fresh tab-list readback and the flags from that same read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { enrichTabState, activationOutcome, waitForActivation } = require_('../src/tab-activation.js');

const tabs = [
  { targetId: 'A', url: 'https://a.test/', title: 'A' },
  { targetId: 'B', url: 'https://b.test/', title: 'B' },
];

test('activationOutcome reports switched only when the bridge current target IS the requested tab', () => {
  const ok = activationOutcome({ tabs, currentTargetId: 'B' }, 'B');
  assert.equal(ok.switched, true);
  assert.equal(ok.error, undefined);
  assert.equal(ok.tab.targetId, 'B');

  const notYet = activationOutcome({ tabs, currentTargetId: 'A' }, 'B');
  assert.equal(notYet.switched, false);
  assert.match(notYet.error, /activation_unverified: the bridge is still on A instead of B/);
  assert.match(notYet.error, /browser_tab_focus action:"control"/);

  const closed = activationOutcome({ tabs, currentTargetId: 'A' }, 'Z');
  assert.equal(closed.switched, false);
  assert.equal(closed.tab, null);
  assert.match(closed.error, /target_closed: tab Z/);
});

test('waitForActivation polls until the switch lands and returns the final outcome', async () => {
  let reads = 0;
  const readState = async () => ({ tabs, currentTargetId: ++reads >= 3 ? 'B' : 'A' });
  let clock = 0;
  const outcome = await waitForActivation(readState, 'B', { settleMs: 1000, pollMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(outcome.switched, true);
  assert.equal(reads, 3);
});

test('waitForActivation gives up honestly when the switch never lands', async () => {
  let reads = 0;
  let clock = 0;
  const outcome = await waitForActivation(async () => { reads++; return { tabs, currentTargetId: 'A' }; }, 'B', { settleMs: 500, pollMs: 100, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(outcome.switched, false);
  assert.match(outcome.error, /activation_unverified/);
  assert.ok(reads >= 5 && reads <= 7, `polled within the settle window (${reads} reads)`);
});

test('waitForActivation stops immediately when the tab is gone', async () => {
  let reads = 0;
  const outcome = await waitForActivation(async () => { reads++; return { tabs, currentTargetId: 'A' }; }, 'Z', { settleMs: 500, pollMs: 100, sleep: async () => {} });
  assert.equal(outcome.switched, false);
  assert.equal(reads, 1);
  assert.match(outcome.error, /target_closed/);
});

test('enrichTabState derives every flag from one read and surfaces agentTab', () => {
  const state = enrichTabState({ tabs, currentTargetId: 'B', agentControlTarget: { targetId: 'B' }, userFocusTarget: { targetId: 'A' }, agentTabs: [] });
  assert.deepEqual(state.tabs.map((t) => [t.targetId, t.agentControlled, t.userFocused, t.bridgeCurrent]), [['A', false, true, false], ['B', true, false, true]]);
  assert.equal(state.agentTab.targetId, 'B');
  assert.equal(state.agentTab.bridgeCurrent, true);
  assert.deepEqual(state.agentTabs, []);
  // Same input twice → identical flags (no hidden state between calls).
  const again = enrichTabState({ tabs, currentTargetId: 'B', agentControlTarget: { targetId: 'B' }, userFocusTarget: { targetId: 'A' }, agentTabs: [] });
  assert.deepEqual(again.tabs, state.tabs);
  assert.equal(enrichTabState({ tabs, currentTargetId: 'A', agentControlTarget: null, userFocusTarget: null }).agentTab, null);
});
