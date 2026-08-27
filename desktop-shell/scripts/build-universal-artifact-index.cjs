'use strict';

const { createHash } = require('node:crypto');
const { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { buildArtifactIndex, targetForReceipt } = require('../src/release-index.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function findReceipts(root, found = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) findReceipts(path, found);
    else if (stat.isFile() && entry === 'artifacts.json') found.push(path);
  }
  return found;
}

// npm --prefix desktop-shell executes this script with desktop-shell as cwd.
// Keep defaults and documented CLI arguments relative to that package root so
// callers do not accidentally resolve desktop-shell/desktop-shell/out.
const receiptsRoot = resolve(arg('--receipts', 'out/native-receipts'));
const outputPath = resolve(arg('--out', 'out/universal-artifact-index.json'));
if (!existsSync(receiptsRoot)) throw new Error(`Receipt directory does not exist: ${receiptsRoot}`);
const receiptPaths = findReceipts(receiptsRoot);
if (receiptPaths.length === 0) throw new Error(`No artifacts.json receipts found under ${receiptsRoot}`);
const receiptEntries = receiptPaths.map((path) => ({ path, receipt: JSON.parse(readFileSync(path, 'utf8')) }));

const index = buildArtifactIndex(
  receiptEntries.map((entry) => entry.receipt),
  {
    baseUrl: arg('--base-url', 'https://app.empir3.com/downloads/'),
    channel: arg('--channel', 'test'),
    rolloutState: arg('--rollout-state', 'hold'),
    rolloutPercent: Number(arg('--rollout-percent', '0')),
    rolloutSeed: arg('--rollout-seed', 'unpublished'),
    previousVersion: arg('--previous-version', ''),
    health: arg('--health', 'unverified'),
    authenticateLinuxWithManifest: process.argv.includes('--authenticate-linux-with-manifest'),
  },
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`);

function locateSource(entry, sourcePath) {
  const normalized = sourcePath.replaceAll('\\', '/');
  const withoutOut = normalized.startsWith('out/') ? normalized.slice(4) : normalized;
  const candidates = [
    resolve(dirname(entry.path), normalized),
    resolve(dirname(entry.path), withoutOut),
    resolve(dirname(dirname(entry.path)), normalized),
  ];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Could not locate ${sourcePath} beside ${entry.path}`);
  return found;
}

const stageDirArg = arg('--stage-dir', '');
let staged = 0;
if (stageDirArg) {
  const stageDir = resolve(stageDirArg);
  mkdirSync(stageDir, { recursive: true });
  for (const artifact of index.artifacts) {
    const entry = receiptEntries.find(({ receipt }) => (
      targetForReceipt(receipt) === artifact.target
    ));
    if (!entry) throw new Error(`No receipt source for ${artifact.target}`);
    const source = locateSource(entry, artifact.sourcePath);
    const bytes = readFileSync(source);
    if (bytes.length !== artifact.bytes) throw new Error(`Byte-size mismatch while staging ${artifact.sourceName}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== artifact.sha256) throw new Error(`SHA-256 mismatch while staging ${artifact.sourceName}`);
    copyFileSync(source, join(stageDir, artifact.publicName));
    staged += 1;
  }
  copyFileSync(outputPath, join(stageDir, `empir3-bridge-artifacts-v${index.version}.json`));
}

console.log(JSON.stringify({ ok: true, outputPath, version: index.version, artifacts: index.artifacts.length, staged }));
