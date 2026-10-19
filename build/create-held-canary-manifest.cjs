'use strict';

const fs = require('fs');
const path = require('path');
const { signManifest, verifyManifestBytes } = require('./manifest-canonical');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(__dirname, 'dist', 'bridge-version.json');
const outputDir = path.join(__dirname, 'held-canary');
const outputPath = path.join(outputDir, 'bridge-version.json');
const baseUrl = String(process.argv[2] || '').replace(/\/+$/, '');

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
  throw new Error('Expected a loopback canary base URL such as http://127.0.0.1:39190');
}

const fields = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
delete fields.manifestSignature;
for (const key of ['payloadUrl', 'signatureUrl', 'nodeUrl', 'nodeSignatureUrl']) {
  const parsed = new URL(fields[key]);
  fields[key] = `${baseUrl}/${path.posix.basename(parsed.pathname)}${parsed.search}`;
}

const privateKey = fs.readFileSync(path.join(__dirname, 'payload-signing-key.pem'));
fields.manifestSignature = signManifest(fields, privateKey);
const bytes = Buffer.from(`${JSON.stringify(fields, null, 2)}\n`);
const publicKeyHex = JSON.parse(fs.readFileSync(path.join(__dirname, 'payload-signing-pub.json'), 'utf8')).publicKeyHex;
if (!verifyManifestBytes(bytes, publicKeyHex)) throw new Error('Canary manifest self-verification failed');

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, bytes);
for (const name of [
  'Empir3Setup.exe',
  `bridge-payload-v${fields.version}.tar.gz`,
  `bridge-payload-v${fields.version}.sig`,
  `node-win-x64-v${fields.nodeVersion}.tar.gz`,
  `node-win-x64-v${fields.nodeVersion}.sig`,
]) {
  fs.copyFileSync(path.join(__dirname, 'dist', name), path.join(outputDir, name));
}

console.log(`Held canary manifest ready for ${fields.version} at ${baseUrl}`);
