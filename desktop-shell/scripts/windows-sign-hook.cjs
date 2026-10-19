'use strict';

const { existsSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = function signWithAzureTrustedSigning(filePath) {
  if (process.platform !== 'win32') throw new Error('Azure Trusted Signing hook requires Windows');
  const target = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (!existsSync(target)) throw new Error(`Signing target does not exist: ${target}`);
  const signingScript = resolve(__dirname, '..', '..', 'build', 'signing', 'sign.ps1');
  if (!existsSync(signingScript)) throw new Error(`Signing script does not exist: ${signingScript}`);
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', signingScript,
    '-Path', target,
  ], {
    cwd: resolve(__dirname, '..', '..'),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Azure Trusted Signing failed for ${target} (exit ${result.status})`);
};
