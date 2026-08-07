'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { buildArtifactIndex } = require('../src/release-index.cjs');
const {
  canonicalizeManifest,
  checkForDesktopUpdate,
  checkForReleaseUpdate,
  downloadVerifiedArtifact,
  loadOrCreateUpdateState,
  parseAndVerifyManifest,
  writeHealthReceipt,
} = require('../src/updater.cjs');
const buildCanonical = require('../../build/manifest-canonical.js');
const { buildReleaseManifestV3 } = require('../../build/release-manifest-v3.js');

const H = 'c'.repeat(64);
const keys = generateKeyPairSync('ed25519');
const publicHex = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

function receipt(platform, packageArch, names, hostType = 'desktop') {
  const signingScheme = platform === 'win32'
    ? 'authenticode-azure-trusted-signing'
    : platform === 'darwin'
      ? 'apple-developer-id-notarized-stapled'
      : 'ed25519-manifest-sha256';
  return {
    schemaVersion: 1, version: '0.3.55', platform, packageArch, hostArch: packageArch, hostType, signed: true, signingScheme,
    artifacts: names.map((name, i) => ({ name, path: `out/${name}`, bytes: i + 10, sha256: H })),
  };
}

function makeWorld({ rolloutState = 'live', rolloutPercent = 100, previousVersion = '' } = {}) {
  const index = buildArtifactIndex([
    receipt('win32', 'x64', ['setup.exe', 'full.nupkg', 'RELEASES', 'portable.zip']),
    receipt('darwin', 'universal', ['bridge.dmg', 'bridge.zip']),
    receipt('linux', 'x64', ['bridge.deb', 'bridge.zip']),
    receipt('linux', 'arm64', ['bridge.deb', 'bridge.zip']),
    receipt('linux', 'x64', ['bridge-headless-x64.tar.gz'], 'headless'),
    receipt('linux', 'arm64', ['bridge-headless-arm64.tar.gz'], 'headless'),
  ], {
    rolloutState, rolloutPercent, rolloutSeed: 'release-a', previousVersion,
    channel: 'stable', health: 'release-approved', baseUrl: 'https://cdn.example.test/',
  });
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  const base = {
    version: '0.3.55', payloadUrl: 'https://cdn/payload.tgz', signatureUrl: 'https://cdn/payload.sig', sha256: H,
    schemaVersion: '2', nodeUrl: 'https://cdn/node.tgz', nodeSignatureUrl: 'https://cdn/node.sig', nodeSha256: H,
    nodeVersion: '22.17.0', nodeAbi: '127', platform: 'win32', arch: 'x64', publishedAt: '2026-08-04T00:00:00.000Z',
  };
  const manifest = buildReleaseManifestV3(base, index, {
    artifactIndexUrl: 'https://cdn.example.test/index.json',
    artifactIndexSha256: createHash('sha256').update(indexBytes).digest('hex'),
  });
  manifest.manifestSignature = buildCanonical.signManifest(manifest, keys.privateKey);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const fetcher = async (url) => {
    if (url === 'https://cdn.example.test/manifest.json') return new Response(manifestBytes);
    if (url === manifest.artifactIndexUrl) return new Response(indexBytes);
    return new Response('missing', { status: 404 });
  };
  return { index, indexBytes, manifest, manifestBytes, fetcher };
}

test('desktop verifier stays byte-identical to the build signer canonicalizer', () => {
  const fields = { z: 'a&b<c>d', a: 'https://x/y?v=1&t=2', manifestSignature: 'ignored' };
  assert.deepEqual(canonicalizeManifest(fields), buildCanonical.canonicalizeManifest(fields));
});

test('selects the exact signed healthy installer for the current target', async () => {
  const world = makeWorld();
  const result = await checkForDesktopUpdate({
    manifestUrl: 'https://cdn.example.test/manifest.json', currentVersion: '0.3.54',
    platform: 'linux', arch: 'arm64', deviceId: 'device-123', publicKeyHex: publicHex, fetcher: world.fetcher,
  });
  assert.equal(result.status, 'available');
  assert.equal(result.artifact.target, 'desktop-linux-arm64');
  assert.equal(result.artifact.format, 'deb');
});

