#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);
const { resolveSigningConfig } = require('../desktop-shell/src/signing-config.cjs');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const platformAliases = { windows: 'win32', win32: 'win32', macos: 'darwin', darwin: 'darwin', linux: 'linux' };
const requested = argument('--platform', process.platform).toLowerCase();
const platform = platformAliases[requested];
if (!platform) throw new Error(`Unsupported --platform ${requested}; use windows, macos, or linux`);
if (platform !== process.platform) {
  throw new Error(`Signing preflight for ${requested} must run on that native host (current: ${process.platform})`);
}
const online = process.argv.includes('--online');
const json = process.argv.includes('--json');
const checks = [];

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
}

function command(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function azure(args) {
  const bundledPython = join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'Microsoft SDKs', 'Azure', 'CLI2', 'python.exe',
  );
  if (existsSync(bundledPython)) return command(bundledPython, ['-IBm', 'azure.cli', ...args]);
  return command('az', args);
}

function requireCommand(name, args = ['--version']) {
  const result = command(name, args);
  if (result.error || result.status !== 0) {
    fail(`tool:${name}`, 'not available');
    return false;
  }
  pass(`tool:${name}`, 'available');
  return true;
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

const bridgeVersion = packageVersion(join(root, 'package.json'));
const desktopVersion = packageVersion(join(root, 'desktop-shell', 'package.json'));
const headlessVersion = packageVersion(join(root, 'headless-package', 'package.json'));
if (new Set([bridgeVersion, desktopVersion, headlessVersion]).size === 1) {
  pass('release-version', bridgeVersion);
} else {
  fail('release-version', `Bridge=${bridgeVersion}, desktop=${desktopVersion}, headless=${headlessVersion}`);
}

const publicTrust = join(root, 'build', 'payload-signing-pub.json');
if (existsSync(publicTrust)) pass('release-trust-root', 'present');
else fail('release-trust-root', 'build/payload-signing-pub.json is missing');

if (platform === 'win32') {
  try {
    resolveSigningConfig({ env: { ...process.env, EMPIR3_SIGN_WINDOWS: '1' }, platform });
    pass('windows-signing-config', 'fail-closed Azure signing enabled');
  } catch (error) {
    fail('windows-signing-config', error.message);
  }
  const metadata = join(root, 'build', 'signing', 'metadata.json');
  if (existsSync(metadata)) pass('azure-signing-metadata', 'present');
  else fail('azure-signing-metadata', 'build/signing/metadata.json is missing');

  const tools = join(root, 'build', 'signing', 'tools');
  const dlib = join(tools, 'tsclient', 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll');
  const sdkBin = join(tools, 'sdktools', 'bin');
  let signTool = '';
  if (existsSync(sdkBin)) {
    const stack = [sdkBin];
    while (stack.length > 0 && !signTool) {
      const current = stack.pop();
      const result = command('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-ChildItem -LiteralPath '${current.replaceAll("'", "''")}' -Recurse -Filter signtool.exe -File | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName; if($p){$p}`,
      ]);
      if (result.status === 0) signTool = String(result.stdout || '').trim();
    }
  }
  if (signTool && existsSync(dlib)) pass('azure-signing-tools', 'signtool and Trusted Signing client present');
  else fail('azure-signing-tools', 'run build/signing/setup-tools.ps1 once on this machine');

  const account = azure(['account', 'show', '--query', 'state', '-o', 'tsv']);
  if (account.error || account.status !== 0) fail('azure-cli', 'not available or not signed in');
  else {
    pass('azure-cli', 'available');
    if (String(account.stdout || '').trim() === 'Enabled') pass('azure-session', 'authenticated and enabled');
    else fail('azure-session', 'Azure CLI has no enabled account; run az login');
  }
}

if (platform === 'darwin') {
  let signing;
  try {
    signing = resolveSigningConfig({ env: { ...process.env, EMPIR3_SIGN_MACOS: '1' }, platform });
    pass('macos-signing-config', 'Developer ID and notarization configured');
  } catch (error) {
    fail('macos-signing-config', error.message);
  }
  requireCommand('xcode-select', ['-p']);
  for (const tool of ['codesign', 'notarytool', 'stapler']) {
    requireCommand('xcrun', ['--find', tool]);
  }
  if (signing) {
    const identities = command('security', ['find-identity', '-v', '-p', 'codesigning']);
    const identity = signing.packagerConfig.osxSign.identity;
    if (identities.status === 0 && String(identities.stdout || '').includes(identity)) {
      pass('developer-id-identity', 'installed in the active keychain');
    } else {
      fail('developer-id-identity', 'configured Developer ID Application identity was not found');
    }
    const apiKey = signing.packagerConfig.osxNotarize.appleApiKey;
    if (apiKey && !existsSync(apiKey)) fail('notary-api-key', 'configured .p8 file does not exist');
    else if (apiKey) pass('notary-api-key', 'configured .p8 file exists');

    if (online) {
      const notarize = signing.packagerConfig.osxNotarize;
      const args = ['notarytool', 'history', '--output-format', 'json'];
      if (notarize.keychain) args.push('--keychain', notarize.keychain);
      if (notarize.keychainProfile) args.push('--keychain-profile', notarize.keychainProfile);
      else if (notarize.appleApiKey) args.push('--key', notarize.appleApiKey, '--key-id', notarize.appleApiKeyId, '--issuer', notarize.appleApiIssuer);
      else args.push('--apple-id', notarize.appleId, '--password', notarize.appleIdPassword, '--team-id', notarize.teamId);
      const result = command('xcrun', args);
      if (result.status === 0) pass('notary-service', 'credentials accepted by Apple');
      else fail('notary-service', 'Apple rejected the notarization credential check');
    } else {
      pass('notary-service', 'offline configuration check passed; rerun with --online before release');
    }
  }
}

if (platform === 'linux') {
  requireCommand('dpkg-deb', ['--version']);
  requireCommand('zip', ['-v']);
  pass('linux-authentication', 'artifacts will be hash-bound by the signed schema 3 release manifest');
}

const ok = checks.every((check) => check.ok);
if (json) {
  process.stdout.write(`${JSON.stringify({ ok, platform, online, checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(`${ok ? 'READY' : 'NOT READY'}  ${requested} signing preflight\n`);
}
if (!ok) process.exitCode = 1;
