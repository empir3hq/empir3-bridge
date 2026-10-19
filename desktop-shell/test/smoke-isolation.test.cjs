'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { test } = require('node:test');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  assertSmokeEnvironmentIsolation,
  isPathInside,
  prepareSmokeEnvironmentDirectories,
} = require('../src/smoke-isolation.cjs');

function isolatedEnvironment(root) {
  return {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'roaming'),
    LOCALAPPDATA: join(root, 'local'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    EMPIR3_BRIDGE_PROFILE: join(root, 'bridge-profile'),
  };
}

test('packaged smoke accepts only an entirely isolated environment', () => {
  const root = join(process.cwd(), 'scratch', 'package-smoke');
  const actual = assertSmokeEnvironmentIsolation({
    isolationRoot: root,
    stateRoot: join(root, 'roaming'),
    userData: join(root, 'electron-user-data'),
    env: isolatedEnvironment(root),
  });
  assert.equal(actual, root.toLowerCase());
});

test('packaged smoke fails before launch when any writable path escapes', () => {
  const root = join(process.cwd(), 'scratch', 'package-smoke');
  const env = isolatedEnvironment(root);
  env.APPDATA = join(process.cwd(), 'real-profile');
  assert.throws(() => assertSmokeEnvironmentIsolation({
    isolationRoot: root,
    stateRoot: join(root, 'roaming'),
    userData: join(root, 'electron-user-data'),
    env,
  }), /APPDATA escaped/);
});

test('path containment rejects sibling-prefix paths', () => {
  const root = join(process.cwd(), 'scratch', 'smoke');
  assert.equal(isPathInside(root, join(root, 'child')), true);
  assert.equal(isPathInside(root, `${root}-other`), false);
});

test('packaged smoke creates every isolated writable directory before launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-smoke-dirs-'));
  try {
    const env = isolatedEnvironment(root);
    const stateRoot = join(root, 'roaming');
    const userData = join(root, 'electron-user-data');
    prepareSmokeEnvironmentDirectories({ isolationRoot: root, stateRoot, userData, env });
    for (const directory of new Set([
      stateRoot,
      userData,
      env.HOME,
      env.USERPROFILE,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.TEMP,
      env.TMP,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.EMPIR3_BRIDGE_PROFILE,
    ])) {
      assert.equal(existsSync(directory), true, `${directory} should exist`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
