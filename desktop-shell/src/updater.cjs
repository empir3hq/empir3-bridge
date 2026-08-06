'use strict';

const {
  createHash,
  createPublicKey,
  randomUUID,
  verify,
} = require('node:crypto');
const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isEligibleForRollout, isProductionAuthenticated, selectArtifact } = require('./release-index.cjs');

// This MUST stay separate from bridge-version.json. Installed legacy Windows
// bootstrappers do not understand staged/hold policy and would consume its
// payload fields immediately.
const DEFAULT_MANIFEST_URL = 'https://app.empir3.com/downloads/bridge-desktop-version.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const HEALTHY_RELEASE_STATES = new Set(['healthy', 'package-smoke-passed', 'release-approved']);
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

function canonicalizeManifest(fields) {
  const parts = [];
  for (const key of Object.keys(fields).filter((name) => name !== 'manifestSignature').sort()) {
    const value = fields[key];
    if (typeof value !== 'string' || /[^\x20-\x7e]/.test(key) || /[^\x20-\x7e]/.test(value)) {
      throw new Error(`Manifest field ${key} violates the flat printable-ASCII signing contract`);
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

function parseAndVerifyManifest(raw, publicKeyHex) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let fields;
  try { fields = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Update manifest is not valid JSON'); }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Update manifest root must be an object');
  const signature = Buffer.from(String(fields.manifestSignature || ''), 'base64');
  if (signature.length !== 64) throw new Error('Update manifest signature is malformed');
  const rawKey = Buffer.from(String(publicKeyHex || ''), 'hex');
  if (rawKey.length !== 32) throw new Error('Update trust key is malformed');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!verify(null, canonicalizeManifest(fields), key, signature)) {
    throw new Error('Update manifest signature is invalid');
  }
  return fields;
}

function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) throw new Error(`Invalid release version: ${value}`);
    return match.slice(1).map(Number);
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

async function fetchLimited(url, maxBytes, fetcher = globalThis.fetch) {
  if (typeof fetcher !== 'function') throw new Error('No update fetch implementation is available');
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!response?.ok) throw new Error(`Update request failed with HTTP ${response?.status || 'unknown'}`);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Update response is too large (${declared} bytes)`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Update response exceeded ${maxBytes} bytes`);
  return bytes;
}

function artifactFieldPrefix(artifact) {
  const target = TARGET_PREFIX[artifact.target];
  const kind = KIND_SUFFIX[artifact.kind];
  if (!target || !kind) throw new Error(`Unsupported update artifact ${artifact.target}/${artifact.kind}`);
  return `${target}${kind}`;
}

function assertIndexMatchesManifest(index, manifest) {
  if (index?.schemaVersion !== 1 || !Array.isArray(index.artifacts)) throw new Error('Update artifact index is malformed');
  if (index.version !== manifest.version) throw new Error('Update artifact index version does not match the signed manifest');
  const rollout = index.rollout || {};
  const pairs = [
    [String(rollout.channel), manifest.releaseChannel],
    [String(rollout.state), manifest.rolloutState],
    [String(rollout.percent), manifest.rolloutPercent],
    [String(rollout.seed), manifest.rolloutSeed],
    [String(rollout.previousVersion || ''), manifest.previousVersion],
  ];
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    throw new Error('Update artifact index rollout policy does not match the signed manifest');
  }
}

function assertArtifactMatchesManifest(artifact, manifest) {
  const prefix = artifactFieldPrefix(artifact);
  const expected = {
    [`${prefix}Url`]: artifact.url,
    [`${prefix}Sha256`]: artifact.sha256,
    [`${prefix}Bytes`]: String(artifact.bytes),
    [`${prefix}Name`]: artifact.publicName,
    [`${prefix}Format`]: artifact.format,
    [`${prefix}Signed`]: artifact.signed === true ? 'true' : 'false',
    [`${prefix}AuthenticationScheme`]: artifact.authenticationScheme,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) throw new Error(`Signed update field ${field} does not match the artifact index`);
  }
  return prefix;
}

