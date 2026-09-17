'use strict';

const { resolve } = require('node:path');

function enabled(env, name) {
  return String(env[name] || '').trim() === '1';
}

function required(env, names, label) {
  const missing = names.filter((name) => !String(env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`${label} is missing: ${missing.join(', ')}`);
  }
  return Object.fromEntries(names.map((name) => [name, String(env[name]).trim()]));
}

function macNotarizeCredentials(env) {
  const keychain = String(env.EMPIR3_MAC_NOTARY_KEYCHAIN_PROFILE || '').trim();
  const apiValues = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
    .filter((name) => String(env[name] || '').trim());
  const passwordValues = ['APPLE_ID', 'APPLE_ID_PASSWORD', 'APPLE_TEAM_ID']
    .filter((name) => String(env[name] || '').trim());
  const strategies = Number(Boolean(keychain)) + Number(apiValues.length > 0) + Number(passwordValues.length > 0);
  if (strategies !== 1) {
    throw new Error('macOS notarization needs exactly one credential strategy: Keychain profile, App Store Connect API key, or Apple ID app-specific password');
  }
  if (keychain) {
    return {
      keychainProfile: keychain,
      ...(String(env.EMPIR3_MAC_NOTARY_KEYCHAIN || '').trim()
        ? { keychain: String(env.EMPIR3_MAC_NOTARY_KEYCHAIN).trim() }
        : {}),
    };
  }
  if (apiValues.length > 0) {
    const values = required(env, ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'], 'App Store Connect notarization');
    return {
      appleApiKey: resolve(values.APPLE_API_KEY),
      appleApiKeyId: values.APPLE_API_KEY_ID,
      appleApiIssuer: values.APPLE_API_ISSUER,
    };
  }
  const values = required(env, ['APPLE_ID', 'APPLE_ID_PASSWORD', 'APPLE_TEAM_ID'], 'Apple ID notarization');
  return {
    appleId: values.APPLE_ID,
    appleIdPassword: values.APPLE_ID_PASSWORD,
    teamId: values.APPLE_TEAM_ID,
  };
}

function resolveSigningConfig({ env = process.env, platform = process.platform } = {}) {
  const signWindows = enabled(env, 'EMPIR3_SIGN_WINDOWS');
  const signMacos = enabled(env, 'EMPIR3_SIGN_MACOS');
  if (signWindows && platform !== 'win32') {
    throw new Error('EMPIR3_SIGN_WINDOWS=1 requires a native Windows host');
  }
  if (signMacos && platform !== 'darwin') {
    throw new Error('EMPIR3_SIGN_MACOS=1 requires a native macOS host');
  }
  if (signWindows && signMacos) {
    throw new Error('A native package run can enable only its host platform signer');
  }

  const result = {
    packagerConfig: {},
    squirrelConfig: {},
    hooks: {},
    mode: 'unsigned',
  };

  if (signWindows) {
    const hookModulePath = resolve(__dirname, '..', 'scripts', 'windows-sign-hook.cjs');
    const windowsSign = {
      hookModulePath,
      hashes: ['sha256'],
      description: 'Empir3 Bridge',
      website: 'https://empir3.com',
    };
    result.packagerConfig.windowsSign = windowsSign;
    result.squirrelConfig.windowsSign = windowsSign;
    result.mode = 'windows-authenticode';
  }

  if (signMacos) {
    const { EMPIR3_MAC_SIGN_IDENTITY: identity } = required(
      env,
      ['EMPIR3_MAC_SIGN_IDENTITY'],
      'macOS Developer ID signing',
    );
    const notarize = macNotarizeCredentials(env);
    result.packagerConfig.osxSign = {
      identity,
      hardenedRuntime: true,
      identityValidation: true,
    };
    result.packagerConfig.osxNotarize = notarize;
    result.hooks.postMake = async (_forgeConfig, makeResults) => {
      const { signAndNotarizeMacDisks } = require('../scripts/notarize-macos-artifacts.cjs');
      await signAndNotarizeMacDisks(makeResults, { identity, notarize });
      return makeResults;
    };
    result.mode = 'macos-developer-id-notarized';
  }

  return result;
}

module.exports = {
  macNotarizeCredentials,
  resolveSigningConfig,
};
