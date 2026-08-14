'use strict';

const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const test = require('node:test');
const {
  DEVELOPMENT_PORTS,
  PRODUCTION_PORTS,
  externalNavigationCommand,
  isAllowedLocalUrl,
  makeRuntimeEnvironment,
  providerConsoleUrl,
  resolveBridgeRoot,
  resolvePorts,
  resolveRuntimeCommand,
  statusUrl,
  waitForBridge,
} = require('../src/runtime.cjs');

test('development and packaged shells use distinct intended default ports', () => {
  assert.deepEqual(resolvePorts({ isPackaged: false, env: {} }), DEVELOPMENT_PORTS);
  assert.deepEqual(resolvePorts({ isPackaged: true, env: {} }), PRODUCTION_PORTS);
});

test('port overrides are validated and cannot collide', () => {
  assert.deepEqual(resolvePorts({
    env: {
      EMPIR3_PW_PORT: '4306',
      EMPIR3_BRIDGE_HTTP_PORT: '10967',
      EMPIR3_CDP_PORT: '10922',
    },
  }), { wrapper: 4306, bridge: 10967, cdp: 10922 });
  assert.throws(() => resolvePorts({ env: { EMPIR3_PW_PORT: '80' } }), /between 1024 and 65535/);
  assert.throws(() => resolvePorts({
    env: { EMPIR3_PW_PORT: '4306', EMPIR3_BRIDGE_HTTP_PORT: '4306' },
  }), /must be distinct/);
});

test('runtime root is source-relative in development and resource-relative when packaged', () => {
  const source = resolveBridgeRoot({
    shellSourceDir: join('C:', 'repo', 'desktop-shell', 'src'),
    env: {},
  });
  assert.equal(source, resolve('C:', 'repo'));
  assert.equal(resolveBridgeRoot({
    isPackaged: true,
    resourcesPath: join('C:', 'app', 'resources'),
    env: {},
  }), join('C:', 'app', 'resources', 'bridge'));
  assert.equal(resolveBridgeRoot({
    isPackaged: true,
    resourcesPath: 'ignored',
    env: { EMPIR3_BRIDGE_RUNTIME_ROOT: join('C:', 'override') },
  }), resolve('C:', 'override'));
});

test('provider-only runtime environment keeps automation Chrome dormant', () => {
  const ports = { wrapper: 4306, bridge: 10967, cdp: 10922 };
  const runtimeEnv = makeRuntimeEnvironment({
    ports,
    env: { SAFE_PARENT_VALUE: 'kept' },
    profilePath: join('C:', 'profiles', 'electron'),
    bridgeRoot: join('C:', 'runtime', 'bridge'),
  });
  assert.equal(runtimeEnv.SAFE_PARENT_VALUE, 'kept');
  assert.equal(runtimeEnv.EMPIR3_HEADLESS, '0');
  assert.equal(runtimeEnv.BRIDGE_HEADLESS, 'false');
  assert.equal(runtimeEnv.EMPIR3_CHROME_AUTOLAUNCH, '0');
  assert.equal(runtimeEnv.EMPIR3_SKIP_PREDECESSOR_REAP, '1');
  assert.equal(runtimeEnv.EMPIR3_PW_PORT, '4306');
  assert.equal(runtimeEnv.EMPIR3_BRIDGE_HTTP_PORT, '10967');
  assert.equal(runtimeEnv.EMPIR3_CDP_PORT, '10922');
  assert.equal(runtimeEnv.EMPIR3_BRIDGE_PROFILE, join('C:', 'profiles', 'electron'));
  assert.equal(runtimeEnv.EMPIR3_BRIDGE_PAYLOAD_DIR, join('C:', 'runtime', 'bridge'));
  assert.equal(
    runtimeEnv.EMPIR3_BRIDGE_ACCURACY_LAB,
    join('C:', 'runtime', 'bridge', 'dist', 'accuracy-lab.html'),
  );
});

test('packaged shell reuses Electron as Node while development uses regular Node', () => {
  assert.deepEqual(resolveRuntimeCommand({ isPackaged: false, env: {} }), {
    executable: 'node',
    extraEnv: {},
  });
  assert.deepEqual(resolveRuntimeCommand({
    isPackaged: true,
    electronExecutable: join('C:', 'Empir3', 'Empir3Bridge.exe'),
    env: {},
  }), {
    executable: join('C:', 'Empir3', 'Empir3Bridge.exe'),
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
});

test('renderer navigation stays on the exact local wrapper origin', () => {
  assert.equal(isAllowedLocalUrl('http://127.0.0.1:3306/welcome', 3306), true);
  assert.equal(isAllowedLocalUrl('http://localhost:3306/api/status', 3306), true);
  assert.equal(isAllowedLocalUrl('https://127.0.0.1:3306/welcome', 3306), false);
  assert.equal(isAllowedLocalUrl('http://127.0.0.1.evil.test:3306/welcome', 3306), false);
  assert.equal(isAllowedLocalUrl('http://127.0.0.1:3006/welcome', 3306), false);
});

test('external web navigation is routed to the isolated Bridge browser', () => {
  assert.deepEqual(
    externalNavigationCommand('https://app.empir3.com/connect-bridge?code=ABC123'),
    { type: 'navigate', url: 'https://app.empir3.com/connect-bridge?code=ABC123' },
  );
  assert.deepEqual(
    externalNavigationCommand('http://localhost:3005/connect-bridge?code=DEV'),
    { type: 'navigate', url: 'http://localhost:3005/connect-bridge?code=DEV' },
  );
  assert.equal(externalNavigationCommand('file:///C:/secret.txt'), null);
  assert.equal(externalNavigationCommand('javascript:alert(1)'), null);
  assert.equal(externalNavigationCommand('not a url'), null);
});

test('status and provider URLs use loopback and the selected wrapper port', () => {
  assert.equal(statusUrl(3306), 'http://127.0.0.1:3306/api/status');
  assert.equal(providerConsoleUrl(3306), 'http://127.0.0.1:3306/welcome?pane=clis');
});

test('health wait retries transient failures and returns the first status object', async () => {
  let calls = 0;
  const result = await waitForBridge({
    wrapperPort: 3306,
    timeoutMs: 1000,
    intervalMs: 1,
    fetcher: async () => {
      calls += 1;
      if (calls < 3) throw new Error('not ready');
      return { running: true };
    },
  });
  assert.deepEqual(result, { running: true });
  assert.equal(calls, 3);
});

test('health wait surfaces the final blocker after its deadline', async () => {
  await assert.rejects(waitForBridge({
    wrapperPort: 3306,
    timeoutMs: 5,
    intervalMs: 1,
    fetcher: async () => { throw new Error('connection refused'); },
  }), /connection refused/);
});
