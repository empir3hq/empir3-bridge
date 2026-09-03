'use strict';

const { basename, extname } = require('node:path');
const { createHash } = require('node:crypto');

const INDEX_SCHEMA_VERSION = 1;
// Every updater deployed since signed release indexes launched understands
// these values. A production/live index must stay within this vocabulary or
// older clients reject a perfectly good release and become stranded.
const DEPLOYED_UPDATER_HEALTH_STATES = new Set([
  'healthy',
  'package-smoke-passed',
  'release-approved',
]);
const REQUIRED_TARGETS = [
  'desktop-win32-x64',
  'desktop-darwin-universal',
  'desktop-linux-x64',
  'desktop-linux-arm64',
  'headless-linux-x64',
  'headless-linux-arm64',
];

const TARGET_LABELS = {
  'desktop-win32-x64': { platform: 'win32', arch: 'x64', publicPlatform: 'windows' },
  'desktop-darwin-universal': { platform: 'darwin', arch: 'universal', publicPlatform: 'macos' },
  'desktop-linux-x64': { platform: 'linux', arch: 'x64', publicPlatform: 'linux' },
  'desktop-linux-arm64': { platform: 'linux', arch: 'arm64', publicPlatform: 'linux' },
  'headless-linux-x64': { platform: 'linux', arch: 'x64', publicPlatform: 'linux-headless' },
  'headless-linux-arm64': { platform: 'linux', arch: 'arm64', publicPlatform: 'linux-headless' },
};

const REQUIRED_KINDS = {
  'desktop-win32-x64': ['installer:exe', 'archive:zip', 'update-package:nupkg', 'update-metadata:squirrel-releases'],
  'desktop-darwin-universal': ['installer:dmg', 'archive:zip'],
  'desktop-linux-x64': ['installer:deb', 'archive:zip'],
  'desktop-linux-arm64': ['installer:deb', 'archive:zip'],
  'headless-linux-x64': ['archive:tar.gz'],
  'headless-linux-arm64': ['archive:tar.gz'],
};

function assertPrintable(value, label) {
  if (typeof value !== 'string' || !value || /[^\x20-\x7e]/.test(value)) {
    throw new Error(`${label} must be a non-empty printable ASCII string`);
  }
  return value;
}

function targetForReceipt(receipt) {
  const platform = receipt?.platform;
  const arch = receipt?.packageArch;
  const hostType = receipt?.hostType || 'desktop';
  const target = `${hostType}-${platform}-${arch}`;
  if (!TARGET_LABELS[target]) {
    throw new Error(`Unsupported desktop receipt target: ${platform || '?'} / ${arch || '?'}`);
  }
  return target;
}

function classifyArtifact(name) {
  if (basename(name).toUpperCase() === 'RELEASES') {
    return { kind: 'update-metadata', format: 'squirrel-releases' };
  }
  if (name.toLowerCase().endsWith('.tar.gz')) return { kind: 'archive', format: 'tar.gz' };
  const extension = extname(name).slice(1).toLowerCase();
  if (extension === 'exe' || extension === 'dmg' || extension === 'deb' || extension === 'rpm') {
    return { kind: 'installer', format: extension };
  }
  if (extension === 'zip') return { kind: 'archive', format: 'zip' };
  if (extension === 'nupkg') return { kind: 'update-package', format: 'nupkg' };
  throw new Error(`Unsupported desktop release artifact: ${name}`);
}

function publicNameFor({ target, version, sourceName, kind, format }) {
  const info = TARGET_LABELS[target];
  const prefix = `empir3-bridge-${info.publicPlatform}-${info.arch}-${version}`;
  if (kind === 'installer') {
    return format === 'exe' ? `${prefix}-setup.exe` : `${prefix}.${format}`;
  }
  if (kind === 'archive') return format === 'zip' ? `${prefix}-portable.zip` : `${prefix}.${format}`;
  // Squirrel's RELEASES file names the nupkg. Keep both names untouched until
  // the publisher rewrites and re-hashes the pair atomically.
  if (kind === 'update-package' || kind === 'update-metadata') return basename(sourceName);
  throw new Error(`Cannot name artifact kind ${kind}`);
}

