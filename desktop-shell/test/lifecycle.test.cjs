'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  createFileLogger,
  createRestartLimiter,
  getLaunchAtLogin,
  isWindowsUninstallEvent,
  linuxAutostartContents,
  linuxAutostartPath,
  setLaunchAtLogin,
  prepareForUninstall,
} = require('../src/lifecycle.cjs');

test('managed Bridge restarts are bounded and recover after the window', () => {
  let timestamp = 1_000;
  const limiter = createRestartLimiter({
    maxRestarts: 3,
    windowMs: 60_000,
    now: () => timestamp,
  });

  assert.deepEqual(limiter.tryAcquire(), { allowed: true, count: 1, retryAfterMs: 0 });
  timestamp += 100;
  assert.deepEqual(limiter.tryAcquire(), { allowed: true, count: 2, retryAfterMs: 0 });
  timestamp += 100;
  assert.deepEqual(limiter.tryAcquire(), { allowed: true, count: 3, retryAfterMs: 0 });
  timestamp += 100;
  assert.deepEqual(limiter.tryAcquire(), { allowed: false, count: 3, retryAfterMs: 59_700 });

  timestamp += 60_000;
  assert.deepEqual(limiter.tryAcquire(), { allowed: true, count: 1, retryAfterMs: 0 });
});

test('managed Bridge restart limiter rejects unsafe bounds', () => {
  assert.throws(() => createRestartLimiter({ maxRestarts: 0 }), /positive integer/);
  assert.throws(() => createRestartLimiter({ windowMs: 0 }), /positive/);
});

test('Linux launch-at-login uses the XDG autostart contract and is reversible', () => {
  const home = mkdtempSync(join(tmpdir(), 'empir3-lifecycle-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const result = setLaunchAtLogin(true, {
      platform: 'linux', home, env, executable: '/opt/Empir3 Bridge/empir3-bridge',
    });
    assert.equal(result.path, linuxAutostartPath({ home, env }));
    assert.equal(getLaunchAtLogin({ platform: 'linux', home, env }), true);
    const desktop = readFileSync(result.path, 'utf8');
    assert.match(desktop, /Exec="\/opt\/Empir3 Bridge\/empir3-bridge" --hidden/);
    assert.match(desktop, /X-Empir3-Managed=true/);
    if (process.platform !== 'win32') assert.equal(statSync(result.path).mode & 0o777, 0o600);
    setLaunchAtLogin(false, { platform: 'linux', home, env });
    assert.equal(getLaunchAtLogin({ platform: 'linux', home, env }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Linux desktop Exec quoting protects shell-significant paths', () => {
  const contents = linuxAutostartContents('/opt/Empir3 $Bridge/bridge`test`');
  assert.ok(contents.includes('Exec="/opt/Empir3 \\$Bridge/bridge\\`test\\`" --hidden'));
});

test('Linux startup toggle never overwrites or deletes an unmanaged entry', () => {
  const home = mkdtempSync(join(tmpdir(), 'empir3-lifecycle-unmanaged-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const path = linuxAutostartPath({ home, env });
    require('node:fs').mkdirSync(join(home, 'xdg', 'autostart'), { recursive: true });
    writeFileSync(path, '[Desktop Entry]\nName=User managed\n');
    assert.throws(
      () => setLaunchAtLogin(true, { platform: 'linux', home, env, executable: '/opt/bridge' }),
      /Refusing to replace/,
    );
    setLaunchAtLogin(false, { platform: 'linux', home, env });
    assert.match(readFileSync(path, 'utf8'), /User managed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Windows and macOS delegate login registration to Electron', () => {
  const calls = [];
  const electronApp = {
    getLoginItemSettings: () => ({ openAtLogin: true }),
    setLoginItemSettings: (settings) => calls.push(settings),
  };
  assert.equal(getLaunchAtLogin({ platform: 'darwin', electronApp }), true);
  setLaunchAtLogin(true, { platform: 'win32', electronApp, executable: 'C:\\Empir3\\bridge.exe' });
  setLaunchAtLogin(false, { platform: 'darwin', electronApp, executable: '/Applications/Empir3 Bridge.app' });
  assert.deepEqual(calls[0], {
    openAtLogin: true, path: 'C:\\Empir3\\bridge.exe', args: ['--hidden'],
  });
  assert.deepEqual(calls[1], { openAtLogin: false });
});

test('uninstall preparation removes startup but intentionally retains local provider data', () => {
  const calls = [];
  const electronApp = { setLoginItemSettings: (settings) => calls.push(settings) };
  const result = prepareForUninstall({
    platform: 'win32', electronApp, executable: 'C:\\Empir3\\bridge.exe',
  });
  assert.deepEqual(calls, [{ openAtLogin: false, path: 'C:\\Empir3\\bridge.exe', args: ['--hidden'] }]);
  assert.equal(result.startupRemoved, true);
  assert.equal(result.dataRetention, 'keep');
  assert.match(result.message, /API keys/);
});

test('only the exact Squirrel uninstall event enters uninstall cleanup', () => {
  assert.equal(isWindowsUninstallEvent(['bridge.exe', '--squirrel-uninstall']), true);
  assert.equal(isWindowsUninstallEvent(['bridge.exe', '--SQUIRREL-UNINSTALL']), true);
  assert.equal(isWindowsUninstallEvent(['bridge.exe', '--squirrel-install']), false);
  assert.equal(isWindowsUninstallEvent(['bridge.exe', 'uninstall']), false);
});

test('file logger rotates at its bound and keeps diagnostics local', () => {
  const directory = mkdtempSync(join(tmpdir(), 'empir3-logs-'));
  try {
    const logger = createFileLogger({ directory, maxBytes: 100 });
    logger.write('info', 'first diagnostic line');
    logger.write('error', 'x'.repeat(120));
    assert.match(readFileSync(logger.path, 'utf8'), /ERROR x+/);
    assert.match(readFileSync(`${logger.path}.1`, 'utf8'), /first diagnostic line/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