async function checkForReleaseUpdate({
  manifestUrl = DEFAULT_MANIFEST_URL,
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  hostType = 'desktop',
  artifactKind = hostType === 'headless' ? 'archive' : 'installer',
  deviceId,
  publicKeyHex,
  fetcher = globalThis.fetch,
} = {}) {
  const rawManifest = await fetchLimited(manifestUrl, MAX_MANIFEST_BYTES, fetcher);
  const manifest = parseAndVerifyManifest(rawManifest, publicKeyHex);
  if (manifest.schemaVersion !== '3') return { status: 'legacy-manifest', manifest };
  const versionOrder = compareVersions(currentVersion, manifest.version);
  const rollbackAllowed = versionOrder > 0
    && manifest.rolloutState === 'rollback'
    && manifest.previousVersion === currentVersion;
  if (versionOrder === 0) return { status: 'up-to-date', manifest };
  if (versionOrder > 0 && !rollbackAllowed) return { status: 'newer-local-version', manifest };

  const rollout = {
    state: manifest.rolloutState,
    percent: Number(manifest.rolloutPercent),
    seed: manifest.rolloutSeed,
  };
  if (!Number.isInteger(rollout.percent) || rollout.percent < 0 || rollout.percent > 100) {
    throw new Error('Signed rollout percentage is invalid');
  }
  if (!isEligibleForRollout({ rollout }, deviceId)) {
    return { status: manifest.rolloutState === 'hold' ? 'held' : 'not-selected', manifest };
  }

  const rawIndex = await fetchLimited(manifest.artifactIndexUrl, MAX_INDEX_BYTES, fetcher);
  const indexSha = createHash('sha256').update(rawIndex).digest('hex');
  if (indexSha !== manifest.artifactIndexSha256) throw new Error('Update artifact index hash does not match the signed manifest');
  let index;
  try { index = JSON.parse(rawIndex.toString('utf8')); }
  catch { throw new Error('Update artifact index is not valid JSON'); }
  assertIndexMatchesManifest(index, manifest);
  const artifact = selectArtifact(index, { platform, arch, hostType, kind: artifactKind });
  const prefix = assertArtifactMatchesManifest(artifact, manifest);
  const health = manifest[`${TARGET_PREFIX[artifact.target]}Health`];
  if (!HEALTHY_RELEASE_STATES.has(health)) {
    return { status: 'health-blocked', manifest, index, artifact, health };
  }
  if (!isProductionAuthenticated(artifact) || manifest[`${prefix}Signed`] !== 'true') {
    return { status: 'unsigned-blocked', manifest, index, artifact };
  }
  return {
    status: rollbackAllowed ? 'rollback-available' : 'available',
    manifest,
    index,
    artifact,
  };
}

async function checkForDesktopUpdate(options = {}) {
  return checkForReleaseUpdate({ ...options, hostType: 'desktop', artifactKind: 'installer' });
}

async function fileMatchesArtifact(path, artifact) {
  if (!existsSync(path) || statSync(path).size !== artifact.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === artifact.sha256;
}

async function downloadVerifiedArtifact(artifact, destination, { fetcher = globalThis.fetch } = {}) {
  if (await fileMatchesArtifact(destination, artifact)) return { path: destination, reused: true };
  const response = await fetcher(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!response?.ok) throw new Error(`Installer download failed with HTTP ${response?.status || 'unknown'}`);
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.part-${process.pid}-${Date.now()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > artifact.bytes) {
        callback(new Error('Installer download exceeded its signed byte size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const source = response.body && typeof response.body.getReader === 'function'
      ? Readable.fromWeb(response.body)
      : Readable.from([Buffer.from(await response.arrayBuffer())]);
    await pipeline(source, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    if (bytes !== artifact.bytes) throw new Error(`Installer byte size mismatch (${bytes} != ${artifact.bytes})`);
    if (hash.digest('hex') !== artifact.sha256) throw new Error('Installer SHA-256 does not match the signed release');
    if (existsSync(destination)) unlinkSync(destination);
    renameSync(partial, destination);
    return { path: destination, reused: false };
  } catch (error) {
    try { if (existsSync(partial)) unlinkSync(partial); } catch {}
    throw error;
  }
}

function saveJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (existsSync(path)) unlinkSync(path);
  renameSync(temp, path);
}

function loadOrCreateUpdateState(path, { makeDeviceId = randomUUID } = {}) {
  let state = {};
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (typeof state.deviceId !== 'string' || !/^[\x20-\x7e]{8,200}$/.test(state.deviceId)) {
    state.deviceId = makeDeviceId();
  }
  saveJsonAtomic(path, state);
  return state;
}

function saveUpdateState(path, state) {
  saveJsonAtomic(path, state);
}

function writeHealthReceipt(path, receipt) {
  saveJsonAtomic(path, {
    schemaVersion: 1,
    version: String(receipt.version),
    platform: String(receipt.platform),
    arch: String(receipt.arch),
    bridgeHealthy: receipt.bridgeHealthy === true,
    startupHealthyAt: new Date(receipt.startupHealthyAt || Date.now()).toISOString(),
  });
}

module.exports = {
  DEFAULT_MANIFEST_URL,
  canonicalizeManifest,
  checkForDesktopUpdate,
  checkForReleaseUpdate,
  compareVersions,
  downloadVerifiedArtifact,
  loadOrCreateUpdateState,
  parseAndVerifyManifest,
  saveUpdateState,
  writeHealthReceipt,
};
