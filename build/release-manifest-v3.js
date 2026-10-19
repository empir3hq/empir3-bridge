'use strict';

const LEGACY_FIELDS = ['version', 'payloadUrl', 'signatureUrl', 'sha256'];
const TARGET_PREFIX = {
  'desktop-win32-x64': 'desktopWin32X64',
  'desktop-darwin-universal': 'desktopDarwinUniversal',
  'desktop-linux-x64': 'desktopLinuxX64',
  'desktop-linux-arm64': 'desktopLinuxArm64',
  'headless-linux-x64': 'headlessLinuxX64',
  'headless-linux-arm64': 'headlessLinuxArm64',
};
const KIND_SUFFIX = {
  installer: 'Installer',
  archive: 'Archive',
  'update-package': 'UpdatePackage',
  'update-metadata': 'UpdateMetadata',
};

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || /[^\x20-\x7e]/.test(value)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} printable ASCII string`);
  }
  return value;
}

function artifactFieldPrefix(artifact) {
  const target = TARGET_PREFIX[artifact.target];
  const kind = KIND_SUFFIX[artifact.kind];
  if (!target || !kind) throw new Error(`Unsupported manifest artifact ${artifact.target}/${artifact.kind}`);
  return `${target}${kind}`;
}

function buildReleaseManifestV3(baseFields, index, options = {}) {
  if (!baseFields || typeof baseFields !== 'object' || Array.isArray(baseFields)) {
    throw new Error('Base release manifest fields are required');
  }
  for (const field of LEGACY_FIELDS) assertString(baseFields[field], `legacy manifest field ${field}`);
  if (index?.schemaVersion !== 1 || !Array.isArray(index.artifacts)) {
    throw new Error('A schema 1 universal artifact index is required');
  }
  if (index.version !== baseFields.version) {
    throw new Error(`Artifact index version ${index.version} does not match payload ${baseFields.version}`);
  }

  const fields = {};
  for (const [key, value] of Object.entries(baseFields)) {
    if (key === 'manifestSignature') continue;
    fields[assertString(key, 'manifest field name')] = assertString(value, `manifest field ${key}`, { allowEmpty: true });
  }
  const rollout = index.rollout || {};
  fields.schemaVersion = '3';
  fields.releaseChannel = assertString(rollout.channel, 'release channel');
  fields.rolloutState = assertString(rollout.state, 'rollout state');
  fields.rolloutPercent = String(rollout.percent);
  fields.rolloutSeed = assertString(rollout.seed, 'rollout seed');
  fields.previousVersion = assertString(rollout.previousVersion || '', 'previous version', { allowEmpty: true });
  fields.artifactIndexUrl = assertString(options.artifactIndexUrl, 'artifact index URL');
  fields.artifactIndexSha256 = assertString(options.artifactIndexSha256, 'artifact index sha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fields.artifactIndexSha256)) {
    throw new Error('artifact index sha256 must be 64 lowercase hex characters');
  }
  fields.desktopArtifactCount = String(index.artifacts.length);
  fields.releaseArtifactCount = String(index.artifacts.length);

  const prefixes = new Set();
  for (const artifact of index.artifacts) {
    const prefix = artifactFieldPrefix(artifact);
    if (prefixes.has(prefix)) throw new Error(`Duplicate manifest artifact field group ${prefix}`);
    prefixes.add(prefix);
    fields[`${prefix}Url`] = assertString(artifact.url, `${prefix} URL`);
    fields[`${prefix}Sha256`] = assertString(artifact.sha256, `${prefix} sha256`).toLowerCase();
    fields[`${prefix}Bytes`] = String(artifact.bytes);
    fields[`${prefix}Name`] = assertString(artifact.publicName, `${prefix} name`);
    fields[`${prefix}Format`] = assertString(artifact.format, `${prefix} format`);
    fields[`${prefix}Signed`] = artifact.signed === true ? 'true' : 'false';
    fields[`${prefix}AuthenticationScheme`] = assertString(
      artifact.authenticationScheme,
      `${prefix} authentication scheme`,
    );
  }
  for (const [target, prefix] of Object.entries(TARGET_PREFIX)) {
    fields[`${prefix}Health`] = assertString(index.health?.[target] || 'unverified', `${target} health`);
  }
  return fields;
}

function canPromoteDesktopManifestToLegacy(fields) {
  return fields?.schemaVersion === '3'
    && fields.rolloutState === 'live'
    && fields.rolloutPercent === '100';
}

module.exports = {
  LEGACY_FIELDS,
  artifactFieldPrefix,
  buildReleaseManifestV3,
  canPromoteDesktopManifestToLegacy,
};
