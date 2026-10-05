import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createBrowserTabIdentityGuard } from '../src/browser-tab-identity.js';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
function harness() {
  const tabs = [{ targetId: 'user', url: 'https://editor.example/edit' }, { targetId: 'second', url: 'https://editor.example/edit' }];
  const dispatched = [];
  let current = 'user';
  let userId = 'alice';
  const context = vm.createContext({ createBrowserTabIdentityGuard,
    readBridgeAuth: () => ({ serverUrl: 'https://app.example', user: { id: userId } }),
    readBridgeSettings: () => ({ deviceId: 'test-device' }),
    listBrowserTabs: async () => ({ tabs, currentTargetId: current }),
    browserTabState: async () => ({ tabs, currentTargetId: current }),
    executeCommand: async cmd => {
      dispatched.push(cmd);
      if (cmd.type === 'tab_open') { const tabId = 'own'; tabs.push({ targetId: tabId, url: 'https://editor.example/work' }); current = tabId; return { success: true, target: { surface: 'browser', tabId } }; }
      if (cmd.type === 'tab_close') { tabs.splice(tabs.findIndex(t => t.targetId === cmd.target.tabId), 1); return { closed: true }; }
      if (cmd.target && cmd.target.tabId !== current) throw Error('target_not_current');
      return { success: true };
    },
    controlRuntime: { exclusive: (_, fn) => fn() },
  });
  const ownership = source.slice(source.indexOf('const agentTabs ='), source.indexOf('async function runAgentAttributedCommand'));
  const actions = source.slice(source.indexOf('async function handleAgentBrowserAction('), source.indexOf('function normalizeDesktopRelayMessage('));
  vm.runInContext(transformSync(ownership + actions, { loader: 'ts' }).code, context);
  return { tabs, dispatched, account: id => { userId = id; }, current: id => { current = id; },
    call: (action, params = {}) => context.handleAgentBrowser(action, { agentId: 'vincent', ...params }) };
}

test('shipping relay rejects untargeted input with two live same-site tabs before dispatch', async () => {
  const h = harness();
  for (const action of ['click','click_xy','click_ref','click_selector','type','type_ref','type_selector','press','scroll','tap','swipe','control_run','run_checks','play','evaluate']) {
    const r = await h.call(action, { key: 'Space' });
    assert.equal(r.code, 'browser_tab_identity_required', action);
    assert.equal(r.inputMayHaveOccurred, false);
  }
  assert.equal(h.dispatched.length, 0);
});
test('unowned same-origin target is refused; an agent-created target persists across calls', async () => {
  const h = harness();
  assert.equal((await h.call('press', { target: { surface: 'browser', tabId: 'user' }, key: 'Space' })).success, false);
  const opened = await h.call('tab_open', { url: 'https://editor.example/work' });
  await h.call('press', { target: opened.target, key: 'Space' });
  await h.call('press', { target: opened.target, key: 'Escape' });
  assert.equal(h.dispatched.length, 3);
  assert.equal(h.dispatched.at(-1).target.tabId, 'own');
});
test('all legacy input aliases preserve their explicit tab guard instead of changing the current tab', async () => {
  const h = harness();
  const opened = await h.call('tab_open', { url: 'https://editor.example/work' });
  h.current('user');
  for (const action of ['click','click_xy','click_ref','click_selector','type','type_ref','type_selector','press','scroll','tap','swipe','evaluate','play']) {
    await assert.rejects(h.call(action, { target: opened.target, selector: '#name', key: 'Space' }), /target_not_current/, action);
  }
});
test('ownership never crosses agent or account', async () => {
  const h = harness();
  const opened = await h.call('tab_open', { url: 'https://editor.example/work' });
  assert.equal((await h.call('press', { target: opened.target, agentId: 'koba' })).success, false);
  h.account('bob');
  assert.equal((await h.call('press', { target: opened.target })).success, false);
  h.account('alice');
  assert.equal((await h.call('press', { target: opened.target })).success, false);
});
test('explicit close removes ownership even when a tab id is later reused', async () => {
  const h = harness();
  const opened = await h.call('tab_open', { url: 'https://editor.example/work' });
  await h.call('tab_close', { target: opened.target });
  h.tabs.push({ targetId: opened.target.tabId, url: 'https://editor.example/another-edit' });
  assert.equal((await h.call('press', { target: opened.target })).success, false);
});
test('relay scroll keeps signed deltas, including zero, and supports explicit direction', async () => {
  const h = harness(); const opened = await h.call('tab_open', { url: 'https://editor.example/work' });
  for (const [params, y] of [[{y:-300},-300],[{dy:-200},-200],[{amount:0},0],[{amount:200,direction:'up'},-200]]) {
    await h.call('scroll', { target: opened.target, ...params });
    assert.equal(h.dispatched.at(-1).y, y);
  }
});
test('read/lifecycle calls and unknown or different origins are not mistaken for ambiguous input', () => {
  const guard = createBrowserTabIdentityGuard();
  const state = { tabs: [{ targetId: 'one', url: 'https://one.example' }, { targetId: 'two', url: 'https://two.example' }] };
  for (const action of ['control_observe','screenshot','snapshot','text','tab_state','tab_focus','control_activate','tab_close','navigate']) assert.equal(guard.check(action, {}, state, 'alice'), null);
  assert.equal(guard.check('press', { targetId: 'one' }, state, 'alice'), null);
  state.tabs[1].url = '';
  assert.equal(guard.check('press', { targetId: 'one' }, state, 'alice'), null);
  guard.remember('alice', 'one');
  guard.check('snapshot', {}, { tabs: [] }, 'alice');
  state.tabs[1].url = 'https://one.example/other';
  assert.equal(guard.check('press', { targetId: 'one' }, state, 'alice').success, false);
});
