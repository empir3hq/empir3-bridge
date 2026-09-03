#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { artifactFieldPrefix, canPromoteDesktopManifestToLegacy } = require('../build/release-manifest-v3.js');
const { verifyManifestBytes } = require('../build/manifest-canonical.js');
const { isProductionAuthenticated } = require('../desktop-shell/src/release-index.cjs');
const {
  buildCandidate: buildReceiptCandidate,
  buildPrestageReceipt,
  finalizeReceipt,
  validatePrestageReceipt,
} = require('./publish-receipt.cjs');

/**
 * Publish the bridge download artifacts in a STAGED order so a fresh Go stub can
 * never observe a manifest that points at not-yet-live artifacts, and the public
 * Empir3Setup.exe never reads a manifest before it is live:
 *
 *   1. every payload/desktop artifact            ── manifests point at these
 *   2. bridge-desktop-version.json               ── Electron staged channel
 *   3. bridge-version.json                       ── legacy channel, live/100 only
 *   4. Empir3Setup.exe                           ── only after its manifest is live
 *
 * The manifest signature is EMBEDDED (single file, atomic swap) so there is no
 * manifest/.sig race — but artifact-before-manifest-before-exe still matters.
 * After each hop we verify on the SERVER (sha256sum, authoritative — no
 * Cloudflare cache in the way) before proceeding.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'build', 'dist');
const server = process.env.EMPIR3_DOWNLOAD_HOST;
const remoteDir = process.env.EMPIR3_DOWNLOAD_DIR;
const jumpHost = process.env.EMPIR3_DOWNLOAD_JUMP_HOST;
const publicBase = process.env.EMPIR3_PAYLOAD_PUBLIC_URL_BASE || 'https://app.empir3.com/downloads';
const dryRun = process.argv.includes('--dry-run');
const prestage = process.argv.includes('--prestage');
const finalize = process.argv.includes('--finalize');
const allowUnsignedDesktop = process.argv.includes('--allow-unsigned-desktop');
const allowLegacyOnly = process.argv.includes('--allow-legacy-only');
if (prestage && finalize) fail('--prestage and --finalize are mutually exclusive');
if (allowUnsignedDesktop && !dryRun) {
  fail('--allow-unsigned-desktop is restricted to --dry-run and can never publish files');
}
// The deploy target is intentionally NOT hardcoded (this is a public repo). Set
// both env vars before a real publish; --dry-run can run without them.
if (!dryRun && (!server || !remoteDir)) {
  fail('set EMPIR3_DOWNLOAD_HOST (e.g. user@host) and EMPIR3_DOWNLOAD_DIR (e.g. /var/www/app/downloads) — the publish target is not stored in the repo');
}

function fail(message) {
  console.error(`[publish-downloads] ${message}`);
  process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
  const pretty = [cmd, ...args].join(' ');
  console.log(`[publish-downloads] ${pretty}`);
  if (dryRun) return '';
  const result = spawnSync(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false, encoding: 'utf8' });
  if (result.status !== 0) fail(`command failed: ${pretty}`);
  return capture ? (result.stdout || '') : '';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** Run on the download host. When the target is private and only the jump
 * host has its SSH key, execute the second hop from that host instead of using
 * ProxyJump (which would still require the local machine's key on the target). */
function runRemote(command, options = {}) {
  if (!jumpHost) return run('ssh', [server, command], options);
  return run('ssh', [jumpHost, `ssh ${shellQuote(server)} ${shellQuote(command)}`], options);
}

function upload(filePath, remotePath) {
  if (!jumpHost) return run('scp', [filePath, `${server}:${remotePath}`]);
  const jumpTmp = `/tmp/empir3-download-${process.pid}-${basename(remotePath)}`;
  run('scp', [filePath, `${jumpHost}:${jumpTmp}`]);
  run('ssh', [jumpHost, `scp ${shellQuote(jumpTmp)} ${shellQuote(`${server}:${remotePath}`)} && rm -f ${shellQuote(jumpTmp)}`]);
}

