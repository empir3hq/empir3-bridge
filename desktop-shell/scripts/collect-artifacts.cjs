'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { basename, join, relative, resolve } = require('node:path');
const { staleVersionArtifacts } = require('../src/artifact-receipt.cjs');

const shellRoot = resolve(__dirname, '..');
const makeRoot = join(shellRoot, 'out', 'make');
const shellPackage = JSON.parse(readFileSync(join(shellRoot, 'package.json'), 'utf8'));
if (!existsSync(makeRoot)) throw new Error(`No Forge artifacts found at ${makeRoot}`);

function walk(root, files = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const allFiles = walk(makeRoot);
const distributables = allFiles.filter((file) => (
  /\.(exe|zip|dmg|deb|rpm|nupkg)$/i.test(file) || basename(file).toUpperCase() === 'RELEASES'
));
const staleArtifacts = staleVersionArtifacts(distributables, shellPackage.version);
if (staleArtifacts.length > 0) {
  throw new Error(`Forge output contains stale release artifacts: ${staleArtifacts.map((file) => basename(file)).join(', ')}`);
}
const requiredExtensions = process.platform === 'win32'
  ? ['.exe', '.zip', '.nupkg', 'RELEASES']
  : process.platform === 'darwin'
    ? ['.dmg', '.zip']
    : ['.deb', '.zip'];
for (const extension of requiredExtensions) {
  if (!distributables.some((file) => (
    extension === 'RELEASES' ? basename(file).toUpperCase() === 'RELEASES' : file.toLowerCase().endsWith(extension)
  ))) {
    throw new Error(`Missing required ${process.platform} artifact: ${extension}`);
  }
}

let signing = { signed: false, signingScheme: 'unsigned', verifiedFiles: 0 };
if (process.env.EMPIR3_RELEASE_SIGNED === '1') {
  const { verifyPlatformSignatures } = require('./verify-platform-signatures.cjs');
  signing = verifyPlatformSignatures();
}

const receipt = {
  schemaVersion: 1,
  version: shellPackage.version,
  platform: process.platform,
  hostArch: process.arch,
  packageArch: process.env.EMPIR3_DESKTOP_ARCH || process.arch,
  signed: signing.signed,
  signingScheme: signing.signingScheme,
  verifiedFiles: signing.verifiedFiles,
  artifacts: distributables.map((file) => ({
    name: basename(file),
    path: relative(shellRoot, file).replaceAll('\\', '/'),
    bytes: statSync(file).size,
    sha256: sha256(file),
  })),
};
const receiptPath = join(shellRoot, 'out', 'artifacts.json');
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, receiptPath, artifacts: receipt.artifacts.length }));
