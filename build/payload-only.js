'use strict';

// The runtime release lane reuses authenticated native bytes. It never invokes
// a compiler, Azure signing, or an installer publisher.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyManifestBytes } = require('./manifest-canonical');
const { extractTarGz } = require('./tar-util');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));

function newerVersion(next, previous) {
  if (![next, previous].every(v => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v))) return false;
  const a = next.split('.').map(BigInt), b = previous.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function readSignedManifest(file, publicKeyHex) {
  const raw = fs.readFileSync(file);
  if (!verifyManifestBytes(raw, publicKeyHex)) throw new Error('Release manifest signature is invalid');
  const manifest = JSON.parse(raw);
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64') throw new Error('Payload-only requires Windows x64');
  if (manifest.schemaVersion !== '2' && !(manifest.schemaVersion === '3'
    && manifest.rolloutState === 'live' && manifest.rolloutPercent === '100')) {
    throw new Error('Reuse requires a live release; held/staged/rollback releases cannot feed the legacy channel');
  }
  return manifest;
}

function verifyArchive(dir, name, signatureName, expectedHash, publicKeyHex) {
  const file = path.join(dir, name);
  const bytes = fs.readFileSync(file);
  const pub = crypto.createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex'),
  ]), format: 'der', type: 'spki' });
  if (hash(bytes) !== expectedHash || !crypto.verify(null, bytes, pub, fs.readFileSync(path.join(dir, signatureName)))) {
    throw new Error(`Archive hash/signature invalid: ${name}`);
  }
  return file;
}

function assertAuthenticode(file) {
  if (process.platform !== 'win32') throw new Error('Verify reused Windows executables on Windows');
  const script = path.join(__dirname, 'signing', 'verify-reused.ps1');
  if (!fs.existsSync(script)) throw new Error('Reusing production Windows binaries requires the private signing verifier. Use the private release keeper.');
  const env = { ...process.env, EMPIR3_VERIFY_REUSED_EXE: file };
  // A pwsh parent can export incompatible module paths to Windows PowerShell.
  // Let the child initialize its own built-in security module paths.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
    env, stdio: 'pipe', timeout: 60000,
  });
}