function normalizeRollout(options = {}) {
  const rolloutPercent = Number(options.rolloutPercent ?? 0);
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new Error('rolloutPercent must be an integer from 0 through 100');
  }
  const state = options.rolloutState || 'hold';
  if (!['hold', 'staged', 'live', 'rollback'].includes(state)) {
    throw new Error(`Unsupported rolloutState: ${state}`);
  }
  if (state === 'hold' && rolloutPercent !== 0) {
    throw new Error('A held release must have rolloutPercent 0');
  }
  if (state === 'live' && rolloutPercent !== 100) {
    throw new Error('A live release must have rolloutPercent 100');
  }
  return {
    channel: assertPrintable(options.channel || 'test', 'channel'),
    state,
    percent: rolloutPercent,
    seed: assertPrintable(options.rolloutSeed || 'unpublished', 'rolloutSeed'),
    previousVersion: options.previousVersion ? assertPrintable(options.previousVersion, 'previousVersion') : '',
  };
}

function buildArtifactIndex(receipts, options = {}) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error('At least one desktop artifact receipt is required');
  }
  const baseUrl = assertPrintable(options.baseUrl || 'https://app.empir3.com/downloads/', 'baseUrl');
  const versions = new Set(receipts.map((receipt) => assertPrintable(receipt?.version, 'receipt version')));
  if (versions.size !== 1) {
    throw new Error(`All desktop artifacts must share one version (got ${[...versions].join(', ')})`);
  }
  const version = [...versions][0];
  const rollout = normalizeRollout(options);
  const authenticateLinuxWithManifest = options.authenticateLinuxWithManifest === true;
  if (authenticateLinuxWithManifest && rollout.channel !== 'production') {
    throw new Error('Linux manifest authentication is restricted to the production release channel');
  }
  const artifacts = [];
  const receiptTargets = new Set();
  const uniqueKinds = new Set();

  for (const receipt of receipts) {
    if (receipt.schemaVersion !== 1) throw new Error(`Unsupported artifact receipt schema: ${receipt.schemaVersion}`);
    const target = targetForReceipt(receipt);
    const manifestAuthenticatedLinux = authenticateLinuxWithManifest && receipt.platform === 'linux';
    const authenticated = receipt.signed === true || manifestAuthenticatedLinux;
    const authenticationScheme = manifestAuthenticatedLinux
      ? 'ed25519-manifest-sha256'
      : assertPrintable(receipt.signingScheme || (authenticated ? 'platform-signature' : 'unsigned'), `${target} signing scheme`);
    if (receiptTargets.has(target)) throw new Error(`Duplicate artifact receipt for ${target}`);
    receiptTargets.add(target);
    if (!Array.isArray(receipt.artifacts)) throw new Error(`Receipt ${target} has no artifacts array`);

    for (const source of receipt.artifacts) {
      const sourceName = assertPrintable(source?.name, `${target} artifact name`);
      const sourcePath = assertPrintable(source?.path, `${target} artifact path`);
      const sha256 = assertPrintable(source?.sha256, `${target} artifact sha256`).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${target}/${sourceName} has an invalid sha256`);
      if (!Number.isSafeInteger(source?.bytes) || source.bytes <= 0) {
        throw new Error(`${target}/${sourceName} has invalid byte size`);
      }
      const { kind, format } = classifyArtifact(sourceName);
      const kindKey = `${target}:${kind}:${format}`;
      if (uniqueKinds.has(kindKey)) throw new Error(`Duplicate ${kind}:${format} artifact for ${target}`);
      uniqueKinds.add(kindKey);
      const publicName = publicNameFor({ target, version, sourceName, kind, format });
      const url = new URL(encodeURIComponent(publicName), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
      artifacts.push({
        id: `${target}-${kind}-${format}`,
        target,
        platform: TARGET_LABELS[target].platform,
        arch: TARGET_LABELS[target].arch,
        kind,
        format,
        sourceName,
        sourcePath,
        publicName,
        url,
        bytes: source.bytes,
        sha256,
        // `signed` is retained for schema-3 compatibility and means that the
        // artifact is authenticated strongly enough for production delivery.
        // Windows/macOS get that state from verified platform signatures;
        // Linux gets it only when this exact index is hash-bound by the signed
        // Ed25519 release manifest.
        signed: authenticated,
        authenticationScheme,
      });
    }
  }

  if (options.requireAllTargets !== false) {
    for (const target of REQUIRED_TARGETS) {
      if (!receiptTargets.has(target)) throw new Error(`Missing required desktop artifact receipt: ${target}`);
      for (const kind of REQUIRED_KINDS[target]) {
        if (!uniqueKinds.has(`${target}:${kind}`)) throw new Error(`Missing required ${kind} artifact for ${target}`);
      }
    }
  }

  artifacts.sort((a, b) => a.id.localeCompare(b.id));
  const health = {};
  for (const target of [...receiptTargets].sort()) {
    health[target] = assertPrintable(
      options.healthByTarget?.[target] || options.health || 'unverified',
      `${target} health`,
    );
  }
  if (rollout.channel === 'production' && rollout.state === 'live') {
    for (const [target, state] of Object.entries(health)) {
      if (!DEPLOYED_UPDATER_HEALTH_STATES.has(state)) {
        throw new Error(`${target} health ${state} is not understood by deployed updaters`);
      }
    }
  }
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    version,
    rollout,
    health,
    artifacts,
  };
}

function targetForClient(platform, arch, hostType = 'desktop') {
  if (hostType === 'headless') {
    const target = `headless-${platform}-${arch}`;
    if (!TARGET_LABELS[target]) throw new Error(`No Empir3 Bridge headless package for ${platform}/${arch}`);
    return target;
  }
  if (hostType !== 'desktop') throw new Error(`Unsupported Bridge host type: ${hostType}`);
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64' || arch === 'universal')) {
    return 'desktop-darwin-universal';
  }
  const target = `desktop-${platform}-${arch}`;
  if (!TARGET_LABELS[target]) throw new Error(`No Empir3 Bridge desktop package for ${platform}/${arch}`);
  return target;
}

function selectArtifact(index, { platform, arch, hostType = 'desktop', kind = 'installer', format } = {}) {
  if (index?.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(index.artifacts)) {
    throw new Error('Unsupported or malformed desktop artifact index');
  }
  const target = targetForClient(platform, arch, hostType);
  const matches = index.artifacts.filter((artifact) => (
    artifact.target === target && artifact.kind === kind && (!format || artifact.format === format)
  ));
  if (matches.length !== 1) {
    const qualifier = format ? `${kind}:${format}` : kind;
    throw new Error(`Expected exactly one ${qualifier} artifact for ${target}; found ${matches.length}`);
  }
  return matches[0];
}

function isProductionAuthenticated(artifact) {
  if (artifact?.signed !== true) return false;
  if (artifact.platform === 'win32') {
    return artifact.authenticationScheme === 'authenticode-azure-trusted-signing';
  }
  if (artifact.platform === 'darwin') {
    return artifact.authenticationScheme === 'apple-developer-id-notarized-stapled';
  }
  if (artifact.platform === 'linux') {
    return artifact.authenticationScheme === 'ed25519-manifest-sha256';
  }
  return false;
}

function isEligibleForRollout(index, deviceId) {
  const rollout = index?.rollout;
  if (!rollout || typeof rollout !== 'object') throw new Error('Artifact index has no rollout policy');
  if (rollout.state === 'hold') return false;
  if (rollout.state === 'live' || rollout.state === 'rollback') return true;
  if (rollout.state !== 'staged') throw new Error(`Unsupported rollout state: ${rollout.state}`);
  const id = assertPrintable(deviceId, 'deviceId');
  const seed = assertPrintable(rollout.seed, 'rollout seed');
  const digest = createHash('sha256').update(`${seed}\0${id}`, 'utf8').digest();
  const bucket = digest.readUInt32BE(0) / 0x100000000 * 100;
  return bucket < rollout.percent;
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  REQUIRED_TARGETS,
  buildArtifactIndex,
  isEligibleForRollout,
  isProductionAuthenticated,
  selectArtifact,
  targetForReceipt,
  targetForClient,
};
