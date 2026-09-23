'use strict';

const { createHash } = require('node:crypto');
const {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { basename, join, relative, resolve } = require('node:path');
const { buildDeterministicTarGz, extractTarGz } = require('../../build/tar-util.js');
const { stageBridgeRuntime } = require('../../scripts/stage-bridge-runtime.cjs');

const packageRoot = resolve(__dirname, '..');
const bridgeRoot = resolve(packageRoot, '..');
const outRoot = join(packageRoot, 'out');
const stagingRoot = join(outRoot, 'staging');
const runtimeRoot = join(stagingRoot, 'runtime');
const bridgePackage = JSON.parse(readFileSync(join(bridgeRoot, 'package.json'), 'utf8'));
const hostPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
if (bridgePackage.version !== hostPackage.version) {
  throw new Error(`Release identity mismatch: Bridge ${bridgePackage.version}, headless ${hostPackage.version}`);
}
if (process.platform !== 'linux') throw new Error('Headless release packages must be built natively on Linux');
const packageArch = process.env.EMPIR3_HEADLESS_ARCH || process.arch;
if (!['x64', 'arm64'].includes(packageArch) || packageArch !== process.arch) {
  throw new Error(`Headless package ${packageArch} must be built on matching Linux hardware (${process.arch})`);
}

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
const runtime = stageBridgeRuntime({ runtimeRoot, packageArch });
for (const file of ['install.sh', 'uninstall.sh']) {
  cpSync(join(packageRoot, 'assets', file), join(stagingRoot, file));
}
cpSync(join(packageRoot, 'assets', 'headless-update.cjs'), join(runtimeRoot, 'src', 'headless-update.cjs'));
cpSync(join(packageRoot, 'src', 'install-config.cjs'), join(runtimeRoot, 'src', 'install-config.cjs'));
cpSync(join(bridgeRoot, 'desktop-shell', 'src', 'updater.cjs'), join(runtimeRoot, 'src', 'updater.cjs'));
cpSync(join(bridgeRoot, 'desktop-shell', 'src', 'release-index.cjs'), join(runtimeRoot, 'src', 'release-index.cjs'));
cpSync(join(bridgeRoot, 'build', 'tar-util.js'), join(runtimeRoot, 'src', 'tar-util.cjs'));
cpSync(join(packageRoot, 'README.md'), join(stagingRoot, 'README.md'));
mkdirSync(join(runtimeRoot, 'trust'), { recursive: true });
cpSync(join(bridgeRoot, 'build', 'payload-signing-pub.json'), join(runtimeRoot, 'trust', 'update-public-key.json'));
writeFileSync(join(stagingRoot, 'package-metadata.json'), `${JSON.stringify({
  schemaVersion: 1,
  product: 'Empir3 Bridge headless',
  version: bridgePackage.version,
  platform: 'linux',
  arch: packageArch,
  node: '>=22',
  service: 'empir3-bridge.service',
}, null, 2)}\n`);

const archiveName = `empir3-bridge-headless-${packageArch}-${bridgePackage.version}.tar.gz`;
const archivePath = join(outRoot, archiveName);
writeFileSync(archivePath, buildDeterministicTarGz(stagingRoot));
const verifyRoot = join(outRoot, 'verify-extract');
extractTarGz(archivePath, verifyRoot);
if (readFileSync(join(verifyRoot, 'runtime', '.payload-version'), 'utf8').trim() !== bridgePackage.version) {
  throw new Error('Extracted headless runtime version does not match the package');
}

const bytes = statSync(archivePath).size;
const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
const receipt = {
  schemaVersion: 1,
  version: bridgePackage.version,
  platform: 'linux',
  hostArch: process.arch,
  packageArch,
  hostType: 'headless',
  signed: false,
  artifacts: [{
    name: basename(archivePath),
    path: relative(packageRoot, archivePath).replaceAll('\\', '/'),
    bytes,
    sha256,
  }],
};
const receiptPath = join(outRoot, 'artifacts.json');
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, archivePath, receiptPath, bytes, sha256, runtime }, null, 2));
