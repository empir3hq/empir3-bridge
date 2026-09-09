import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Execute the actual server routing functions with an in-memory CDP boundary.
// This reproduces relay action sequences without starting a second daemon.
function harness() {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const agentTabs ='), source.indexOf('function parseCdpJson'));
  const tabs = [{ targetId: 'chat', url: 'https://app.empir3.com/chat/test' }, { targetId: 'console', url: 'http://localhost:3006/welcome' }];
  const calls = [];
  let current = 'chat';
  const context = vm.createContext({
    sanitizeAgentName: name => name,
    userFocusTarget: null, agentControlTarget: null,
    listBrowserTabs: async () => ({ tabs: [...tabs], currentTargetId: current }),
    broadcastBrowserTabState: async () => {},
    handleAgentBrowserAction: async (action, params) => {
      calls.push(['action', action, current]);
      if (action === 'navigate' || action === 'open') tabs.find(t => t.targetId === current).url = params.url;
      return { success: true, browserRunning: true, version: '0.3.112' };
    },
    cdpPost: async (path, params) => {
      calls.push([path, params]);
      if (path === '/create-tab') { current = `agent-${tabs.length}`; tabs.push({ targetId: current, url: params.url }); return tabs.at(-1); }
      if (path === '/activate-target') { current = params.targetId; return {}; }
      if (path === '/close-target') { const i = tabs.findIndex(t => t.targetId === params.targetId); if (i >= 0) tabs.splice(i, 1); return { closed: i >= 0 }; }
      return {};
    },
  });
  vm.runInContext(transformSync(code, { loader: 'ts', target: 'node18' }).code + '\nglobalThis.run = runAgentAttributedCommand; globalThis.owned = agentTabs;', context);
  return { tabs, calls, context, run: (action, params = {}) => context.run('ceo', action, { agentName: 'Vincent', ...params }) };
}

test('status then open preserves chat and console; status acquires no ownership', async () => {
  const h = harness();
  await h.run('status');
  assert.equal(h.context.owned.size, 0);
  assert.equal(h.calls.length, 1);
  const result = await h.run('open', { url: 'https://example.com' });
  assert.equal(result.createdTab, true);
  assert.equal(h.tabs.length, 3);
  assert.equal(h.tabs[0].url, 'https://app.empir3.com/chat/test');
  assert.equal(h.tabs[1].targetId, 'console');
});

test('snapshot does not silently claim the current page; close without ownership preserves it', async () => {
  const h = harness();
  await h.run('snapshot');
  await h.run('close');
  assert.equal(h.context.owned.size, 0);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.calls.some(c => c[0] === '/tab-badge' || c[0] === '/close-target'), false);
});

test('each open creates a separate page; navigate and close affect only the latest owned page', async () => {
  const h = harness();
  const first = await h.run('open', { url: 'https://example.com/one' });
  const second = await h.run('open', { url: 'https://example.com/two' });
  assert.notEqual(first.targetId, second.targetId);
  await h.run('navigate', { url: 'https://example.com/three' });
  assert.equal(h.tabs.find(t => t.targetId === first.targetId).url, 'https://example.com/one');
  assert.equal(h.tabs.find(t => t.targetId === second.targetId).url, 'https://example.com/three');
  await h.run('close');
  assert.equal(h.tabs.length, 3);
  assert.equal(h.tabs.some(t => t.targetId === 'chat'), true);
});

test('status never activates an owned tab, and user focus still blocks navigation', async () => {
  const h = harness();
  const opened = await h.run('open', { url: 'https://example.com' });
  h.calls.length = 0;
  h.context.userFocusTarget = { targetId: opened.targetId };
  await h.run('status');
  assert.equal(h.calls.length, 1);
  const result = await h.run('navigate', { url: 'https://example.com/changed' });
  assert.equal(result.success, false);
  assert.equal(h.tabs.at(-1).url, 'https://example.com');
});
