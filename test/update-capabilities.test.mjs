import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sourceModule from '../src/tray-command-state.ts';
const { updateCapabilities, trayConsumerActive, unavailableTrayCommandMessage } = sourceModule;
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const getUpdateCapabilities = () =>');
const end = source.indexOf('  // POST /api/tray/enqueue', start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule('async function handler() {' + source.slice(start, end) + '}', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function request({ platform = 'linux', label = '', managed = false, tray = false, path = 'apply' } = {}) {
  const writes = [], queue = [], manifests = [];
  let status, body;
  const context = vm.createContext({
    updateCapabilities: options => updateCapabilities({ platform, label, ...options }),
    process: { platform, env: {} }, existsSync: () => managed,
    HEADLESS_INSTALL_CONFIG: '/etc/fixture.json', HEADLESS_UPDATE_REQUEST_FILE: '/fixture/request',
    trayConsumerActive, unavailableTrayCommandMessage,
    lastTrayCommandPollAt: tray ? Date.now() : 0,
    url: { pathname: '/api/updates/' + path }, req: { method: path === 'apply' ? 'POST' : 'GET' },
    res: { writeHead: value => { status = value; }, end: text => { body = JSON.parse(text); } },
    mkdirSync() {}, dirname: () => '/fixture', chmodSync() {},
    writeFileSync: (...args) => writes.push(args), randomUUID: () => 'fixture-id',
    trayCommandQueue: queue, TRAY_COMMAND_MAX: 20,
    VERSION_MANIFEST_URL: 'https://fixture.invalid/legacy', BRIDGE_VERSION: '0.3.99',
    requestJson: async (_method, url) => { manifests.push(url); return { status: 200, body: { version: '0.3.130' } }; },
    isVersionNewer: () => true,
  });
  vm.runInContext(code, context);
  await context.handler();
  return { status, body, writes, queue, manifests };
}

test('unmanaged Linux detects releases but explicitly refuses apply without a phantom tray or queued work', async () => {
  const check = await request({ path: 'check' });
  assert.equal(check.body.newer, true);
  assert.equal(check.body.capabilities.canApply, false);
  assert.equal(check.manifests[0], 'https://app.empir3.com/downloads/bridge-desktop-version.json');
  const apply = await request();
  assert.equal(apply.status, 409);
  assert.equal(apply.body.code, 'update_requires_host_action');
  assert.match(apply.body.error, /original installation method/);
  assert.doesNotMatch(apply.body.error, /Windows|tray/);
  assert.equal(apply.writes.length + apply.queue.length, 0);
});

test('managed Linux writes one systemd request and exposes service-owned update policy', async () => {
  const result = await request({ managed: true });
  assert.equal(result.status, 202);
  assert.equal(result.body.method, 'systemd-path');
  assert.equal(result.writes.length, 1);
  assert.equal(result.queue.length, 0);
  const capability = await request({ managed: true, path: 'capabilities' });
  assert.equal(capability.body.capabilities.autoUpdateConfigurable, false);
  assert.match(capability.body.capabilities.policy, /timer/);
});

test('real legacy tray retains apply and policy while desktop package uses its signed installer flow', async () => {
  const tray = await request({ platform: 'win32', tray: true });
  assert.equal(tray.status, 200);
  assert.equal(tray.queue.length, 1);
  const oldChannel = await request({ platform: 'win32', tray: true, path: 'check' });
  assert.equal(oldChannel.manifests[0], 'https://fixture.invalid/legacy');
  assert.equal(oldChannel.body.capabilities.autoUpdateConfigurable, true);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const desktop = await request({ platform, label: 'DESKTOP', tray: true, managed: true });
    assert.equal(desktop.status, 409);
    assert.match(desktop.body.error, /Check for Updates/);
    assert.equal(desktop.queue.length + desktop.writes.length, 0);
  }
});
