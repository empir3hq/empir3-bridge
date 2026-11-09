import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildArtifactIndex } = require('../desktop-shell/src/release-index.cjs');
const { buildReleaseManifestV3, canPromoteDesktopManifestToLegacy, LEGACY_FIELDS } = require('../build/release-manifest-v3.js');
const { signManifest, verifyManifestBytes } = require('../build/manifest-canonical.js');

const H = 'b'.repeat(64);
function receipt(platform, packageArch, names, hostType = 'desktop') {
  return {
    schemaVersion: 1,
    version: '0.3.55',
    platform,
    hostArch: packageArch,
    packageArch,
    hostType,
    signed: false,
    artifacts: names.map((name, i) => ({ name, path: `out/${name}`, bytes: i + 1, sha256: H })),
  };
}
function makeIndex() {
  return buildArtifactIndex([
    receipt('win32', 'x64', ['setup.exe', 'full.nupkg', 'RELEASES', 'portable.zip']),
    receipt('darwin', 'universal', ['bridge.dmg', 'bridge.zip']),
    receipt('linux', 'x64', ['bridge.deb', 'bridge.zip']),
    receipt('linux', 'arm64', ['bridge.deb', 'bridge.zip']),
    receipt('linux', 'x64', ['bridge-headless-x64.tar.gz'], 'headless'),
    receipt('linux', 'arm64', ['bridge-headless-arm64.tar.gz'], 'headless'),
  ], { health: 'package-smoke-passed' });
}
function base() {
  return {
    version: '0.3.55',
    payloadUrl: 'https://cdn/payload.tgz',
    signatureUrl: 'https://cdn/payload.sig',
    sha256: H,
    schemaVersion: '2',
    nodeUrl: 'https://cdn/node.tgz',
    nodeSignatureUrl: 'https://cdn/node.sig',
    nodeSha256: H,
    nodeVersion: '22.17.0',
    nodeAbi: '127',
    platform: 'win32',
    arch: 'x64',
    publishedAt: '2026-08-04T00:00:00.000Z',
  };
}

test('schema 3 preserves every legacy Windows bootstrap field verbatim', () => {
  const old = base();
  const fields = buildReleaseManifestV3(old, makeIndex(), {
    artifactIndexUrl: 'https://cdn/artifacts.json',
    artifactIndexSha256: H,
  });
  for (const name of LEGACY_FIELDS) assert.equal(fields[name], old[name]);
  assert.equal(fields.schemaVersion, '3');
  assert.equal(fields.desktopDarwinUniversalInstallerFormat, 'dmg');
  assert.equal(fields.desktopLinuxArm64InstallerName, 'empir3-bridge-linux-arm64-0.3.55.deb');
  assert.equal(fields.desktopWin32X64Health, 'package-smoke-passed');
  assert.equal(fields.headlessLinuxArm64ArchiveFormat, 'tar.gz');
  assert.equal(fields.headlessLinuxArm64ArchiveAuthenticationScheme, 'unsigned');
  assert.equal(fields.headlessLinuxX64Health, 'package-smoke-passed');
  assert(Object.values(fields).every((value) => typeof value === 'string'));
});

test('existing signed-manifest trust root verifies schema 3 and detects tampering', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fields = buildReleaseManifestV3(base(), makeIndex(), {
    artifactIndexUrl: 'https://cdn/artifacts.json',
    artifactIndexSha256: H,
  });
  fields.manifestSignature = signManifest(fields, privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicHex = publicDer.subarray(-32).toString('hex');
  assert.equal(verifyManifestBytes(Buffer.from(JSON.stringify(fields)), publicHex), true);
  fields.desktopLinuxX64InstallerUrl += '?tampered=1';
  assert.equal(verifyManifestBytes(Buffer.from(JSON.stringify(fields)), publicHex), false);
});

test('schema 3 rejects a mismatched artifact release', () => {
  const wrong = makeIndex();
  wrong.version = '0.3.56';
  assert.throws(() => buildReleaseManifestV3(base(), wrong, {
    artifactIndexUrl: 'https://cdn/a',
    artifactIndexSha256: H,
  }), /does not match/);
});

test('only a fully live desktop release may touch the legacy Windows channel', () => {
  assert.equal(canPromoteDesktopManifestToLegacy({ schemaVersion: '3', rolloutState: 'hold', rolloutPercent: '0' }), false);
  assert.equal(canPromoteDesktopManifestToLegacy({ schemaVersion: '3', rolloutState: 'staged', rolloutPercent: '50' }), false);
  assert.equal(canPromoteDesktopManifestToLegacy({ schemaVersion: '3', rolloutState: 'rollback', rolloutPercent: '100' }), false);
  assert.equal(canPromoteDesktopManifestToLegacy({ schemaVersion: '3', rolloutState: 'live', rolloutPercent: '100' }), true);
});
