'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

if (process.platform !== 'darwin') throw new Error('macOS update fixture versioning requires a native Mac');
if (process.env.CI !== 'true' && process.env.EMPIR3_MAC_UPDATE_FIXTURE_ALLOW_SOURCE_EDIT !== '1') {
  throw new Error('Update fixture versioning edits package identity and is restricted to disposable CI checkouts');
}

const shellRoot = resolve(__dirname, '..');
const root = resolve(shellRoot, '..');
const packagePaths = [resolve(root, 'package.json'), resolve(shellRoot, 'package.json')];
const packages = packagePaths.map((path) => ({ path, value: JSON.parse(readFileSync(path, 'utf8')) }));
const versions = new Set(packages.map(({ value }) => value.version));
if (versions.size !== 1) throw new Error(`Bridge and desktop versions differ: ${[...versions].join(', ')}`);
const baseVersion = [...versions][0];
const match = String(baseVersion).match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) throw new Error(`Cannot synthesize update from non-release version ${baseVersion}`);
const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;

for (const entry of packages) {
  entry.value.version = nextVersion;
  writeFileSync(entry.path, `${JSON.stringify(entry.value, null, 2)}\n`);
}
process.stdout.write(`${nextVersion}\n`);
