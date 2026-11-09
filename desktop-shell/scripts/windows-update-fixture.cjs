'use strict';

// Test-only release policy, following the native macOS/Linux lifecycle gates.
// The installers remain the exact OS-signed release bytes. An ephemeral key
// authenticates only this in-memory rollout policy; no fleet manifest changes.
const { createHash, generateKeyPairSync } = require('node:crypto');
const { readFileSync, existsSync } = require('node:fs');
const { basename, join } = require('node:path');
const assert = require('node:assert/strict');
const { buildReleaseManifestV3 } = require('../../build/release-manifest-v3.js');
const { signManifest } = require('../../build/manifest-canonical.js');
const { checkForDesktopUpdate, downloadVerifiedArtifact, compareVersions } = require('../src/updater.cjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function windowsLifecycleVersions(candidateVersion, previousVersion) {
  for (const [label, version] of [['candidate', candidateVersion], ['previous', previousVersion]]) {
    if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)
      || version.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
      throw new Error(label + ' lifecycle version must be an explicit numeric release version');
    }
  }
  if (compareVersions(previousVersion, candidateVersion) >= 0) {
    throw new Error('Previous lifecycle version must be older than the candidate');
  }
  return { candidateVersion, previousVersion };
}

async function verifiedInstaller({ source, version, currentVersion, rollback, directory }) {
  const bytes = readFileSync(source);
  const keys = generateKeyPairSync('ed25519');
  const publicKeyHex = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const publicName = `empir3-bridge-windows-x64-${version}-setup.exe`;
  const artifactUrl = `https://windows-update.empir3.test/${publicName}`;
  const indexUrl = 'https://windows-update.empir3.test/index.json';
  const manifestUrl = 'https://windows-update.empir3.test/manifest.json';
  const artifact = {
    id: 'desktop-win32-x64-installer-exe', target: 'desktop-win32-x64',
    platform: 'win32', arch: 'x64', kind: 'installer', format: 'exe',
    sourceName: basename(source), sourcePath: source, publicName, url: artifactUrl,
    bytes: bytes.length, sha256: sha256(bytes), signed: true,
    authenticationScheme: 'authenticode-azure-trusted-signing',
  };
  const index = {
    schemaVersion: 1, version,
    rollout: { channel: 'production', state: rollback ? 'rollback' : 'live', percent: 100,
      seed: 'isolated-windows-lifecycle', previousVersion: currentVersion },
    health: { 'desktop-win32-x64': 'release-approved' }, artifacts: [artifact],
  };
  const indexBytes = Buffer.from(JSON.stringify(index));
  const manifest = buildReleaseManifestV3({ version,
    payloadUrl: 'https://windows-update.empir3.test/unused-legacy.tar.gz',
    signatureUrl: 'https://windows-update.empir3.test/unused-legacy.sig', sha256: '0'.repeat(64),
  }, index, { artifactIndexUrl: indexUrl, artifactIndexSha256: sha256(indexBytes) });
  manifest.manifestSignature = signManifest(manifest, keys.privateKey);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const fetcher = async url => {
    const body = url === manifestUrl ? manifestBytes : url === indexUrl ? indexBytes : url === artifactUrl ? bytes : null;
    return body ? new Response(body) : new Response('Not found', { status: 404 });
  };
  const result = await checkForDesktopUpdate({ manifestUrl, currentVersion,
    platform: 'win32', arch: 'x64', deviceId: 'isolated-windows-lifecycle', publicKeyHex, fetcher });
  assert.equal(result.status, rollback ? 'rollback-available' : 'available');
  if (rollback) {
    const wrongVersion = await checkForDesktopUpdate({ manifestUrl, currentVersion: `${Number(currentVersion.split('.')[0]) + 1}.0.0`,
      platform: 'win32', arch: 'x64', deviceId: 'isolated-windows-lifecycle', publicKeyHex, fetcher });
    assert.equal(wrongVersion.status, 'newer-local-version', 'Rollback must name the exact current version');
  }
  const rejectedPath = join(directory, `tampered-${version}.exe`);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(downloadVerifiedArtifact(result.artifact, rejectedPath, {
    fetcher: async () => new Response(tampered),
  }), /SHA-256/);
  assert.equal(existsSync(rejectedPath), false, 'Tampered installer must never become executable output');
  const downloaded = await downloadVerifiedArtifact(result.artifact, join(directory, publicName), { fetcher });
  assert.equal(downloaded.reused, false);
  assert.equal(sha256(readFileSync(downloaded.path)), artifact.sha256);
  return downloaded.path;
}

module.exports = { verifiedInstaller, windowsLifecycleVersions };
