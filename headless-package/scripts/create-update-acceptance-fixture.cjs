'use strict';

const { createHash, generateKeyPairSync } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { buildDeterministicTarGz, extractTarGz } = require('../../build/tar-util.js');
const { signManifest, verifyManifestBytes } = require('../../build/manifest-canonical.js');
const { buildReleaseManifestV3 } = require('../../build/release-manifest-v3.js');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceVersion(path, version) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.version = version;
  writeJson(path, value);
}

function publicArchiveName(arch, version) {
  return `empir3-bridge-linux-headless-${arch}-${version}.tar.gz`;
}

function buildPackageVariant({ baseArchive, outputRoot, arch, version, trust, broken = false }) {
  const work = join(outputRoot, `.work-${version}`);
  extractTarGz(baseArchive, work);
  try {
    writeFileSync(join(work, 'runtime', '.payload-version'), `${version}\n`);
    replaceVersion(join(work, 'runtime', 'package.json'), version);
    replaceVersion(join(work, 'package-metadata.json'), version);
    writeJson(join(work, 'runtime', 'trust', 'update-public-key.json'), trust);
    if (broken) {
      writeFileSync(
        join(work, 'runtime', 'src', 'headless-entry.js'),
        "throw new Error('intentional update-acceptance health failure');\n",
      );
    }
    const name = publicArchiveName(arch, version);
    const path = join(outputRoot, name);
    const bytes = buildDeterministicTarGz(work);
    writeFileSync(path, bytes);
    return { name, path, bytes: bytes.length, sha256: sha256(bytes), broken };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function makeIndex({ version, arch, artifact, baseUrl, rolloutState, previousVersion = '' }) {
  const target = `headless-linux-${arch}`;
  return {
    schemaVersion: 1,
    version,
    acceptanceOnly: true,
    rollout: {
      channel: 'acceptance',
      state: rolloutState,
      percent: 100,
      seed: `acceptance-${version}-${rolloutState}`,
      previousVersion,
    },
    health: { [target]: 'release-approved' },
    artifacts: [{
      id: `${target}-archive-tar.gz`,
      target,
      platform: 'linux',
      arch,
      kind: 'archive',
      format: 'tar.gz',
      sourceName: artifact.name,
      sourcePath: artifact.name,
      publicName: artifact.name,
      url: new URL(artifact.name, baseUrl).toString(),
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      // Acceptance fixtures use an ephemeral release-signing key. They are
      // never eligible for the production publisher or trust root.
      signed: true,
      authenticationScheme: 'ed25519-manifest-sha256',
    }],
  };
}

function writeRelease({ outputRoot, fileStem, index, baseUrl, privateKey, publicKeyHex }) {
  const indexName = `${fileStem}-index.json`;
  const manifestName = `${fileStem}-manifest.json`;
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(outputRoot, indexName), indexBytes);
  const manifest = buildReleaseManifestV3({
    version: index.version,
    payloadUrl: 'https://acceptance.invalid/legacy-payload.tar.gz',
    signatureUrl: 'https://acceptance.invalid/legacy-payload.sig',
    sha256: '0'.repeat(64),
    platform: 'linux',
    arch: index.artifacts[0].arch,
    publishedAt: '2026-08-04T00:00:00.000Z',
    acceptanceOnly: 'true',
  }, index, {
    artifactIndexUrl: new URL(indexName, baseUrl).toString(),
    artifactIndexSha256: sha256(indexBytes),
  });
  manifest.manifestSignature = signManifest(manifest, privateKey);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!verifyManifestBytes(manifestBytes, publicKeyHex)) {
    throw new Error(`Acceptance manifest self-verification failed: ${manifestName}`);
  }
  writeFileSync(join(outputRoot, manifestName), manifestBytes);
  return { manifestName, indexName, version: index.version, rolloutState: index.rollout.state };
}

