'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Execute the actual startup function without Electron, network or processes.
const source = readFileSync(join(__dirname, '../src/main.cjs'), 'utf8');
const start = source.indexOf('async function startOrAttachBridge() {');
const end = source.indexOf('\nfunction stopManagedBridge()', start);
assert.ok(start >= 0 && end > start);

function startup({ smoke, responding }) {
  const events = [];
  const child = { stdout: {}, stderr: {}, once() {} };
  const context = {
    SMOKE_MODE: smoke, ports: { wrapper: 54321 },
    fetchJson: async () => { if (!responding) throw Error('connection refused'); return { ok: true }; },
    statusUrl: () => 'http://127.0.0.1:54321/api/status',
    attachedToExistingBridge: false, bridgeRoot: 'fixture',
    app: { isPackaged: true }, process: { execPath: 'fixture' },
    resolveRuntimeEntry: () => 'fixture-entry',
    resolveRuntimeCommand: () => ({ executable: 'fixture', extraEnv: {} }),
    makeRuntimeEnvironment: () => ({}),
    spawn: () => { events.push('spawn'); return child; },
    logChild() {}, waitForBridge: async () => { events.push('wait'); },
    console: { log() {} }, fileLogger: null,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.start = startOrAttachBridge;', context);
  return { context, events };
}

test('smoke refuses an existing wrapper before spawning or waiting', async () => {
  const { context, events } = startup({ smoke: true, responding: true });
  await assert.rejects(context.start(), /refuses to attach to an existing Bridge/);
  assert.deepEqual(events, []);
  assert.equal(context.attachedToExistingBridge, false);
});

test('normal startup attaches to an existing wrapper without spawning', async () => {
  const { context, events } = startup({ smoke: false, responding: true });
  await context.start();
  assert.deepEqual(events, []);
  assert.equal(context.attachedToExistingBridge, true);
});

test('smoke starts its managed runtime when the probe is unavailable', async () => {
  const { context, events } = startup({ smoke: true, responding: false });
  await context.start();
  assert.deepEqual(events, ['spawn', 'wait']);
  assert.equal(context.attachedToExistingBridge, false);
});

test('scale smoke never stops an already running sibling', async () => {
  const begin = source.indexOf('async function runScaleSmoke() {');
  const finish = source.indexOf('\nfunction showPane(', begin);
  const actions = [];
  const safety = { read: true, write: false, execute: false };
  const context = vm.createContext({
    bridgeRequest: async (path, options) => {
      if (path === '/api/settings/state') return { bridge: { globalSafety: safety } };
      actions.push(options.body.action);
      return { ok: true, result: { success: true, instances: [{ index: 2, running: true, note: 'already running' }] } };
    },
  });
  vm.runInContext(source.slice(begin, finish) + '\nthis.start = runScaleSmoke;', context);
  await assert.rejects(context.start(), /Packaged scale-up failed/);
  assert.deepEqual(actions, ['up']);
});
