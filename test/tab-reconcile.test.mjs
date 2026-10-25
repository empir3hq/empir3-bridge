/**
 * Stale agent-control tab after a Chrome relaunch (Work Board 7e4b39ab).
 *
 * Observed on 0.3.99: browser_tab_focus({action:'show_agent'}) threw
 * "Target … not found" for a targetId destroyed in the relaunch while the live
 * tab on the same URL sat there flagged agentControlled:false, and
 * browser_tab_state kept returning the dead target. On current main the tab
 * targets are reconciled against the live list on every read and the
 * bridge-current tab becomes the agent target when none survives; this test
 * pins that behaviour so the card can be closed as already covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { reconcileTabTargets, findTabTarget, enrichTabState } = require_('../src/tab-activation.js');

const live = [{ targetId: 'NEW1', url: 'https://lab.test/run', title: 'Lab' }, { targetId: 'NEW2', url: 'https://other.test/', title: 'Other' }];
const fixedNow = () => new Date('2026-09-14T12:00:00Z');

test('a dead agent target is dropped and the bridge-current tab takes over', () => {
  const r = reconcileTabTargets({ tabs: live, currentTargetId: 'NEW1', agentControlTarget: { targetId: '3FC4EE49-DEAD', url: 'https://lab.test/run' }, userFocusTarget: null, now: fixedNow });
  assert.equal(r.droppedAgent, true);
  assert.equal(r.fellBack, true);
  assert.equal(r.agentControlTarget.targetId, 'NEW1');
  assert.equal(r.agentControlTarget.source, 'bridge-current');
  assert.equal(r.agentControlTarget.updatedAt, '2026-09-14T12:00:00.000Z');
});

test('the current tab is not taken from a user who explicitly holds it', () => {
  const r = reconcileTabTargets({ tabs: live, currentTargetId: 'NEW1', agentControlTarget: { targetId: 'DEAD' }, userFocusTarget: { targetId: 'NEW1' }, now: fixedNow });
  assert.equal(r.agentControlTarget, null);
  assert.equal(r.userFocusTarget.targetId, 'NEW1');
  assert.equal(r.fellBack, false);
});

test('a live agent target is kept as-is; nothing is invented', () => {
  const r = reconcileTabTargets({ tabs: live, currentTargetId: 'NEW1', agentControlTarget: { targetId: 'NEW2', source: 'mcp' }, userFocusTarget: null });
  assert.equal(r.agentControlTarget.targetId, 'NEW2');
  assert.equal(r.agentControlTarget.source, 'mcp');
  assert.equal(r.droppedAgent, false);
  assert.equal(r.fellBack, false);
  const none = reconcileTabTargets({ tabs: [], currentTargetId: '', agentControlTarget: { targetId: 'DEAD' }, userFocusTarget: null });
  assert.equal(none.agentControlTarget, null);
});

test('after reconciliation the reported state never names a dead target and show_agent has a live tab', () => {
  const r = reconcileTabTargets({ tabs: live, currentTargetId: 'NEW1', agentControlTarget: { targetId: 'DEAD' }, userFocusTarget: { targetId: 'ALSO-DEAD' }, now: fixedNow });
  const state = enrichTabState({ tabs: live, currentTargetId: 'NEW1', agentControlTarget: r.agentControlTarget, userFocusTarget: r.userFocusTarget });
  assert.ok(state.tabs.every((t) => live.some((l) => l.targetId === t.targetId)));
  assert.equal(state.agentTab.targetId, 'NEW1');
  assert.equal(state.agentTab.agentControlled, true);
  assert.equal(state.agentTab.bridgeCurrent, true);
  assert.equal(state.tabs.some((t) => t.userFocused), false, 'the dead user target is gone too');
});

test('findTabTarget matches by exact id first, then by URL for id-less hints', () => {
  assert.equal(findTabTarget(live, { targetId: 'NEW2' }).targetId, 'NEW2');
  assert.equal(findTabTarget(live, { targetId: 'DEAD', url: 'https://lab.test/run' }), null, 'an explicit dead id does not silently rebind by URL');
  assert.equal(findTabTarget(live, { url: 'https://lab.test/run' }).targetId, 'NEW1');
});

test('server reconciles on every tab-state read (show_agent path included)', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /const reconciled = reconcileTabTargets\(\{ tabs, currentTargetId, agentControlTarget, userFocusTarget \}\);/);
  assert.match(server, /pruneDeadTabTargets\(tabs, currentTargetId\);/);
  // setBrowserTabFocus reads browserTabState() before handling show_agent.
  const focus = server.slice(server.indexOf('async function setBrowserTabFocus('), server.indexOf('async function setBrowserTabFocus(') + 800);
  assert.ok(focus.indexOf('await browserTabState()') < focus.indexOf("if (action === 'show_agent')"));
});
