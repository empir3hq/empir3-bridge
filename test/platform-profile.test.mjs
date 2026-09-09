/**
 * Platform profile tests — the deviceClass decision drives which tool palette
 * the Empir3 UI renders and which capabilities the gate refuses, so its edge
 * cases (headless env flags, DISPLAY detection, container detection, distro
 * parsing) are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { computePlatformProfile, getPlatformProfile } = require_('../src/platform-profile.js');

test('linux with no DISPLAY is a headless server', () => {
  const p = computePlatformProfile({
    platform: 'linux', env: {}, fsExists: () => false, readText: () => '', readDir: () => [],
  });
  assert.equal(p.os, 'linux');
  assert.equal(p.hasDisplay, false);
  assert.equal(p.headless, true);
  assert.equal(p.deviceClass, 'server');
});

test('linux with DISPLAY is a workstation', () => {
  const p = computePlatformProfile({
    platform: 'linux', env: { DISPLAY: ':0' }, fsExists: () => false, readText: () => '',
  });
  assert.equal(p.hasDisplay, true);
  assert.equal(p.x11Display, ':0');
  assert.equal(p.headless, false);
  assert.equal(p.deviceClass, 'workstation');
});

test('linux systemd service discovers the lowest X11 socket without DISPLAY', () => {
  const p = computePlatformProfile({
    platform: 'linux',
    env: { EMPIR3_HEADLESS: '1' },
    fsExists: () => false,
    readText: () => '',
    readDir: (path) => path === '/tmp/.X11-unix' ? ['noise', 'X99', 'X2'] : [],
  });
  assert.equal(p.x11Display, ':2');
  assert.equal(p.hasDisplay, true);
  assert.equal(p.headless, true, 'the service remains a headless host even though its Xvfb display is drivable');
  assert.equal(p.deviceClass, 'server');
});

test('linux ignores malformed X socket names', () => {
  const p = computePlatformProfile({
    platform: 'linux',
    env: {},
    fsExists: () => false,
    readText: () => '',
    readDir: () => ['X-1', 'Xabc', 'X12.lock', '.X11-unix'],
  });
  assert.equal(p.x11Display, '');
  assert.equal(p.hasDisplay, false);
});

test('EMPIR3_HEADLESS=1 forces server class even with a display', () => {
  const p = computePlatformProfile({
    platform: 'linux', env: { DISPLAY: ':0', EMPIR3_HEADLESS: '1' }, fsExists: () => false, readText: () => '',
  });
  assert.equal(p.headless, true);
  assert.equal(p.deviceClass, 'server');
});

test('BRIDGE_HEADLESS=true also marks headless', () => {
  const p = computePlatformProfile({
    platform: 'win32', env: { BRIDGE_HEADLESS: 'true' },
  });
  assert.equal(p.headless, true);
  assert.equal(p.deviceClass, 'server');
});

test('windows desktop defaults to workstation', () => {
  const p = computePlatformProfile({ platform: 'win32', env: {} });
  assert.equal(p.os, 'windows');
  assert.equal(p.osPretty, 'Windows');
  assert.equal(p.hasDisplay, true);
  assert.equal(p.deviceClass, 'workstation');
});

test('distro comes from /etc/os-release PRETTY_NAME', () => {
  const p = computePlatformProfile({
    platform: 'linux',
    env: {},
    fsExists: () => false,
    readText: (f) => (f === '/etc/os-release' ? 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' : ''),
  });
  assert.equal(p.distro, 'Ubuntu 24.04.1 LTS');
  assert.equal(p.osPretty, 'Ubuntu 24.04.1 LTS');
});

test('container detected via /.dockerenv', () => {
  const p = computePlatformProfile({
    platform: 'linux',
    env: {},
    fsExists: (f) => f === '/.dockerenv',
    readText: () => '',
  });
  assert.equal(p.container, true);
});

test('container detected via cgroup', () => {
  const p = computePlatformProfile({
    platform: 'linux',
    env: {},
    fsExists: () => false,
    readText: (f) => (f === '/proc/1/cgroup' ? '0::/system.slice/docker-abc.scope\n' : ''),
  });
  assert.equal(p.container, true);
});

test('macos maps to macos/macOS', () => {
  const p = computePlatformProfile({ platform: 'darwin', env: {} });
  assert.equal(p.os, 'macos');
  assert.equal(p.osPretty, 'macOS');
});

test('getPlatformProfile returns a stable cached object', () => {
  assert.equal(getPlatformProfile(), getPlatformProfile());
});