// Detect changes to any native file, not just the tray. Native node-pty bytes
// are copied from the previous signed payload rather than the local npm tree.
function nativeHash(dir) {
  const records = [];
  function walk(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`, full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native inventory cannot contain symbolic links');
      if (entry.isDirectory()) walk(full, `${name}/`);
      else if (/\.(exe|dll|node|sys|msi)$/i.test(name)) records.push([name, fileHash(full)]);
    }
  }
  walk(dir);
  if (!records.some(([name]) => name === 'Empir3Tray.exe')) throw new Error('Payload is missing its signed tray');
  return hash(JSON.stringify(records));
}

function assertSourceCompatible(root, ref, baseVersion) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', '--verify', `${ref}^{commit}`);
  git('merge-base', '--is-ancestor', commit, 'HEAD');
  const previous = JSON.parse(git('show', `${commit}:package.json`));
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (previous.version !== baseVersion) throw new Error('Reuse source ref does not match the previous release version');
  if (previous.dependencies?.['node-pty'] !== current.dependencies?.['node-pty']) throw new Error('node-pty changed: use a full release');
  const changed = git('diff', '--name-only', commit, '--', 'tray', 'build/bootstrap-go', 'build/node-pin.json', 'build/payload-signing-pub.json');
  if (changed) throw new Error(`Native source or trust inputs changed: use a full release (${changed})`);
  return commit;
}

function prepareReuse({ root, source, ref, version, publicKeyHex, destination }) {
  const manifestPath = path.join(source, 'bridge-version.json');
  const base = readSignedManifest(manifestPath, publicKeyHex);
  if (!newerVersion(version, base.version)) throw new Error('Payload-only requires a new version greater than the base release');
  const sourceCommit = assertSourceCompatible(root, ref, base.version);
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'build/node-pin.json')));
  if (pin.version !== base.nodeVersion || String(pin.abi) !== base.nodeAbi) throw new Error('Pinned Node differs from the reused release');
  const payloadName = `bridge-payload-v${base.version}.tar.gz`;
  const payload = verifyArchive(source, payloadName, `bridge-payload-v${base.version}.sig`, base.sha256, publicKeyHex);
  const tarballName = `node-win-x64-v${base.nodeVersion}.tar.gz`, sigName = `node-win-x64-v${base.nodeVersion}.sig`;
  verifyArchive(source, tarballName, sigName, base.nodeSha256, publicKeyHex);
  const unpacked = path.join(destination, 'reuse-payload');
  if (fs.existsSync(unpacked)) throw new Error('Reuse staging already exists: preserve the candidate and use a fresh version directory');
  fs.mkdirSync(destination, { recursive: true });
  extractTarGz(payload, unpacked);
  const tray = path.join(unpacked, 'Empir3Tray.exe');
  const bootstrap = path.join(source, 'Empir3Setup.exe');
  assertAuthenticode(tray);
  assertAuthenticode(bootstrap);
  for (const name of [tarballName, sigName, 'Empir3Setup.exe']) fs.copyFileSync(path.join(source, name), path.join(destination, name));
  fs.copyFileSync(manifestPath, path.join(destination, 'payload-base-manifest.json'));
  fs.copyFileSync(tray, path.join(destination, 'Empir3Tray.exe'));
  return {
    nativeDir: path.join(unpacked, 'node_modules', 'node-pty'),
    fields: {
      releaseKind: 'windows-payload-only', baseVersion: base.version,
      baseManifestSha256: fileHash(manifestPath), reusedSourceCommit: sourceCommit,
      reusedBootstrapSha256: fileHash(bootstrap), reusedTraySha256: fileHash(tray),
      reusedNativeSha256: nativeHash(unpacked),
    },
    node: { version: base.nodeVersion, abi: base.nodeAbi, platform: base.platform, arch: base.arch,
      sha256: base.nodeSha256, tarballName, sigName, tarballPath: path.join(destination, tarballName) },
  };
}

function validatePayloadOnly({ dir, publicKeyHex, publicBase, scratch }) {
  const manifest = readSignedManifest(path.join(dir, 'bridge-version.json'), publicKeyHex);
  const basePath = path.join(dir, 'payload-base-manifest.json');
  const base = readSignedManifest(basePath, publicKeyHex);
  if (manifest.releaseKind !== 'windows-payload-only' || manifest.schemaVersion !== '2'
    || manifest.baseManifestSha256 !== fileHash(basePath) || manifest.baseVersion !== base.version
    || !newerVersion(manifest.version, base.version)) throw new Error('Invalid payload-only release ancestry');
  for (const field of ['nodeVersion', 'nodeAbi', 'nodeSha256', 'platform', 'arch']) {
    if (manifest[field] !== base[field]) throw new Error(`Payload-only changed ${field}`);
  }
  const names = [
    ['payloadUrl', `bridge-payload-v${manifest.version}.tar.gz`],
    ['signatureUrl', `bridge-payload-v${manifest.version}.sig`],
    ['nodeUrl', `node-win-x64-v${manifest.nodeVersion}.tar.gz`],
    ['nodeSignatureUrl', `node-win-x64-v${manifest.nodeVersion}.sig`],
  ];
  for (const [field, name] of names) {
    const url = new URL(manifest[field]);
    if (`${url.origin}${url.pathname}` !== `${publicBase.replace(/\/$/, '')}/${name}`) throw new Error(`Unexpected download URL: ${field}`);
  }
  const payload = verifyArchive(dir, names[0][1], names[1][1], manifest.sha256, publicKeyHex);
  verifyArchive(dir, names[2][1], names[3][1], manifest.nodeSha256, publicKeyHex);
  extractTarGz(payload, scratch);
  const tray = path.join(scratch, 'Empir3Tray.exe'), bootstrap = path.join(dir, 'Empir3Setup.exe');
  if (nativeHash(scratch) !== manifest.reusedNativeSha256 || fileHash(tray) !== manifest.reusedTraySha256
    || fileHash(bootstrap) !== manifest.reusedBootstrapSha256) throw new Error('Reused native bytes changed');
  if (fs.readFileSync(path.join(scratch, '.payload-version'), 'utf8').trim() !== manifest.version) throw new Error('Packed payload version does not match manifest');
  assertAuthenticode(tray);
  assertAuthenticode(bootstrap);
  return manifest;
}

module.exports = { newerVersion, readSignedManifest, verifyArchive, nativeHash, assertSourceCompatible, prepareReuse, validatePayloadOnly };
