'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { downloadVerifiedArtifact } = require('../src/updater.cjs');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});

test('native artifact transport handles socket close, redirects, and verified reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-download-'));
  const bytes = Buffer.alloc(4 * 1024 * 1024, 113);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.url === '/redirect') {
      res.writeHead(307, { location: '/artifact', connection: 'close' });
      res.end();
    } else {
      res.writeHead(200, { 'content-length': bytes.length, connection: 'close' });
      res.end(bytes);
    }
  });
  try {
    const port = await listen(server);
    const artifact = { url: `http://127.0.0.1:${port}/redirect`, bytes: bytes.length, sha256: digest(bytes) };
    const destination = join(root, 'artifact');
    assert.equal((await downloadVerifiedArtifact(artifact, destination)).reused, false);
    assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(requests, 2);
    assert.equal((await downloadVerifiedArtifact(artifact, destination)).reused, true);
    assert.equal(requests, 2);
    assert.deepEqual(readdirSync(root), ['artifact']);
  } finally { await close(server); rmSync(root, { recursive: true, force: true }); }
});

test('real transport rejects corrupt, oversized, truncated and failed responses without replacing prior bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-download-refusal-'));
  const bytes = Buffer.alloc(256 * 1024, 97);
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-length': bytes.length, connection: 'close' });
    res.end(req.url === '/truncated' ? bytes.subarray(0, bytes.length / 2) : bytes);
  });
  try {
    const port = await listen(server);
    const destination = join(root, 'artifact');
    writeFileSync(destination, 'previous retained bytes');
    for (const [route, size, hash, error] of [
      ['corrupt', bytes.length, '0'.repeat(64), /SHA-256/],
      ['oversized', bytes.length - 1, digest(bytes), /exceeded its signed byte size/],
      ['truncated', bytes.length, digest(bytes), /aborted|premature|terminated/i],
      ['missing', bytes.length, digest(bytes), /HTTP 404/],
    ]) {
      await assert.rejects(downloadVerifiedArtifact({ url: `http://127.0.0.1:${port}/${route}`, bytes: size, sha256: hash }, destination), error);
      assert.equal(readFileSync(destination, 'utf8'), 'previous retained bytes');
      assert.deepEqual(readdirSync(root), ['artifact']);
    }
  } finally { await close(server); rmSync(root, { recursive: true, force: true }); }
});

test('redirects are bounded and cannot introduce credentials or non-HTTP protocols', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-download-redirect-'));
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const location = req.url === '/file' ? 'file:///unused' : req.url === '/credentials'
      ? `http://unused:unused@127.0.0.1:${server.address().port}/artifact` : '/loop';
    res.writeHead(302, { location }); res.end();
  });
  try {
    const port = await listen(server);
    const artifact = { bytes: 1, sha256: digest(Buffer.from('x')) };
    await assert.rejects(downloadVerifiedArtifact({ ...artifact, url: `http://127.0.0.1:${port}/loop` }, join(root, 'artifact')), /redirect limit/);
    assert.equal(requests, 21);
    for (const route of ['file', 'credentials']) {
      const before = requests;
      await assert.rejects(downloadVerifiedArtifact({ ...artifact, url: `http://127.0.0.1:${port}/${route}` }, join(root, 'artifact')), /HTTP\(S\) without credentials/);
      assert.equal(requests, before + 1);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally { await close(server); rmSync(root, { recursive: true, force: true }); }
});

test('TLS certificates remain verified and trusted HTTPS cannot redirect to cleartext', async (t) => {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('OpenSSL is required to generate an ephemeral local TLS certificate'); return; }
  const root = mkdtempSync(join(tmpdir(), 'empir3-download-tls-'));
  let server;
  try {
    const cert = join(root, 'cert.pem'), key = join(root, 'key.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = Buffer.from('authenticated artifact');
    server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      if (req.url === '/downgrade') { res.writeHead(302, { location: 'http://127.0.0.1:1/never-contact' }); res.end(); }
      else { res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes); }
    });
    const port = await listen(server);
    const artifact = { url: `https://127.0.0.1:${port}/artifact`, bytes: bytes.length, sha256: digest(bytes) };
    await assert.rejects(downloadVerifiedArtifact(artifact, join(root, 'untrusted')), /self.signed|certificate/i);
    const child = `const {downloadVerifiedArtifact}=require(process.argv[1]);downloadVerifiedArtifact(JSON.parse(process.argv[2]),process.argv[3]).then(()=>console.log('verified')).catch(e=>{console.error(e.message);process.exitCode=1});`;
    const options = { timeout: 10_000, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } };
    const run = promisify(execFile);
    const result = await run(process.execPath, ['-e', child, require.resolve('../src/updater.cjs'), JSON.stringify(artifact), join(root, 'trusted')], options);
    assert.match(result.stdout, /verified/);
    assert.deepEqual(readFileSync(join(root, 'trusted')), bytes);
    await assert.rejects(run(process.execPath, ['-e', child, require.resolve('../src/updater.cjs'), JSON.stringify({ ...artifact, url: `https://127.0.0.1:${port}/downgrade` }), join(root, 'downgrade')], options), /downgrade HTTPS/);
  } finally { if (server) await close(server); rmSync(root, { recursive: true, force: true }); }
});
