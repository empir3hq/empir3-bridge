import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const wrapper = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const tabs = bridge.slice(bridge.indexOf("    if (method === 'GET' && path === '/tabs')"), bridge.indexOf('    // ── POST endpoints'));
const update = wrapper.match(/function updateCdpReachabilityFromBody[\s\S]*?\n\}/)?.[0];
assert.ok(tabs && update, 'shipping tab handler and wrapper reachability update are required');

async function observe({ targets = [], cached = [], failure = false, closed = false } = {}) {
  const context = vm.createContext({
    method: 'GET', path: '/tabs', res: {}, CDP_PORT: 49002,
    fetchJSON: async () => {
      if (failure) throw new Error('CDP unavailable');
      return targets;
    },
    sleep: () => new Promise(() => {}),
    knownTargets: new Map(cached), currentTargetId: 'live', tabBadges: new Map(),
    chromeStatus: () => 'exited', chromeClosedByUser: closed,
    bridgeReachable: true, cdpConnected: true,
  });
  context.sendJSON = (_res, data) => {
    context.payload = data;
    context.updateCdpReachabilityFromBody('/tabs', data);
  };
  vm.runInContext(transformSync(`${update}\nasync function readTabs() {\n${tabs}\n}`, { loader: 'ts' }).code, context);
  await context.readTabs();
  return context;
}

test('fresh live tabs preserve browser readiness after the Chrome launcher exits', async () => {
  const result = await observe({ targets: [{ id: 'live', type: 'page', url: 'http://127.0.0.1/control-lab' }] });
  assert.equal(result.payload.chrome, 'running');
  assert.equal(result.payload.tabs.length, 1);
  assert.equal(result.cdpConnected, true);
});

test('cached tabs alone cannot revive an exited browser', async () => {
  const result = await observe({ cached: [['old', 'https://example.test/']] });
  assert.equal(result.payload.tabs.length, 1);
  assert.equal(result.payload.chrome, 'exited');
  assert.equal(result.cdpConnected, false);
});

test('unreachable and empty browsers remain unavailable', async () => {
  for (const failure of [false, true]) {
    const result = await observe({ failure });
    assert.equal(result.payload.tabs.length, 0);
    assert.equal(result.cdpConnected, false);
  }
});

test('tab reporting preserves an explicit closed-browser latch', async () => {
  const result = await observe({ closed: true, targets: [{ id: 'live', type: 'page' }] });
  assert.equal(result.payload.closedByUser, true);
  assert.equal(result.cdpConnected, false);
});
