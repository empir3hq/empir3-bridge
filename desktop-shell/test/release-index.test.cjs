'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildArtifactIndex,
  isEligibleForRollout,
  isProductionAuthenticated,
  selectArtifact,
  targetForClient,
  targetForReceipt,
} = require('../src/release-index.cjs');

const H = 'a'.repeat(64);
function receipt(platform, packageArch, names, version = '0.3.55', hostType = 'desktop') {
  return {
    schemaVersion: 1,
    version,
    platform,
    hostArch: packageArch === 'universal' ? 'arm64' : packageArch,
    packageArch,
    hostType,
    signed: false,
    artifacts: names.map((name, i) => ({ name, path: `out/make/${name}`, bytes: 1000 + i, sha256: H })),
  };
}

function fullReceipts() {
  return [
    receipt('win32', 'x64', ['Empir3 Bridge-0.3.55 Setup.exe', 'empir3_bridge-0.3.55-full.nupkg', 'RELEASES', 'Empir3 Bridge-win32-x64-0.3.55.zip']),
    receipt('darwin', 'universal', ['Empir3 Bridge.dmg', 'Empir3 Bridge-darwin-universal-0.3.55.zip']),
    receipt('linux', 'x64', ['empir3-bridge-desktop_0.3.55_amd64.deb', 'Empir3 Bridge-linux-x64-0.3.55.zip']),
    receipt('linux', 'arm64', ['empir3-bridge-desktop_0.3.55_arm64.deb', 'Empir3 Bridge-linux-arm64-0.3.55.zip']),
    receipt('linux', 'x64', ['empir3-bridge-headless-x64-0.3.55.tar.gz'], '0.3.55', 'headless'),
    receipt('linux', 'arm64', ['empir3-bridge-headless-arm64-0.3.55.tar.gz'], '0.3.55', 'headless'),
  ];
}

test('builds a complete deterministic desktop release index', () => {
  const index = buildArtifactIndex(fullReceipts(), { baseUrl: 'https://cdn.example.test/downloads' });
  assert.equal(index.version, '0.3.55');
  assert.equal(index.rollout.state, 'hold');
  assert.equal(index.rollout.percent, 0);
  assert.equal(index.artifacts.length, 12);
  assert.equal(selectArtifact(index, { platform: 'win32', arch: 'x64' }).publicName,
    'empir3-bridge-windows-x64-0.3.55-setup.exe');
  assert.equal(selectArtifact(index, { platform: 'linux', arch: 'arm64' }).publicName,
    'empir3-bridge-linux-arm64-0.3.55.deb');
  assert.equal(selectArtifact(index, { platform: 'linux', arch: 'x64', kind: 'archive' }).format, 'zip');
  assert.equal(selectArtifact(index, { platform: 'linux', arch: 'arm64', hostType: 'headless', kind: 'archive' }).format, 'tar.gz');
});

test('maps both Mac processor families to the one universal package', () => {
  assert.equal(targetForClient('darwin', 'x64'), 'desktop-darwin-universal');
  assert.equal(targetForClient('darwin', 'arm64'), 'desktop-darwin-universal');
  const index = buildArtifactIndex(fullReceipts());
  assert.equal(selectArtifact(index, { platform: 'darwin', arch: 'x64' }).format, 'dmg');
  assert.equal(selectArtifact(index, { platform: 'darwin', arch: 'arm64' }).format, 'dmg');
});

test('receipt source lookup keeps desktop and headless Linux targets distinct', () => {
  assert.equal(targetForReceipt(receipt('linux', 'x64', ['bridge.deb', 'bridge.zip'])), 'desktop-linux-x64');
  assert.equal(targetForReceipt(receipt('linux', 'x64', ['bridge.tar.gz'], '0.3.55', 'headless')), 'headless-linux-x64');
});

test('refuses an unsupported architecture instead of guessing', () => {
  assert.throws(() => targetForClient('win32', 'arm64'), /No Empir3 Bridge desktop package/);
  assert.throws(() => targetForClient('linux', 'riscv64'), /No Empir3 Bridge desktop package/);
  assert.throws(() => targetForClient('darwin', 'arm64', 'headless'), /No Empir3 Bridge headless package/);
});

test('refuses duplicate targets and mixed release versions', () => {
  const receipts = fullReceipts();
  assert.throws(() => buildArtifactIndex([...receipts, receipts[0]]), /Duplicate artifact receipt/);
  const mixed = fullReceipts();
  mixed[3] = receipt('linux', 'arm64', ['a.deb', 'a.zip'], '0.3.56');
  assert.throws(() => buildArtifactIndex(mixed), /must share one version/);
});

test('enforces hold/live rollout safety invariants', () => {
  assert.throws(() => buildArtifactIndex(fullReceipts(), { rolloutState: 'hold', rolloutPercent: 1 }), /held release/);
  assert.throws(() => buildArtifactIndex(fullReceipts(), { rolloutState: 'live', rolloutPercent: 99 }), /live release/);
  const staged = buildArtifactIndex(fullReceipts(), { rolloutState: 'staged', rolloutPercent: 25, rolloutSeed: 'stage-a' });
  assert.equal(staged.rollout.percent, 25);
  assert.equal(isEligibleForRollout(staged, 'device-123'), isEligibleForRollout(staged, 'device-123'));
  assert.equal(isEligibleForRollout(buildArtifactIndex(fullReceipts()), 'device-123'), false);
  assert.equal(isEligibleForRollout(buildArtifactIndex(fullReceipts(), { rolloutState: 'live', rolloutPercent: 100 }), 'device-123'), true);
});

test('Linux manifest authentication is explicit and production-only', () => {
  assert.throws(
    () => buildArtifactIndex(fullReceipts(), { authenticateLinuxWithManifest: true }),
    /restricted to the production release channel/,
  );
  const receipts = fullReceipts();
  receipts[0].signed = true;
  receipts[0].signingScheme = 'authenticode-azure-trusted-signing';
  receipts[1].signed = true;
  receipts[1].signingScheme = 'apple-developer-id-notarized-stapled';
  const index = buildArtifactIndex(receipts, {
    channel: 'production',
    authenticateLinuxWithManifest: true,
  });
  const windows = index.artifacts.find((artifact) => artifact.target === 'desktop-win32-x64');
  const mac = index.artifacts.find((artifact) => artifact.target === 'desktop-darwin-universal');
  const linux = index.artifacts.find((artifact) => artifact.target === 'desktop-linux-x64');
  const headless = index.artifacts.find((artifact) => artifact.target === 'headless-linux-arm64');
  assert.equal(windows.signed, true);
  assert.equal(windows.authenticationScheme, 'authenticode-azure-trusted-signing');
  assert.equal(isProductionAuthenticated(windows), true);
  assert.equal(mac.signed, true);
  assert.equal(mac.authenticationScheme, 'apple-developer-id-notarized-stapled');
  assert.equal(isProductionAuthenticated(mac), true);
  assert.equal(linux.signed, true);
  assert.equal(linux.authenticationScheme, 'ed25519-manifest-sha256');
  assert.equal(isProductionAuthenticated(linux), true);
  assert.equal(headless.signed, true);
  assert.equal(headless.authenticationScheme, 'ed25519-manifest-sha256');
  assert.equal(isProductionAuthenticated(headless), true);
  assert.equal(isProductionAuthenticated({ ...linux, authenticationScheme: 'unsigned' }), false);
});
