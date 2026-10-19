'use strict';

const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { stageBridgeRuntime } = require('../../scripts/stage-bridge-runtime.cjs');

const shellRoot = resolve(__dirname, '..');
const bridgeRoot = resolve(shellRoot, '..');
const bridgePackage = JSON.parse(readFileSync(join(bridgeRoot, 'package.json'), 'utf8'));
const shellPackage = JSON.parse(readFileSync(join(shellRoot, 'package.json'), 'utf8'));
if (bridgePackage.version !== shellPackage.version) {
  throw new Error(`Release identity mismatch: Bridge ${bridgePackage.version}, desktop ${shellPackage.version}`);
}

const result = stageBridgeRuntime({
  runtimeRoot: join(shellRoot, '.runtime', 'bridge'),
  packageArch: process.env.EMPIR3_DESKTOP_ARCH || process.arch,
});
console.log(JSON.stringify(result));
