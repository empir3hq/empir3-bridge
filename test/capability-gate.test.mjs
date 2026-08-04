/**
 * Capability gate tests.
 *
 * On a non-Windows device the desktop-control surface (PowerShell-backed GUI,
 * windows, clipboard, notify, app control, and four sysinfo queries) must
 * return a STRUCTURED capability_unsupported refusal from the dispatchers —
 * never a spawn ENOENT. Everything a headless server genuinely supports
 * (shell, files, browser, capabilities probe, portable sysinfo) must pass
 * the gate untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { unsupportedDesktopCommand } = require_('../src/capability-gate.js');
const { computePlatformProfile } = require_('../src/platform-profile.js');

const linuxServer = computePlatformProfile({
  platform: 'linux',
  env: { EMPIR3_HEADLESS: '1' },
  fsExists: () => false,
  readText: () => 'PRETTY_NAME="Ubuntu 24.04 LTS"\n',
});

const windows = computePlatformProfile({
  platform: 'win32',
  env: {},
});

// ── refused on a Linux server ──

for (const [base, action] of [
  ['desktop:gui', 'screenshot'],
  ['desktop:gui', 'click'],
  ['desktop:window', 'list'],
  ['desktop:notify', 'show'],
  ['desktop:clipboard', 'read'],
  ['desktop:app', 'launch'],
  ['desktop:app', 'kill'],
  ['desktop:sysinfo', 'processes'],
  ['desktop:sysinfo', 'disk'],
  ['desktop:sysinfo', 'battery'],
  ['desktop:sysinfo', 'installed'],
  ['desktop_screenshot', ''],
  ['desktop_click', ''],
  ['desktop_toolbar', 'show'],
  ['desktop_pointer_move', ''],
  ['page_to_screen', ''],
]) {
  test(`linux server refuses ${base}${action ? ':' + action : ''}`, () => {
    const refusal = unsupportedDesktopCommand(base, action, linuxServer);
    assert.ok(refusal, 'must be refused');
    assert.equal(refusal.success, false);
    assert.equal(refusal.code, 'capability_unsupported');
    assert.equal(refusal.deviceClass, 'server');
    assert.equal(refusal.platform, 'linux');
    assert.ok(refusal.capability.length > 0);
    assert.ok(refusal.hint.length > 0, 'hint must steer the agent to working tools');
  });
}

// ── allowed on a Linux server ──

for (const [base, action] of [
  ['desktop:execute', 'run'],
  ['desktop:file', 'push'],
  ['desktop:file:pull', 'pull'],
  ['desktop:project:file', 'save'],
  ['desktop:sync:push', 'push'],
  ['desktop:capabilities', 'quick'],
  ['desktop:sysinfo', 'overview'],
  ['desktop:sysinfo', 'network'],
  ['desktop:browse', 'navigate'],
  ['desktop:agent-browser', 'status'],
  ['navigate', ''],
  ['screenshot', ''], // browser screenshot, not desktop
  ['claude:cli:turn', ''],
]) {
  test(`linux server allows ${base}${action ? ':' + action : ''}`, () => {
    assert.equal(unsupportedDesktopCommand(base, action, linuxServer), null);
  });
}

// ── everything passes on Windows ──

for (const [base, action] of [
  ['desktop:gui', 'screenshot'],
  ['desktop:window', 'list'],
  ['desktop:clipboard', 'read'],
  ['desktop:sysinfo', 'processes'],
  ['desktop_screenshot', ''],
  ['page_to_screen', ''],
]) {
  test(`windows allows ${base}${action ? ':' + action : ''}`, () => {
    assert.equal(unsupportedDesktopCommand(base, action, windows), null);
  });
}