function sha256OfFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a path`);
  return value;
}

function fileRecord(file) {
  return {
    name: basename(file.path),
    sha256: file.sha,
    bytes: statSync(file.path).size,
  };
}

function buildCandidate({ releaseKind, version, immutableFiles, fixedFiles }) {
  return buildReceiptCandidate({
    releaseKind,
    version,
    target: {
      server,
      remoteDir,
      jumpHost: jumpHost || '',
      publicBase,
    },
    immutableFiles: immutableFiles.map(fileRecord),
    fixedFiles: fixedFiles.map(fileRecord),
  });
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function writePrestageReceipt(receiptPath, candidate) {
  if (dryRun) {
    console.log(`[publish-downloads] dry-run: would write pre-stage receipt ${receiptPath}`);
    return;
  }
  const receipt = buildPrestageReceipt(candidate);
  writeJsonAtomic(receiptPath, receipt);
  console.log(`[publish-downloads]   ✓ pre-stage receipt written: ${receiptPath}`);
}

function requireMatchingPrestageReceipt(receiptPath, candidate) {
  if (!existsSync(receiptPath)) fail(`pre-stage receipt missing: ${receiptPath}`);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    fail(`pre-stage receipt is unreadable: ${error.message}`);
  }
  try {
    return validatePrestageReceipt(receipt, candidate);
  } catch (error) {
    fail(error.message);
  }
}

function markReceiptFinalized(receiptPath, receipt) {
  if (dryRun) return;
  writeJsonAtomic(receiptPath, finalizeReceipt(receipt));
}

function verifyRemoteFiles(label, files) {
  console.log(`\n[publish-downloads] === ${label} ===`);
  for (const file of files) {
    if (dryRun) continue;
    const name = basename(file.path);
    const out = runRemote(`sha256sum '${remoteDir}/${name}'`, { capture: true });
    const remoteSha = (out.trim().split(/\s+/)[0] || '').toLowerCase();
    if (remoteSha !== file.sha) {
      fail(`pre-staged server sha mismatch for ${name}: expected ${file.sha}, got ${remoteSha || 'missing'}`);
    }
    console.log(`[publish-downloads]   ✓ ${name} still matches the pre-stage receipt`);
  }
}

function requireArtifact(name) {
  const p = join(dist, name);
  if (!existsSync(p) || !statSync(p).isFile()) fail(`required artifact missing: ${name} (run npm run build:windows)`);
  return p;
}

// Upload each file ATOMICALLY: scp to a temp name, verify the temp's sha256 on
// the server (authoritative — bypasses Cloudflare), then `mv` into place. The
// rename is atomic on the same filesystem, so a fresh client can never observe
// a partially-written file at the final name.
function uploadAndVerify(label, files) {
  console.log(`\n[publish-downloads] === ${label} ===`);
  for (const f of files) {
    const name = basename(f.path);
    const tmp = `${remoteDir}/${name}.uploading`;
    const final = `${remoteDir}/${name}`;
    upload(f.path, tmp);
    if (dryRun) continue;
    const out = runRemote(`sha256sum '${tmp}'`, { capture: true });
    const remoteSha = (out.trim().split(/\s+/)[0] || '').toLowerCase();
    if (remoteSha !== f.sha) {
      runRemote(`rm -f '${tmp}'`);
      fail(`server sha mismatch for ${name}: local ${f.sha} != remote ${remoteSha}`);
    }
    runRemote(`mv -f '${tmp}' '${final}'`); // atomic swap into place
    console.log(`[publish-downloads]   ✓ ${name} on server (sha ok, atomic mv)`);
  }
}

// Verify a fresh client can actually fetch the artifact at the EXACT URL it will
// use, with the right bytes. The artifact URLs carry a cache-bust query, so this
// bypasses any Cloudflare cache and reflects origin.
function publicShaCheck(url, wantSha) {
  if (dryRun) return;
  const out = runRemote(`curl -fsSL '${url}' | sha256sum`, { capture: true });
  const got = (out.trim().split(/\s+/)[0] || '').toLowerCase();
  if (got !== wantSha) fail(`public fetch sha mismatch for ${url}: got ${got}, want ${wantSha}`);
  console.log(`[publish-downloads]   ✓ public ${url.split('/').pop()} (sha ok)`);
}

// Like publicShaCheck but retries — for a FIXED-name URL (bridge-version.json)
// that Cloudflare may cache briefly. Blocks until the public URL returns the
// expected bytes, or aborts with a purge hint.
function publicShaCheckRetry(url, wantSha, { tries = 10, delayMs = 3000 } = {}) {
  if (dryRun) return;
  for (let i = 1; i <= tries; i++) {
    const out = runRemote(`curl -fsSL '${url}' | sha256sum`, { capture: true });
    const got = (out.trim().split(/\s+/)[0] || '').toLowerCase();
    if (got === wantSha) { console.log(`[publish-downloads]   ✓ public ${url.split('/').pop()} reflects new bytes (try ${i})`); return; }
    console.log(`[publish-downloads]   … public ${url.split('/').pop()} still stale (try ${i}/${tries}); got ${got.slice(0, 12)}…`);
    if (i < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); // block delayMs
  }
  fail(`public ${url} never returned the new sha (${wantSha}). Purge the Cloudflare cache for that URL, then re-run — the exe was NOT published, so nothing is half-live.`);
}

function publicGet200(name) {
  if (dryRun) return;
  runRemote(`curl -fsS -o /dev/null -w '%{http_code}' '${publicBase}/${name}' | grep -q 200 || (echo 'not 200' && exit 1)`);
}

if (!existsSync(dist)) fail(`missing dist directory: ${dist}. Run npm run build:windows first.`);

const legacyManifestPath = join(dist, 'bridge-version.json');
const desktopManifestPath = join(dist, 'bridge-desktop-version.json');
const manifestPath = existsSync(desktopManifestPath) ? desktopManifestPath : legacyManifestPath;
if (!existsSync(manifestPath)) fail('required artifact missing: bridge-desktop-version.json or bridge-version.json');
const manifestName = basename(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if (!manifest.version) fail(`${manifestName} is missing version`);
if (!manifest.nodeVersion) fail(`${manifestName} is missing nodeVersion (rebuild with the Go-bootstrapper build.js)`);
if (!manifest.manifestSignature) fail(`${manifestName} is missing manifestSignature (rebuild)`);
const trust = JSON.parse(readFileSync(join(root, 'build', 'payload-signing-pub.json'), 'utf8'));
if (!verifyManifestBytes(readFileSync(manifestPath), trust.publicKeyHex)) {
  fail(`${manifestName} does not verify against the production Bridge trust root`);
}
if (manifest.schemaVersion !== '3' && !allowLegacyOnly) {
  fail('refusing a legacy-only release because it would leave website-installed Bridges behind; build the universal artifacts and run npm run release:promote-desktop -- --artifact-index <path> first (emergency override: --allow-legacy-only)');
}

const f = (name, sha) => ({ path: requireArtifact(name), sha });
const manifestFile = f(manifestName, sha256OfFile(manifestPath));
let artifactIndexFile = null;
const desktopFiles = [];

if (manifest.schemaVersion === '3') {
  if (!manifest.artifactIndexUrl || !manifest.artifactIndexSha256) fail('schema 3 manifest is missing its artifact index fields');
  const indexName = basename(new URL(manifest.artifactIndexUrl).pathname);
  artifactIndexFile = f(indexName, manifest.artifactIndexSha256.toLowerCase());
  if (sha256OfFile(artifactIndexFile.path) !== artifactIndexFile.sha) fail('local artifact index sha != signed manifest field');
  const index = JSON.parse(readFileSync(artifactIndexFile.path, 'utf8'));
  if (index.schemaVersion !== 1 || index.version !== manifest.version || !Array.isArray(index.artifacts)) {
    fail('artifact index schema/version does not match the signed release manifest');
  }
  if (String(index.rollout?.channel) !== manifest.releaseChannel
    || String(index.rollout?.state) !== manifest.rolloutState
    || String(index.rollout?.percent) !== manifest.rolloutPercent
    || String(index.rollout?.seed) !== manifest.rolloutSeed
    || String(index.rollout?.previousVersion || '') !== manifest.previousVersion) {
    fail('artifact index rollout policy does not match the signed release manifest');
  }
  for (const artifact of index.artifacts) {
    if (!isProductionAuthenticated(artifact) && !allowUnsignedDesktop) {
      fail(`refusing unauthenticated Bridge artifact ${artifact.publicName}; production authentication is required`);
    }
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
      if (manifest[field] !== value) fail(`signed manifest field ${field} does not match artifact index`);
    }
    const file = f(artifact.publicName, artifact.sha256.toLowerCase());
    if (sha256OfFile(file.path) !== file.sha) fail(`local desktop artifact sha mismatch: ${artifact.publicName}`);
    if (statSync(file.path).size !== artifact.bytes) fail(`local desktop artifact size mismatch: ${artifact.publicName}`);
    desktopFiles.push({ ...file, url: artifact.url });
  }
}

const desktopOnly = manifest.schemaVersion === '3' && !canPromoteDesktopManifestToLegacy(manifest);
const desktopReleaseMetadataFiles = desktopFiles.filter((file) => basename(file.path) === 'RELEASES');
const desktopImmutableFiles = desktopFiles.filter((file) => basename(file.path) !== 'RELEASES');
if (desktopOnly) {
  if (!artifactIndexFile || desktopFiles.length === 0) fail('desktop-only rollout has no verified desktop artifacts');
  const immutableFiles = [...desktopImmutableFiles, artifactIndexFile];
  const fixedFiles = [...desktopReleaseMetadataFiles, manifestFile];
  const receiptPath = resolve(argValue('--receipt') || join(root, 'build', `release-${manifest.version}-prestage-receipt.json`));
  const candidate = buildCandidate({
    releaseKind: 'desktop-only',
    version: manifest.version,
    immutableFiles,
    fixedFiles,
  });
  console.log(`[publish-downloads] publishing desktop ${manifest.rolloutState}/${manifest.rolloutPercent}% v${manifest.version} to ${server}:${remoteDir}${jumpHost ? ` via ${jumpHost}` : ''}`);
  let receipt = null;
  if (finalize) {
    receipt = requireMatchingPrestageReceipt(receiptPath, candidate);
    verifyRemoteFiles('Finalize gate: revalidate every pre-staged immutable file', immutableFiles);
  } else {
    runRemote(`mkdir -p '${remoteDir}'`);
    uploadAndVerify('Stage 1: desktop artifacts, then the versioned artifact index', immutableFiles);
  }
  for (const artifact of desktopImmutableFiles) publicShaCheck(artifact.url, artifact.sha);
  publicShaCheck(manifest.artifactIndexUrl, artifactIndexFile.sha);
  if (prestage) {
    writePrestageReceipt(receiptPath, candidate);
    console.log('\n[publish-downloads] pre-stage done; no fixed release metadata, manifest, or stable installer file was changed');
    process.exit(0);
  }
  if (desktopReleaseMetadataFiles.length > 0) {
    uploadAndVerify('Finalize: fixed desktop release metadata', desktopReleaseMetadataFiles);
    for (const artifact of desktopReleaseMetadataFiles) {
      publicShaCheckRetry(artifact.url, artifact.sha, { tries: 10, delayMs: 3000 });
    }
  }
  uploadAndVerify('Stage 2: signed desktop rollout manifest', [manifestFile]);
  publicShaCheckRetry(`${publicBase}/bridge-desktop-version.json`, manifestFile.sha, { tries: 10, delayMs: 3000 });
  if (receipt) markReceiptFinalized(receiptPath, receipt);
  console.log('\n[publish-downloads] desktop channel done; legacy bridge-version.json and Empir3Setup.exe were intentionally untouched');
  console.log(`  Desktop manifest: ${publicBase}/bridge-desktop-version.json`);
  console.log(`  Artifacts:        ${manifest.artifactIndexUrl}`);
  process.exit(0);
}

const payloadTar = `bridge-payload-v${manifest.version}.tar.gz`;
const payloadSig = `bridge-payload-v${manifest.version}.sig`;
const nodeTar = `node-win-x64-v${manifest.nodeVersion}.tar.gz`;
const nodeSig = `node-win-x64-v${manifest.nodeVersion}.sig`;

// sha of tarballs comes from the (signed) manifest; sigs/exe/manifests are
// verified by local-computed sha against the server copy.
const payloadTarFile = f(payloadTar, manifest.sha256.toLowerCase());
const nodeTarFile = f(nodeTar, manifest.nodeSha256.toLowerCase());
const payloadSigFile = f(payloadSig, sha256OfFile(requireArtifact(payloadSig)));
const nodeSigFile = f(nodeSig, sha256OfFile(requireArtifact(nodeSig)));
const exeFile = f('Empir3Setup.exe', sha256OfFile(requireArtifact('Empir3Setup.exe')));
let legacyManifestFile = manifestFile;
if (manifest.schemaVersion === '3') {
  if (!existsSync(legacyManifestPath)) fail('100% live schema 3 release is missing bridge-version.json');
  legacyManifestFile = f('bridge-version.json', sha256OfFile(legacyManifestPath));
  if (legacyManifestFile.sha !== manifestFile.sha) fail('desktop and legacy live manifests are not byte-identical');
}

// Local sanity: the tarballs on disk must match the manifest's declared shas.
if (sha256OfFile(payloadTarFile.path) !== payloadTarFile.sha) fail('local payload tarball sha != manifest.sha256 — rebuild');
if (sha256OfFile(nodeTarFile.path) !== nodeTarFile.sha) fail('local node tarball sha != manifest.nodeSha256 — rebuild');

console.log(`[publish-downloads] publishing bridge v${manifest.version} (node v${manifest.nodeVersion}) to ${server}:${remoteDir}${jumpHost ? ` via ${jumpHost}` : ''}`);

const immutableFiles = [nodeTarFile, nodeSigFile, payloadTarFile, payloadSigFile, ...desktopImmutableFiles, ...(artifactIndexFile ? [artifactIndexFile] : [])];
const fixedFiles = manifest.schemaVersion === '3'
  ? [...desktopReleaseMetadataFiles, manifestFile, legacyManifestFile, exeFile]
  : [...desktopReleaseMetadataFiles, legacyManifestFile, exeFile];
const receiptPath = resolve(argValue('--receipt') || join(root, 'build', `release-${manifest.version}-prestage-receipt.json`));
const candidate = buildCandidate({
  releaseKind: 'live',
  version: manifest.version,
  immutableFiles,
  fixedFiles,
});
let receipt = null;

// 1. Artifacts FIRST (the manifest will point at these).
if (finalize) {
  receipt = requireMatchingPrestageReceipt(receiptPath, candidate);
  verifyRemoteFiles('Finalize gate: revalidate every pre-staged immutable file', immutableFiles);
} else {
  runRemote(`mkdir -p '${remoteDir}'`);
  uploadAndVerify('Stage 1: every referenced artifact, then the versioned artifact index', immutableFiles);
}

// 1b. Confirm a fresh stub can fetch the EXACT signed URLs (payload/node tarballs
// AND their .sig — the stub fetches all four). These carry a unique ?v=&t= query,
// so Cloudflare can't serve a stale copy.
console.log('\n[publish-downloads] === Verify stub-visible artifact URLs ===');
publicShaCheck(manifest.nodeUrl, manifest.nodeSha256.toLowerCase());
publicShaCheck(manifest.payloadUrl, manifest.sha256.toLowerCase());
publicShaCheck(manifest.nodeSignatureUrl, sha256OfFile(nodeSigFile.path));
publicShaCheck(manifest.signatureUrl, sha256OfFile(payloadSigFile.path));
if (artifactIndexFile) {
  for (const artifact of desktopImmutableFiles) publicShaCheck(artifact.url, artifact.sha);
  publicShaCheck(manifest.artifactIndexUrl, artifactIndexFile.sha);
}

if (prestage) {
  writePrestageReceipt(receiptPath, candidate);
  console.log('\n[publish-downloads] pre-stage done; no fixed release metadata, manifest, or stable installer file was changed');
  process.exit(0);
}

if (desktopReleaseMetadataFiles.length > 0) {
  uploadAndVerify('Finalize: fixed desktop release metadata', desktopReleaseMetadataFiles);
  for (const artifact of desktopReleaseMetadataFiles) {
    publicShaCheckRetry(artifact.url, artifact.sha, { tries: 10, delayMs: 3000 });
  }
}

// 2. Manifest NEXT (now everything it references is live).
uploadAndVerify('Stage 2: signed desktop manifest, then legacy manifest',
  manifest.schemaVersion === '3' ? [manifestFile, legacyManifestFile] : [legacyManifestFile]);

// 2b. CRITICAL ORDERING GATE: the public, fixed-name manifest URL must already
// return the NEW bytes BEFORE we publish the exe. The exe is the trigger — if it
// went live while bridge-version.json was still the stale (possibly pre-Go,
// nodeUrl-less) manifest, a fresh stub would read the wrong manifest. This
// fixed-name URL CAN be Cloudflare-cached, so retry briefly; if it never matches,
// abort and tell the operator to purge the CF cache for bridge-version.json.
console.log('\n[publish-downloads] === Gate: public manifest must reflect new bytes before exe ===');
if (manifest.schemaVersion === '3') {
  publicShaCheckRetry(`${publicBase}/bridge-desktop-version.json`, manifestFile.sha, { tries: 10, delayMs: 3000 });
}
publicShaCheckRetry(`${publicBase}/bridge-version.json`, legacyManifestFile.sha, { tries: 10, delayMs: 3000 });

// 3. Empir3Setup.exe LAST (only after the manifest it reads is confirmed live).
uploadAndVerify('Stage 3: Empir3Setup.exe', [exeFile]);

// Final reachability of the exe (a stale-cached old exe still works since it
// re-reconciles, so a 200 is sufficient here).
publicGet200('Empir3Setup.exe');
if (receipt) markReceiptFinalized(receiptPath, receipt);

console.log('\n[publish-downloads] done');
console.log(`  Installer: ${publicBase}/Empir3Setup.exe`);
console.log(`  Manifest:  ${publicBase}/bridge-version.json`);
if (manifest.schemaVersion === '3') console.log(`  Desktop:   ${publicBase}/bridge-desktop-version.json`);
console.log(`  Node:      ${publicBase}/${nodeTar}`);
console.log(`  Payload:   ${publicBase}/${payloadTar}`);
if (artifactIndexFile) console.log(`  Artifacts: ${manifest.artifactIndexUrl}`);
