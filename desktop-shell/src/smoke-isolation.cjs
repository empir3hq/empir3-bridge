'use strict';

const { mkdirSync } = require('node:fs');
const { resolve, sep } = require('node:path');

function normalizedPath(value) {
  return resolve(String(value || '')).toLowerCase();
}

function isPathInside(root, candidate) {
  const expected = normalizedPath(root);
  const actual = normalizedPath(candidate);
  return actual === expected || actual.startsWith(`${expected}${sep}`);
}

function assertSmokeEnvironmentIsolation({ isolationRoot, stateRoot, userData, env = process.env } = {}) {
  if (!isolationRoot) throw new Error('Packaged smoke isolation root is required');
  const checks = {
    stateRoot,
    userData,
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    APPDATA: env.APPDATA,
    LOCALAPPDATA: env.LOCALAPPDATA,
    TEMP: env.TEMP,
    TMP: env.TMP,
    EMPIR3_BRIDGE_PROFILE: env.EMPIR3_BRIDGE_PROFILE,
  };
  // The scaled daemon applies these overrides after inheriting HOME. Check
  // them too: an isolated parent must never hand its child the real profile.
  for (const optional of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'EMPIR3_SCALE_HOST_HOME', 'EMPIR3_SCALE_HOST_USERPROFILE', 'EMPIR3_BRIDGE_RUNTIME_DATA_DIR']) {
    if (env[optional]) checks[optional] = env[optional];
  }
  for (const [label, candidate] of Object.entries(checks)) {
    if (!candidate) throw new Error(`Packaged smoke ${label} is required`);
    if (!isPathInside(isolationRoot, candidate)) {
      throw new Error(`Packaged smoke ${label} escaped its isolation root`);
    }
  }
  return normalizedPath(isolationRoot);
}

function prepareSmokeEnvironmentDirectories({ isolationRoot, stateRoot, userData, env = process.env } = {}) {
  assertSmokeEnvironmentIsolation({ isolationRoot, stateRoot, userData, env });
  const directories = new Set([
    isolationRoot,
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
    env.EMPIR3_BRIDGE_RUNTIME_DATA_DIR,
  ].filter(Boolean));
  for (const directory of directories) mkdirSync(directory, { recursive: true });
}

module.exports = {
  assertSmokeEnvironmentIsolation,
  isPathInside,
  prepareSmokeEnvironmentDirectories,
};
