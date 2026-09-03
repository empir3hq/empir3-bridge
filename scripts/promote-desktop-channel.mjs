#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildReleaseManifestV3, canPromoteDesktopManifestToLegacy } = require('../build/release-manifest-v3.js');
const { signManifest, verifyManifestBytes } = require('../build/manifest-canonical.js');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`[promote-desktop-channel] ${message}`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const sourceManifestPath = resolve(arg('--manifest', join(root, 'build', 'dist', 'bridge-version.json')));
const artifactIndexInput = arg('--artifact-index');
const artifactIndexPath = resolve(artifactIndexInput || '.');
const outputDir = resolve(arg('--out-dir', join(root, 'build', 'dist')));
const privateKeyPath = resolve(arg('--private-key', join(root, 'build', 'payload-signing-key.pem')));
const trustPath = resolve(arg('--trust', join(root, 'build', 'payload-signing-pub.json')));
const publicBase = arg('--public-base', 'https://app.empir3.com/downloads').replace(/\/$/, '');

if (!artifactIndexInput) fail('--artifact-index is required');
for (const [label, path] of [
  ['signed schema 2 manifest', sourceManifestPath],
  ['universal artifact index', artifactIndexPath],
  ['release private key', privateKeyPath],
  ['release trust root', trustPath],
]) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
}

const sourceBytes = readFileSync(sourceManifestPath);
const source = JSON.parse(sourceBytes.toString('utf8'));
const trust = JSON.parse(readFileSync(trustPath, 'utf8'));
if (!verifyManifestBytes(sourceBytes, trust.publicKeyHex)) {
  fail('source manifest does not verify against the production Bridge trust root');
}
if (source.schemaVersion !== '2') {
  fail(`source manifest must be schema 2 (got ${source.schemaVersion || 'missing'})`);
}

const indexBytes = readFileSync(artifactIndexPath);
const index = JSON.parse(indexBytes.toString('utf8'));
if (index.schemaVersion !== 1 || !Array.isArray(index.artifacts)) {
  fail('artifact index must be schema 1');
}
if (index.version !== source.version) {
  fail(`artifact index ${index.version} does not match payload ${source.version}`);
}
if (index.rollout?.channel !== 'production'
  || index.rollout?.state !== 'live'
  || Number(index.rollout?.percent) !== 100) {
  fail('only a production live/100 artifact index may replace the legacy channel');
}

const indexName = `empir3-bridge-artifacts-v${source.version}.json`;
const baseFields = { ...source };
delete baseFields.manifestSignature;
const fields = buildReleaseManifestV3(baseFields, index, {
  artifactIndexUrl: `${publicBase}/${indexName}`,
  artifactIndexSha256: sha256(indexBytes),
});
if (!canPromoteDesktopManifestToLegacy(fields)) {
  fail('the generated desktop manifest is not eligible for legacy promotion');
}
if (fields.version !== source.version || fields.sha256 !== source.sha256
  || fields.payloadUrl !== source.payloadUrl || fields.nodeSha256 !== source.nodeSha256) {
  fail('promotion attempted to mutate an existing payload or node release field');
}

fields.manifestSignature = signManifest(fields, readFileSync(privateKeyPath));
const manifestBytes = Buffer.from(`${JSON.stringify(fields, null, 2)}\n`, 'utf8');
if (!verifyManifestBytes(manifestBytes, trust.publicKeyHex)) {
  fail('generated schema 3 manifest failed production trust verification');
}

mkdirSync(outputDir, { recursive: true });
copyFileSync(artifactIndexPath, join(outputDir, indexName));
writeFileSync(join(outputDir, 'bridge-desktop-version.json'), manifestBytes);
writeFileSync(join(outputDir, 'bridge-version.json'), manifestBytes);

console.log(JSON.stringify({
  ok: true,
  version: fields.version,
  schemaVersion: fields.schemaVersion,
  rollout: `${fields.rolloutState}/${fields.rolloutPercent}`,
  artifacts: index.artifacts.length,
  payloadSha256: fields.sha256,
  artifactIndexSha256: fields.artifactIndexSha256,
  manifestSha256: sha256(manifestBytes),
  outputDir,
  sourceManifest: basename(sourceManifestPath),
}));
