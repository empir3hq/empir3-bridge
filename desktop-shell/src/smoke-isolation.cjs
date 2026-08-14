'use strict';

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
  for (const optional of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
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

module.exports = {
  assertSmokeEnvironmentIsolation,
  isPathInside,
};
