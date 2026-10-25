import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  WINDOWS_DESKTOP_WAKE_PS,
  createWindowsDesktopAwakeController,
  keepAwakeScript,
} = require('../src/windows-desktop-awake.js');

function fakeChild() {
  const handlers = new Map();
  return {
    killed: false,
    once(name, handler) { handlers.set(name, handler); },
    kill() { this.killed = true; handlers.get('exit')?.(); },
    unref() {},
  };
}

test('wake probe has the secure-desktop boundary and harmless F15 nudge', () => {
  assert.match(WINDOWS_DESKTOP_WAKE_PS, /OpenInputDesktop/);
  assert.match(WINDOWS_DESKTOP_WAKE_PS, /SwitchDesktop/);
  assert.match(WINDOWS_DESKTOP_WAKE_PS, /secureDesktop=\$true/);
  assert.match(WINDOWS_DESKTOP_WAKE_PS, /SendF15/);
  assert.match(WINDOWS_DESKTOP_WAKE_PS, /SetThreadExecutionState\(0x00000003\)/);
});

test('keep-awake helper is parent-scoped and releases its execution state', () => {
  const script = keepAwakeScript(4321);
  assert.match(script, /\$parentPid = 4321/);
  assert.match(script, /Get-Process -Id \$parentPid/);
  assert.match(script, /SetThreadExecutionState\(0x80000003\)/);
  assert.match(script, /SetThreadExecutionState\(0x80000000\)/);
});

test('activity shares one helper and resets the idle release timer', async () => {
  const spawned = [];
  const timers = [];
  const controller = createWindowsDesktopAwakeController({
    platform: 'win32',
    parentPid: 123,
    idleReleaseMs: 10_000,
    spawnProcess(command, args, options) {
      const child = fakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
  });

  await controller.ensureAwake(async () => ({ unlocked: true, secureDesktop: false, screenSaverRunning: false }));
  await controller.ensureAwake(async () => ({ unlocked: true, secureDesktop: false, screenSaverRunning: false }));
  assert.equal(spawned.length, 1);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(controller.status().active, true);

  timers[1].fn();
  assert.equal(spawned[0].child.killed, true);
  assert.equal(controller.status().active, false);
});

test('password lock refuses honestly and never starts keep-awake', async () => {
  let spawnCount = 0;
  const controller = createWindowsDesktopAwakeController({
    platform: 'win32',
    spawnProcess() { spawnCount += 1; return fakeChild(); },
  });
  await assert.rejects(
    controller.ensureAwake(async () => ({ unlocked: false, secureDesktop: true })),
    (error) => error.code === 'desktop_locked' && /password-locked/.test(error.message),
  );
  assert.equal(spawnCount, 0);
});

test('non-Windows hosts remain a no-op', async () => {
  const controller = createWindowsDesktopAwakeController({ platform: 'linux' });
  const result = await controller.ensureAwake(async () => { throw new Error('must not run'); });
  assert.deepEqual(result, { supported: false, unlocked: true });
  assert.equal(controller.startLease(), false);
});
