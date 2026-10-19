'use strict';

const assert = require('node:assert/strict');

// Called only for the disposable packaged scale sibling, after its real Chrome
// has started. Uses the relay-style browser contract that older Mac packages
// lacked, not an unrelated direct-CDP success as a substitute.
async function runBrowserSmoke(base, expectedVersion, { navigationTimeoutMs = 15000, navigationPollMs = 200 } = {}) {
  const parsed = new URL(base);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.notEqual(parsed.port, '3006');
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const command = async (action, params = {}) => {
    const response = await request('/api/command', { type: 'desktop:browse', action, params });
    assert.ok(response.ok, JSON.stringify(response));
    return response.result;
  };
  const state = await request('/api/settings/state');
  const safety = state.bridge.globalSafety;
  let target;
  try {
    await request('/api/settings/state', { bridge: { globalSafety: { ...safety, read: true, write: true, execute: true } } });
    const before = await command('tab_state');
    const status = await command('status');
    assert.equal(status.version, expectedVersion);
    const opened = await command('tab_open', { url: base + '/control-lab' });
    assert.equal(opened.success, true, JSON.stringify(opened));
    target = opened.target;
    assert.ok(target.tabId);
    // tab_open returns its exact target before the new document necessarily
    // finishes loading. Wait only for this owned fixture, with a firm deadline.
    const navigationDeadline = Date.now() + navigationTimeoutMs;
    while (true) {
      const observed = await command('control_observe', { target, image: false });
      assert.equal(observed.success, true, JSON.stringify(observed));
      if (/Bridge control lab/.test(observed.observation.text)) break;
      assert.ok(Date.now() < navigationDeadline, 'Owned Bridge control lab did not become ready before navigation deadline');
      await new Promise(resolve => setTimeout(resolve, navigationPollMs));
    }
    const steps = [
      { action: 'fill', locator: { selector: '#name' }, value: 'Packaged browser acceptance', expect: { kind: 'value', equals: 'Packaged browser acceptance' } },
      { action: 'select', locator: { selector: '#team' }, value: 'colva', expect: { kind: 'value', equals: 'colva' } },
    ];
    const allowed = await command('control_run', { target, steps });
    assert.equal(allowed.success, true, JSON.stringify(allowed));
    assert.ok(allowed.receipts.every(receipt => receipt.verified));
    await request('/api/settings/state', { bridge: { globalSafety: { ...safety, read: true, write: false, execute: false } } });
    const denied = await command('control_run', { target, steps });
    assert.equal(denied.success, false, 'Input must remain refused when permissions are disabled');
    assert.match(JSON.stringify(denied), /denied|denies|disabled/i);
    await request('/api/settings/state', { bridge: { globalSafety: { ...safety, read: true, write: true, execute: true } } });
    const after = await command('tab_state');
    for (const tab of before.tabs) assert.ok(after.tabs.some(next => next.targetId === tab.targetId && next.url === tab.url), 'Existing tab must be preserved');
    const closed = await command('tab_close', { target });
    assert.notEqual(closed.success, false, JSON.stringify(closed));
    const final = await command('tab_state');
    assert.ok(!final.tabs.some(tab => tab.targetId === target.tabId));
    target = null;
    return { relayActions: true, exactTarget: true, priorTabsPreserved: true, fill: true, select: true, permissionRefusal: true, closedOwnTab: true, version: status.version };
  } finally {
    try {
      if (target) {
        await request('/api/settings/state', { bridge: { globalSafety: { ...safety, read: true, write: true, execute: true } } });
        await command('tab_close', { target });
      }
    } finally {
      await request('/api/settings/state', { bridge: { globalSafety: safety } });
    }
  }
}

module.exports = { runBrowserSmoke };