test('selects the exact signed headless archive for a Linux server', async () => {
  const world = makeWorld();
  const result = await checkForReleaseUpdate({
    manifestUrl: 'https://cdn.example.test/manifest.json', currentVersion: '0.3.54',
    platform: 'linux', arch: 'x64', hostType: 'headless', artifactKind: 'archive',
    deviceId: 'server-123', publicKeyHex: publicHex, fetcher: world.fetcher,
  });
  assert.equal(result.status, 'available');
  assert.equal(result.artifact.target, 'headless-linux-x64');
  assert.equal(result.artifact.format, 'tar.gz');
});

test('held release stops before fetching the artifact index', async () => {
  const world = makeWorld({ rolloutState: 'hold', rolloutPercent: 0 });
  const calls = [];
  const result = await checkForDesktopUpdate({
    manifestUrl: 'https://cdn.example.test/manifest.json', currentVersion: '0.3.54',
    platform: 'win32', arch: 'x64', deviceId: 'device-123', publicKeyHex: publicHex,
    fetcher: async (url, init) => { calls.push(url); return world.fetcher(url, init); },
  });
  assert.equal(result.status, 'held');
  assert.deepEqual(calls, ['https://cdn.example.test/manifest.json']);
});

test('signed rollback only allows the explicitly named bad current version', async () => {
  const world = makeWorld({ rolloutState: 'rollback', rolloutPercent: 100, previousVersion: '0.3.56' });
  world.manifest.version = '0.3.54';
  world.index.version = '0.3.54';
  world.indexBytes = Buffer.from(`${JSON.stringify(world.index, null, 2)}\n`);
  world.manifest.artifactIndexSha256 = createHash('sha256').update(world.indexBytes).digest('hex');
  world.manifest.manifestSignature = buildCanonical.signManifest(world.manifest, keys.privateKey);
  const manifestBytes = Buffer.from(JSON.stringify(world.manifest));
  const fetcher = async (url) => url.endsWith('manifest.json') ? new Response(manifestBytes) : new Response(world.indexBytes);
  const result = await checkForDesktopUpdate({
    manifestUrl: 'https://cdn.example.test/manifest.json', currentVersion: '0.3.56',
    platform: 'darwin', arch: 'arm64', deviceId: 'device-123', publicKeyHex: publicHex, fetcher,
  });
  assert.equal(result.status, 'rollback-available');
});

test('tampering any signed desktop field is rejected', () => {
  const world = makeWorld();
  world.manifest.desktopLinuxX64InstallerUrl += '?tampered=1';
  assert.throws(() => parseAndVerifyManifest(Buffer.from(JSON.stringify(world.manifest)), publicHex), /signature is invalid/);
});

test('downloads to a temporary file and verifies bytes before promoting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-update-'));
  try {
    const bytes = Buffer.from('signed installer bytes');
    const artifact = {
      url: 'https://cdn.example.test/setup.exe', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const destination = join(root, 'setup.exe');
    const result = await downloadVerifiedArtifact(artifact, destination, {
      fetcher: async () => new Response(bytes),
    });
    assert.equal(result.reused, false);
    assert.deepEqual(readFileSync(destination), bytes);
    const reused = await downloadVerifiedArtifact(artifact, destination, {
      fetcher: async () => { throw new Error('should not fetch'); },
    });
    assert.equal(reused.reused, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt installer never replaces the final path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-update-bad-'));
  try {
    const destination = join(root, 'setup.exe');
    await assert.rejects(downloadVerifiedArtifact({
      url: 'https://cdn.example.test/setup.exe', bytes: 4, sha256: H,
    }, destination, { fetcher: async () => new Response('evil') }), /SHA-256/);
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update identity is stable and startup health receipt is local', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-update-state-'));
  try {
    const statePath = join(root, 'update-state.json');
    assert.equal(loadOrCreateUpdateState(statePath, { makeDeviceId: () => 'device-fixed' }).deviceId, 'device-fixed');
    assert.equal(loadOrCreateUpdateState(statePath, { makeDeviceId: () => 'different-id' }).deviceId, 'device-fixed');
    const receiptPath = join(root, 'update-health.json');
    writeHealthReceipt(receiptPath, { version: '0.3.55', platform: 'win32', arch: 'x64', bridgeHealthy: true, startupHealthyAt: 0 });
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.bridgeHealthy, true);
    assert.equal(receipt.version, '0.3.55');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