function createUpdateAcceptanceFixture({
  baseArchive,
  outputRoot,
  baseUrl = 'http://127.0.0.1:18080/',
  keyPair = generateKeyPairSync('ed25519'),
} = {}) {
  if (!baseArchive || !existsSync(baseArchive) || !statSync(baseArchive).isFile()) {
    throw new Error('A real headless base archive is required');
  }
  if (!outputRoot) throw new Error('outputRoot is required');
  const output = resolve(outputRoot);
  if (existsSync(output)) throw new Error(`Refusing to overwrite acceptance fixture output: ${output}`);
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl must use HTTP or HTTPS');
  mkdirSync(output, { recursive: false });

  const inspectRoot = join(output, '.inspect-base');
  extractTarGz(baseArchive, inspectRoot);
  const metadata = JSON.parse(readFileSync(join(inspectRoot, 'package-metadata.json'), 'utf8'));
  rmSync(inspectRoot, { recursive: true, force: true });
  if (metadata.platform !== 'linux' || !['x64', 'arm64'].includes(metadata.arch)) {
    throw new Error('Acceptance base package must target Linux x64 or ARM64');
  }
  const arch = metadata.arch;
  const publicKeyDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyRaw = publicKeyDer.subarray(-32);
  const publicKeyHex = publicKeyRaw.toString('hex');
  const trust = {
    algorithm: 'ed25519',
    publicKeyHex,
    publicKeyB64: publicKeyRaw.toString('base64'),
    acceptanceOnly: true,
  };
  const packages = {
    base: buildPackageVariant({ baseArchive, outputRoot: output, arch, version: '0.3.55', trust }),
    update: buildPackageVariant({ baseArchive, outputRoot: output, arch, version: '0.3.56', trust }),
    bad: buildPackageVariant({ baseArchive, outputRoot: output, arch, version: '0.3.57', trust, broken: true }),
  };
  const releases = {
    update: writeRelease({
      outputRoot: output,
      fileStem: 'update-0.3.56',
      index: makeIndex({ version: '0.3.56', arch, artifact: packages.update, baseUrl: url, rolloutState: 'live' }),
      baseUrl: url,
      privateKey: keyPair.privateKey,
      publicKeyHex,
    }),
    rollback: writeRelease({
      outputRoot: output,
      fileStem: 'rollback-0.3.55',
      index: makeIndex({
        version: '0.3.55', arch, artifact: packages.base, baseUrl: url,
        rolloutState: 'rollback', previousVersion: '0.3.56',
      }),
      baseUrl: url,
      privateKey: keyPair.privateKey,
      publicKeyHex,
    }),
    bad: writeRelease({
      outputRoot: output,
      fileStem: 'bad-0.3.57',
      index: makeIndex({ version: '0.3.57', arch, artifact: packages.bad, baseUrl: url, rolloutState: 'live' }),
      baseUrl: url,
      privateKey: keyPair.privateKey,
      publicKeyHex,
    }),
  };
  const summary = {
    schemaVersion: 1,
    acceptanceOnly: true,
    baseArchive: basename(baseArchive),
    baseUrl: url.toString(),
    arch,
    publicKeyHex,
    packages: Object.fromEntries(Object.entries(packages).map(([name, value]) => [name, {
      name: value.name, bytes: value.bytes, sha256: value.sha256, broken: value.broken,
    }])),
    releases,
  };
  writeJson(join(output, 'fixture.json'), summary);
  writeFileSync(join(output, 'README.txt'), [
    'EMPIR3 BRIDGE UPDATE ACCEPTANCE FIXTURE',
    'Ephemeral local signing key. Loopback/disposable-test use only.',
    'Never publish these archives, indexes, manifests, or trust key.',
    '',
  ].join('\n'));
  return summary;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const result = createUpdateAcceptanceFixture({
    baseArchive: arg('--base-archive'),
    outputRoot: arg('--out'),
    baseUrl: arg('--base-url') || 'http://127.0.0.1:18080/',
  });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { createUpdateAcceptanceFixture };
