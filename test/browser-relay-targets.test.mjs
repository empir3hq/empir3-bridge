import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { createBrowserTabIdentityGuard } from '../src/browser-tab-identity.js';
import { findTabTarget, waitForActivation } from '../src/tab-activation.js';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
function harness() {
  const tabs = [{ targetId: 'legacy', url: 'https://old.example/' }, { targetId: 'chosen', url: 'https://chosen.example/' }];
  let current = 'legacy';
  const calls = [];
  const state = async () => ({ tabs, currentTargetId: current });
  const context = vm.createContext({ Buffer, Date, Math, findTabTarget, waitForActivation, createBrowserTabIdentityGuard,
    readBridgeAuth: () => ({ user: { id: 'test' } }), readBridgeSettings: () => ({ deviceId: 'test' }),
    controlRuntime: { exclusive: (_, fn) => fn(), checkLease: () => {}, check: () => {} }, sanitizeAgentName: x => x,
    isComputerCommand: () => true, requiredBridgePermission: cmd => cmd.type === 'screenshot' ? 'read' : 'execute',
    agentControlTarget: null, userFocusTarget: null,
    listBrowserTabs: state, browserTabState: state, broadcastBrowserTabState: async () => {},
    sameTabTarget: (a,b) => a?.targetId && a.targetId === b?.targetId,
    enforceCommandPolicy: () => null, validateTarget: t => t,
    controlServices: { target: async (t, input) => {
      if (!tabs.some(x => x.targetId === t.tabId)) throw Error('target_closed');
      if (input && context.userFocusTarget?.targetId === t.tabId) throw Error('target_owned_by_user');
      if (input && t.tabId !== current) throw Error('target_not_current');
    } },
    recordActionReceipt: () => {},
    cdpGetRaw: async (path, params) => { calls.push([path, params]); return Buffer.from(params.targetId || current); },
    cdpPost: async (path, params) => {
      calls.push([path, params]);
      if (path === '/activate-target') { current = params.targetId; return { targetId: current }; }
      throw Error(`Unexpected CDP mutation: ${path}`);
    },
    executeCommandCore: async (cmd, from) => {
      if (cmd.type === 'browser_tab_focus') return context.setBrowserTabFocus(cmd, from);
      calls.push(['execute', cmd]);
      if (cmd.target) await context.controlServices.target(cmd.target);
      if (cmd.type === 'navigate') {
        const tab = tabs.find(t => t.targetId === (cmd.target?.tabId || current));
        tab.url = cmd.url;
      }
      return { success: true };
    },
  });
  const ownership = source.slice(source.indexOf('const agentTabs ='), source.indexOf('function parseCdpJson'));
  const actions = source.slice(source.indexOf('async function handleAgentBrowserAction('), source.indexOf('function normalizeDesktopRelayMessage('));
  const focus = source.slice(source.indexOf('async function setBrowserTabFocus('), source.indexOf('\n}', source.indexOf('async function setBrowserTabFocus(')) + 2);
  const execute = source.slice(source.indexOf('async function executeCommand('), source.indexOf('\nfunction controlCatalog('));
  vm.runInContext(transformSync(ownership + actions + focus + execute, { loader: 'ts' }).code + '\nglobalThis.owned = agentTabs;', context);
  return { context, tabs, calls, current: () => current,
    call: (action, params = {}) => context.handleAgentBrowser(action, { agentId: 'test', ...params }) };
}

test('normalized relay focus defaults to control, while direct focus retains user handoff', async () => {
  const h = harness();
  const result = await h.call('tab_focus', { target: { tabId: 'chosen', surface: 'browser' } });
  assert.equal(result.switched, true);
  assert.equal(h.current(), 'chosen');
  assert.equal(h.context.agentControlTarget.targetId, 'chosen');
  await h.call('click_ref', { target: { surface: 'browser', tabId: 'chosen' }, ref: 'e1_0' });
  assert.equal(h.calls.at(-1)[1].target.tabId, 'chosen');
  await h.context.setBrowserTabFocus({ targetId: 'chosen' }, 'direct');
  assert.equal(h.context.userFocusTarget.targetId, 'chosen');
  assert.equal(h.context.agentControlTarget, null);
  await assert.rejects(h.call('tab_focus', { target: { tabId: 'closed', surface: 'browser' } }), /target_closed/);
});

test('explicit and controlled screenshot/navigation never reactivate legacy ownership or create a tab', async () => {
  const h = harness();
  await h.call('tab_focus', { target: { tabId: 'chosen', surface: 'browser' } });
  h.context.owned.set('test', { targetId: 'legacy', agentName: 'Test' });
  h.calls.length = 0;
  const image = await h.call('screenshot');
  assert.equal(Buffer.from(image.base64, 'base64').toString(), 'chosen');
  const oldImage = await h.call('screenshot', { target: { tabId: 'legacy', surface: 'browser' } });
  assert.equal(Buffer.from(oldImage.base64, 'base64').toString(), 'legacy');
  assert.equal(h.current(), 'chosen');
  await h.call('navigate', { url: 'https://chosen.example/next' });
  assert.equal(h.tabs[0].url, 'https://old.example/');
  assert.equal(h.tabs[1].url, 'https://chosen.example/next');
  assert.equal(h.tabs.length, 2);
  assert.equal(h.calls.some(([path]) => ['/activate-target','/create-tab','/tab-badge'].includes(path)), false);
  h.tabs.pop();
  await assert.rejects(h.call('screenshot'), /target_closed/);
  await assert.rejects(h.call('navigate', { url: 'https://wrong.example/' }), /target_closed/);
  assert.equal(h.tabs[0].url, 'https://old.example/');
});

test('upload preserves the exact array and single-file wire shapes through the input guard', async () => {
  const h = harness();
  const target = { surface: 'browser', tabId: 'chosen' };
  await h.call('tab_focus', { target });
  const files = [{ filename: 'résumé.txt', mimeType: 'text/plain', data: 'YWJj' }];
  await h.call('upload_file', { target, selector: '#files', files, ...files[0] });
  assert.equal(h.calls.at(-1)[1].type, 'upload_file');
  assert.equal(h.calls.at(-1)[1].files, files);
  assert.equal(h.calls.at(-1)[1].target, target);
  await h.call('upload_file', { target, ref: 'e2_0', ...files[0] });
  assert.equal(h.calls.at(-1)[1].ref, 'e2_0');
  assert.equal(h.calls.at(-1)[1].data, 'YWJj');
  const before = h.calls.length;
  assert.equal((await h.call('upload_file', { files })).code, 'browser_tab_identity_required');
  assert.equal(h.calls.length, before);
});

test('targeted navigation preserves user ownership; upload still requires the current input target', async () => {
  const h = harness();
  const target = { surface: 'browser', tabId: 'chosen' };
  await h.call('navigate', { target, url: 'https://chosen.example/next' });
  assert.equal(h.current(), 'legacy');
  assert.equal(h.tabs[1].url, 'https://chosen.example/next');
  await assert.rejects(h.call('upload_file', { target, filename: 'a', data: '' }), /target_not_current/);
  h.context.userFocusTarget = { targetId: 'chosen' };
  await assert.rejects(h.call('navigate', { target, url: 'https://wrong.example/' }), /target_owned_by_user/);
  assert.equal(h.tabs[1].url, 'https://chosen.example/next');
  await h.call('tab_focus', { target });
  assert.equal(h.context.userFocusTarget, null);
  await assert.rejects(h.call('navigate', { target: { surface: 'desktop', tabId: 'chosen' }, url: 'https://wrong.example/' }), /target_mismatch/);
});
