'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { macNotarizeCredentials, resolveSigningConfig } = require('../src/signing-config.cjs');

test('keeps ordinary package runs unsigned', () => {
  const config = resolveSigningConfig({ env: {}, platform: 'linux' });
  assert.equal(config.mode, 'unsigned');
  assert.deepEqual(config.packagerConfig, {});
});

test('configures both Windows package and Squirrel signing through the Azure hook', () => {
  const config = resolveSigningConfig({ env: { EMPIR3_SIGN_WINDOWS: '1' }, platform: 'win32' });
  assert.equal(config.mode, 'windows-authenticode');
  assert.match(config.packagerConfig.windowsSign.hookModulePath, /windows-sign-hook\.cjs$/);
  assert.equal(config.squirrelConfig.windowsSign, config.packagerConfig.windowsSign);
  assert.deepEqual(config.packagerConfig.windowsSign.hashes, ['sha256']);
});

test('refuses a Windows signing request on another host', () => {
  assert.throws(
    () => resolveSigningConfig({ env: { EMPIR3_SIGN_WINDOWS: '1' }, platform: 'linux' }),
    /native Windows host/,
  );
});

test('accepts a keychain profile without exposing a secret to Forge configuration', () => {
  assert.deepEqual(macNotarizeCredentials({
    EMPIR3_MAC_NOTARY_KEYCHAIN_PROFILE: 'empir3-notary',
  }), { keychainProfile: 'empir3-notary' });
});

test('requires complete and unambiguous macOS notarization credentials', () => {
  assert.throws(() => macNotarizeCredentials({ APPLE_ID: 'builder@example.test' }), /missing/);
  assert.throws(() => macNotarizeCredentials({
    EMPIR3_MAC_NOTARY_KEYCHAIN_PROFILE: 'empir3-notary',
    APPLE_ID: 'builder@example.test',
    APPLE_ID_PASSWORD: 'app-password',
    APPLE_TEAM_ID: 'TEAM123',
  }), /exactly one credential strategy/);
});

test('configures Developer ID signing, app notarization, and the DMG post-make gate', () => {
  const config = resolveSigningConfig({
    env: {
      EMPIR3_SIGN_MACOS: '1',
      EMPIR3_MAC_SIGN_IDENTITY: 'Developer ID Application: Example Corp (TEAM123)',
      EMPIR3_MAC_NOTARY_KEYCHAIN_PROFILE: 'empir3-notary',
    },
    platform: 'darwin',
  });
  assert.equal(config.mode, 'macos-developer-id-notarized');
  assert.equal(config.packagerConfig.osxSign.hardenedRuntime, true);
  assert.deepEqual(config.packagerConfig.osxNotarize, { keychainProfile: 'empir3-notary' });
  assert.equal(typeof config.hooks.postMake, 'function');
});
