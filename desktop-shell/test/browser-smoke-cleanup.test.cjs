'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runBrowserSmoke } = require('../src/browser-smoke.cjs');

test('browser smoke restores permissions even when cleanup cannot close its tab', async () => {
  const originalFetch = global.fetch;
  const safety = { read: true, write: false, execute: false };
  const settingsWrites = [];
  const actions = [];
  global.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    let data;
    if (url.endsWith('/api/settings/state')) {
      if (body) settingsWrites.push(body.bridge.globalSafety);
      data = { bridge: { globalSafety: safety } };
    } else {
      actions.push(body.action);
      if (body.action === 'control_observe') throw Error('fixture observation failure');
      if (body.action === 'tab_close') throw Error('fixture cleanup failure');
      const result = body.action === 'tab_state' ? { tabs: [] }
        : body.action === 'status' ? { version: 'fixture' }
        : { success: true, target: { surface: 'browser', tabId: 'owned-fixture' } };
      data = { ok: true, result };
    }
    return { ok: true, json: async () => data };
  };
  try {
    await assert.rejects(runBrowserSmoke('http://127.0.0.1:54321', 'fixture'), /fixture cleanup failure/);
    assert.ok(actions.includes('tab_close'));
    assert.deepEqual(settingsWrites.at(-1), safety);
  } finally {
    global.fetch = originalFetch;
  }
});

for (const ready of [true, false]) {
  test(`browser smoke ${ready ? 'waits for its document then checks permission refusal' : 'times out an unready document without input and cleans up'}`, async () => {
    const originalFetch = global.fetch;
    const safety = { read: true, write: false, execute: false };
    let currentSafety = safety;
    let observations = 0;
    let inputs = 0;
    let closed = false;
    const target = { surface: 'browser', tabId: 'owned-fixture' };
    global.fetch = async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      let data;
      if (url.endsWith('/api/settings/state')) {
        if (body) currentSafety = body.bridge.globalSafety;
        data = { bridge: { globalSafety: safety } };
      } else {
        let result;
        switch (body.action) {
          case 'status': result = { version: 'fixture' }; break;
          case 'tab_state': result = { tabs: [] }; break;
          case 'tab_open': result = { success: true, target }; break;
          case 'control_observe':
            assert.deepEqual(body.params.target, target);
            observations++;
            result = { success: true, observation: { text: ready && observations > 1 ? 'Bridge control lab' : '' } };
            break;
          case 'control_run':
            inputs++;
            result = currentSafety.write ? { success: true, receipts: [{ verified: true }] } : { success: false, error: 'Input disabled' };
            break;
          case 'tab_close': closed = true; result = { success: true }; break;
          default: throw Error(`Unexpected fixture action ${body.action}`);
        }
        data = { ok: true, result };
      }
      return { ok: true, json: async () => data };
    };
    try {
      const run = runBrowserSmoke('http://127.0.0.1:54321', 'fixture', { navigationTimeoutMs: ready ? 1000 : 0, navigationPollMs: 1 });
      if (ready) {
        assert.equal((await run).permissionRefusal, true);
        assert.equal(observations, 2);
        assert.equal(inputs, 2);
      } else {
        await assert.rejects(run, /navigation deadline/);
        assert.equal(inputs, 0);
      }
      assert.equal(closed, true);
      assert.deepEqual(currentSafety, safety);
    } finally {
      global.fetch = originalFetch;
    }
  });
}
