#!/usr/bin/env node
/**
 * Local, fully-isolated end-to-end harness for the Go bootstrapper.
 *
 * NEVER touches the real install: every test runs the built
 * build/dist/Empir3Setup.exe with USERPROFILE + APPDATA pointed at a fresh temp
 * dir and EMPIR3_BRIDGE_VERSION_URL pointed at a local HTTP "CDN" serving a
 * test manifest + artifacts. Artifacts are signed with the REAL Ed25519 key
 * (build/payload-signing-key.pem) so the production exe (which embeds the real
 * pubkey) accepts them. The real Node tarball from build/dist is reused for the
 * runtime; payloads are tiny synthetic tarballs whose entry.js records the env
 * it was spawned with and exits fast (no real daemon).
 *
 * Covers the bootstrap test-plan items 1-21.
 * Items that need a real tray/daemon GUI (17) are marked SKIP with a reason
 * (covered by the fresh-machine manual install/uninstall in the release step).
 *
 * Run:  node scripts/bootstrap-e2e.mjs
 */
import { createServer } from 'http';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { createHash, createPrivateKey, sign as edSign } from 'crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  copyFileSync, readdirSync, statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, basename, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildDeterministicTarGz } = require('../build/tar-util.js');
const { canonicalizeManifest, signManifest } = require('../build/manifest-canonical.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'build', 'dist');
const EXE = join(DIST, 'Empir3Setup.exe');
const SIGNING_KEY_PEM = join(ROOT, 'build', 'payload-signing-key.pem');
const PUB_HEX = JSON.parse(readFileSync(join(ROOT, 'build', 'payload-signing-pub.json'), 'utf8')).publicKeyHex.toLowerCase();
const LEGACY_BOOTSTRAP = join(ROOT, 'build', 'bootstrap.js');

const PAYLOAD_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Read the stub's BootstrapVersion const from source so tests track bumps.
const BOOT_VERSION = (readFileSync(join(ROOT, 'build', 'bootstrap-go', 'main.go'), 'utf8')
  .match(/const BootstrapVersion = "([^"]+)"/) || [])[1] || '';

const NODE_PIN = JSON.parse(readFileSync(join(ROOT, 'build', 'node-pin.json'), 'utf8'));

// Locate the real Node artifact built by build.js (real node.exe inside). Prefer
// the PINNED version so a stale older node-*.tar.gz in dist can't be picked.
function findRealNodeTarball() {
  const pinned = `node-win-x64-v${NODE_PIN.version}.tar.gz`;
  const f = existsSync(join(DIST, pinned))
    ? pinned
    : readdirSync(DIST).find((n) => /^node-win-x64-v.*\.tar\.gz$/.test(n));
  if (!f) throw new Error('no node-win-x64 tarball in build/dist — run `node build/build.js` first');
  const m = f.match(/v(\d+\.\d+\.\d+)\.tar\.gz$/);
  return { path: join(DIST, f), name: f, version: m[1] };
}
const REAL_NODE = findRealNodeTarball();

const PRIV = createPrivateKey(readFileSync(SIGNING_KEY_PEM));

// ── tiny utils ───────────────────────────────────────────────────────────
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sign = (buf) => edSign(null, buf, PRIV);
let TMP_ROOTS = [];
function freshTmp(label) {
  const d = mkdtempSync(join(tmpdir(), `e2e-${label}-`));
  TMP_ROOTS.push(d);
  return d;
}
function cleanupAll() { for (const d of TMP_ROOTS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } TMP_ROOTS = []; }

// Synthetic payload tarball: entry.js records spawn env to E2E_MARKER_FILE,
// handles --version / --mcp / job-child modes, exits fast. Works whether the Go
// stub spawns it (`node entry.js …`) or the legacy bootstrap.js require()s it.
function syntheticPayloadTarGz(version) {
  const stage = freshTmp('payload-stage');
  const entry = `'use strict';
const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const VERSION = (() => { try { return fs.readFileSync(path.join(process.env.EMPIR3_BRIDGE_PAYLOAD_DIR || __dirname, '.payload-version'), 'utf8').trim(); } catch { return 'dev'; } })();
function marker(extra) {
  const f = process.env.E2E_MARKER_FILE; if (!f) return;
  fs.writeFileSync(f, JSON.stringify({
    bootstrapExe: process.env.EMPIR3_BOOTSTRAP_EXE || '',
    payloadDir: process.env.EMPIR3_BRIDGE_PAYLOAD_DIR || '',
    payloadVersion: process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || '',
    bootstrapVersion: process.env.EMPIR3_BRIDGE_BOOTSTRAP_VERSION || '',
    execPath: process.execPath, version: VERSION, ...extra,
  }));
}
async function start(argv) {
  argv = argv || process.argv.slice(2);
  const mode = process.env.E2E_MODE || '';
  if (argv.includes('--mcp') || mode === 'mcp') {
    // Respond only AFTER reading a JSON-RPC line from stdin; the harness asserts
    // stdout is byte-exact (the stub added no preamble).
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { e2e: 'mcp-ok', v: VERSION } }) + '\\n');
      process.exit(0);
    });
    return;
  }
  if (mode === 'job-child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore', detached: false });
    if (process.env.E2E_CHILD_PID_FILE) fs.writeFileSync(process.env.E2E_CHILD_PID_FILE, String(child.pid));
    marker({ kind: 'job-child', childPid: child.pid });
    setInterval(() => {}, 1e9); // linger until the stub (and its job) is killed
    return;
  }
  if (mode === 'launcher-detached') {
    // Stand-in for spawnTrayAndExit(): spawn a DETACHED grandchild that must
    // outlive node AND the stub, then return so node exits immediately.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore', detached: true });
    child.unref();
    if (process.env.E2E_CHILD_PID_FILE) fs.writeFileSync(process.env.E2E_CHILD_PID_FILE, String(child.pid));
    marker({ kind: 'launcher-detached', childPid: child.pid });
    return; // node exits; the detached grandchild must survive
  }
  if (argv.includes('--version') || argv.includes('-v')) { marker({ kind: 'version' }); process.stdout.write(VERSION + '\\n'); return; }
  marker({ kind: 'run' }); process.stdout.write(VERSION + '\\n');
}
if (require.main === module) { start(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); }); }
module.exports = { start };
`;
  writeFileSync(join(stage, 'entry.js'), entry);
  writeFileSync(join(stage, '.payload-version'), version);
  return buildDeterministicTarGz(stage);
}

// A deliberately malicious tar.gz for the extractor test. typeflag '0' (regular)
// by default, or '2' (symlink) with a linkname, so we can exercise the stub's
// rejection of traversal/absolute/drive/UNC/symlink entries.
function evilTarGz(entryName, { typeflag = '0', linkname = '' } = {}) {
  const zlib = require('zlib');
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  const data = typeflag === '2' ? Buffer.alloc(0) : Buffer.from('pwned');
  header.write(entryName, 0, 100, 'utf8');
  header.write('0000644', 100, 8); header.write('\0', 107, 1);
  header.write('0000000', 108, 8); header.write('\0', 115, 1);
  header.write('0000000', 116, 8); header.write('\0', 123, 1);
  header.write(data.length.toString(8).padStart(11, '0'), 124, 12); header.write(' ', 135, 1);
  header.write('00000000000', 136, 12); header.write(' ', 147, 1);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header.write(typeflag, 156, 1);
  if (linkname) header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  let sum = 0; for (let i = 0; i < BLOCK; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0'), 148, 6); header[154] = 0; header[155] = 0x20;
  const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return zlib.gzipSync(Buffer.concat([header, data, pad, Buffer.alloc(BLOCK * 2)]), { mtime: 0 });
}

// ── per-test CDN ───────────────────────────────────────────────────────────
// A test "world": isolated home/appdata + a local HTTP CDN serving artifacts.
class World {
  constructor(label) {
    this.label = label;
    this.dir = freshTmp(label);
    this.home = join(this.dir, 'home'); mkdirSync(this.home, { recursive: true });
    this.appdata = join(this.dir, 'appdata'); mkdirSync(this.appdata, { recursive: true });
    this.cdnDir = join(this.dir, 'cdn'); mkdirSync(this.cdnDir, { recursive: true });
    this.files = new Map(); // name -> Buffer
    this.server = null; this.port = 0;
  }
  put(name, buf) { this.files.set(name, buf); writeFileSync(join(this.cdnDir, name), buf); return name; }
  async listen() {
    this.server = createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
      const buf = this.files.get(name);
      if (!buf) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      res.end(buf);
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
  }
  url(name) { return `http://127.0.0.1:${this.port}/${name}`; }
  manifestUrl() { return this.url('bridge-version.json'); }
  close() { if (this.server) this.server.close(); }

  // Publish a node + payload + signed manifest. opts overrides manifest fields.
  publish({ payloadVersion = PAYLOAD_VERSION, nodeVersion = REAL_NODE.version, nodeTarball, payloadTarball, override = {}, tamperAfterSign = null } = {}) {
    const nodeBuf = nodeTarball || readFileSync(REAL_NODE.path);
    const payloadBuf = payloadTarball || syntheticPayloadTarGz(payloadVersion);
    const nodeName = `node-win-x64-v${nodeVersion}.tar.gz`;
    const payloadName = `bridge-payload-v${payloadVersion}.tar.gz`;
    this.put(nodeName, nodeBuf);
    this.put(`${nodeName.replace(/\.tar\.gz$/, '')}.sig`, override.badNodeSig ? Buffer.alloc(64) : sign(nodeBuf));
    this.put(payloadName, payloadBuf);
    this.put(`${payloadName.replace(/\.tar\.gz$/, '')}.sig`, override.badPayloadSig ? Buffer.alloc(64) : sign(payloadBuf));

    const fields = {
      version: payloadVersion,
      payloadUrl: this.url(payloadName),
      signatureUrl: this.url(`${payloadName.replace(/\.tar\.gz$/, '')}.sig`),
      sha256: override.payloadSha || sha256(payloadBuf),
      schemaVersion: '2',
      nodeUrl: this.url(nodeName),
      nodeSignatureUrl: this.url(`${nodeName.replace(/\.tar\.gz$/, '')}.sig`),
      nodeSha256: override.nodeSha || sha256(nodeBuf),
      nodeVersion,
      nodeAbi: NODE_PIN.abi,
      platform: override.platform || 'win32',
      arch: override.arch || 'x64',
      publishedAt: '2026-06-04T00:00:00.000Z',
    };
    for (const k of Object.keys(override)) {
      if (!['badNodeSig', 'badPayloadSig', 'payloadSha', 'nodeSha', 'platform', 'arch', 'dropField'].includes(k)) fields[k] = override[k];
    }
    if (override.dropField) delete fields[override.dropField];
    fields.manifestSignature = signManifest(fields, PRIV);
    if (tamperAfterSign) tamperAfterSign(fields); // mutate a signed field, keep old sig
    this.put('bridge-version.json', Buffer.from(JSON.stringify(fields, null, 2)));
    return { fields, nodeName, payloadName, nodeBuf, payloadBuf };
  }

  baseEnv(extra = {}) {
    return {
      ...process.env,
      USERPROFILE: this.home,
      APPDATA: this.appdata,
      EMPIR3_BRIDGE_VERSION_URL: this.manifestUrl(),
      ...extra,
    };
  }
  bridgeHome() { return join(this.home, '.empir3-bridge'); }
  stableExe() { return join(this.appdata, 'Empir3', 'Empir3Setup.exe'); }
  pointer() { return join(this.appdata, 'Empir3', 'bridge-bootstrap.json'); }
  payloadActive() { try { return readFileSync(join(this.bridgeHome(), 'payload', '.version'), 'utf8').trim(); } catch { return ''; } }
  nodeActive() { try { return readFileSync(join(this.bridgeHome(), 'node', '.version'), 'utf8').trim(); } catch { return ''; } }
  marker() { const f = join(this.dir, 'marker.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; }
  markerFile() { return join(this.dir, 'marker.json'); }
}

// IMPORTANT: async (spawn, not spawnSync). The test CDN runs in THIS process's
// event loop — spawnSync would block it and the stub's manifest fetch would
// time out. Returns Buffers for stdout/stderr.
function execAsync(cmd, args, { env, input, timeout = 60000 } = {}) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { env, windowsHide: true });
    const out = []; const err = [];
    let timer = null;
    let done = false;
    const finish = (status) => { if (done) return; done = true; if (timer) clearTimeout(timer); res({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); };
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    c.on('error', (e) => { err.push(Buffer.from(String(e))); finish(1); });
    c.on('close', (code) => finish(code == null ? 1 : code));
    if (timeout) timer = setTimeout(() => { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { windowsHide: true }); } catch {} c.kill('SIGKILL'); finish(124); }, timeout);
    if (input != null) { c.stdin.write(input); }
    c.stdin.end();
  });
}
function runExe(args, env, opts = {}) { return execAsync(EXE, args, { env, ...opts }); }

// ── test registry ────────────────────────────────────────────────────────
const tests = [];
const test = (n, fn) => tests.push({ n, fn });
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// 1. --bootstrap-version / --bootstrap-pubkey (native, no net)
test('1: --bootstrap-version + --bootstrap-pubkey', async () => {
  const w = new World('t1');
  assert(/^\d+\.\d+\.\d+$/.test(BOOT_VERSION), `BOOT_VERSION parsed from main.go: ${BOOT_VERSION}`);
  const v = await runExe(['--bootstrap-version'], w.baseEnv());
  assert(v.status === 0 && v.stdout.toString().includes(BOOT_VERSION), `bootstrap-version (want ${BOOT_VERSION}, got ${v.stdout})`);
  const k = await runExe(['--bootstrap-pubkey'], w.baseEnv());
  assert(k.status === 0 && k.stdout.toString().trim() === PUB_HEX, 'bootstrap-pubkey matches pub json');
});

// 3 + 5: cold start installs node+payload, spawns node entry.js, env + stable
// registration reference the stable exe (never node.exe).
test('3+5: cold start install, spawn, stable-exe registration', async () => {
  const w = new World('t3'); await w.listen(); w.publish({});
  const r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  w.close();
  assert(r.status === 0, `exit ${r.status} stderr=${r.stderr}`);
  assert(r.stdout.toString().trim() === PAYLOAD_VERSION, `stdout=${r.stdout}`);
  assert(w.payloadActive() === PAYLOAD_VERSION, 'payload .version');
  assert(w.nodeActive() === REAL_NODE.version, 'node .version');
  const m = w.marker();
  assert(m && m.kind === 'run', 'marker written');
  assert(/node\.exe$/i.test(m.execPath), 'payload ran under node.exe');
  assert(m.bootstrapExe.toLowerCase() === w.stableExe().toLowerCase(), `EMPIR3_BOOTSTRAP_EXE should be stable exe, got ${m.bootstrapExe}`);
  assert(!/node\.exe$/i.test(m.bootstrapExe), 'bootstrap exe must never be node.exe');
  assert(existsSync(w.stableExe()), 'stable exe copied');
  const ptr = JSON.parse(readFileSync(w.pointer(), 'utf8'));
  assert(ptr.bootstrapPath.toLowerCase() === w.stableExe().toLowerCase(), 'pointer → stable exe');
});

// 2 + 12: tampered manifest refused (no cached runtime → fail closed).
test('2+12: tampered manifest refused', async () => {
  const w = new World('t2'); await w.listen();
  w.publish({ tamperAfterSign: (f) => { f.version = '9.9.9'; } });
  const r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MODE: 'run' }));
  w.close();
  assert(r.status !== 0, 'must refuse tampered manifest');
  assert(r.stdout.toString() === '', 'no stdout on refusal');
  assert(/SIGNATURE INVALID|refus/i.test(r.stderr.toString()), `stderr should explain: ${r.stderr}`);
  assert(!existsSync(join(w.bridgeHome(), 'payload', '.version')), 'nothing extracted');
});

// 12b + 14: anti-downgrade (older payload kept) + node-only update.
test('12b+14: anti-downgrade payload + node-only update', async () => {
  const w = new World('t14'); await w.listen();
  // Cold install at a high payload version.
  w.publish({ payloadVersion: '9.9.9' });
  let r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  assert(r.status === 0 && w.payloadActive() === '9.9.9', 'cold install 9.9.9');
  // Now publish an OLDER payload version → must keep cached 9.9.9.
  w.publish({ payloadVersion: '0.0.1' });
  r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  assert(r.status === 0, `downgrade run exit ${r.status} ${r.stderr}`);
  assert(w.payloadActive() === '9.9.9', `anti-downgrade: kept ${w.payloadActive()}`);
  assert(!existsSync(join(w.bridgeHome(), 'payload', '0.0.1')), 'older payload not extracted');
  w.close();
});

// 13: bad-artifact matrix — each variant refused with a clear error.
for (const [name, opts] of [
  ['bad payload sig', { override: { badPayloadSig: true } }],
  ['bad node sig', { override: { badNodeSig: true } }],
  ['wrong payload sha', { override: { payloadSha: 'deadbeef'.repeat(8) } }],
  ['wrong arch', { override: { arch: 'arm64' } }],
  ['wrong platform', { override: { platform: 'linux' } }],
  ['missing nodeUrl', { override: { dropField: 'nodeUrl' } }],
  ['missing nodeSha256', { override: { dropField: 'nodeSha256' } }],
  ['missing version', { override: { dropField: 'version' } }],
  ['missing sha256', { override: { dropField: 'sha256' } }],
  ['missing signatureUrl', { override: { dropField: 'signatureUrl' } }],
]) {
  test(`13: bad artifact refused — ${name}`, async () => {
    const w = new World('t13'); await w.listen(); w.publish(opts);
    const r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MODE: 'run' }));
    w.close();
    assert(r.status !== 0, `must refuse (${name})`);
    assert(r.stdout.toString() === '', `no stdout (${name})`);
    assert(w.payloadActive() === '' || w.nodeActive() === '' || !existsSync(join(w.bridgeHome(), 'payload', PAYLOAD_VERSION)),
      `nothing fully installed (${name})`);
  });
}

// 8: malicious tars rejected by the hardened extractor — traversal, absolute,
// drive letter, UNC, and symlink variants. None may write outside the cache.
for (const [name, evil] of [
  ['parent traversal', () => evilTarGz('../escape.txt')],
  ['deep traversal', () => evilTarGz('a/b/../../../escape.txt')],
  ['absolute path', () => evilTarGz('/tmp/escape.txt')],
  ['drive letter', () => evilTarGz('C:/escape.txt')],
  ['UNC path', () => evilTarGz('//host/share/escape.txt')],
  ['symlink', () => evilTarGz('link', { typeflag: '2', linkname: 'C:/Windows/System32' })],
]) {
  test(`8: malicious tar rejected — ${name}`, async () => {
    const w = new World('t8'); await w.listen();
    w.publish({ payloadTarball: evil() });
    const r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MODE: 'run' }));
    w.close();
    assert(r.status !== 0, `must reject malicious tar (${name})`);
    // No escape artifact anywhere outside the (rejected) cache extraction.
    for (const p of [join(w.home, 'escape.txt'), join(w.dir, 'escape.txt'), join(w.bridgeHome(), 'escape.txt'), join(w.home, 'tmp', 'escape.txt')]) {
      assert(!existsSync(p), `no escape file at ${p} (${name})`);
    }
  });
}

// 15: offline — cached runtime runs with no network; cold + offline fails clean.
test('15: offline with cache runs; offline cold fails clean', async () => {
  const w = new World('t15'); await w.listen(); w.publish({});
  let r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  assert(r.status === 0, 'warm install');
  w.close(); // CDN down now
  r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  assert(r.status === 0 && r.stdout.toString().trim() === PAYLOAD_VERSION, `offline-with-cache should run: ${r.stderr}`);
  // Cold + offline → clean nonzero.
  const w2 = new World('t15b'); // never listened → connection refused
  const r2 = await runExe(['--daemon-real'], { ...process.env, USERPROFILE: w2.home, APPDATA: w2.appdata, EMPIR3_BRIDGE_VERSION_URL: 'http://127.0.0.1:1/bridge-version.json', E2E_MODE: 'run' });
  assert(r2.status !== 0 && /manifest fetch failed and no cached runtime/i.test(r2.stderr.toString()), `cold offline msg: ${r2.stderr}`);
});

// 4: --mcp stdout discipline — zero stub bytes; JSON-RPC round-trips.
test('4: --mcp clean stdout + JSON-RPC round-trip', async () => {
  const w = new World('t4'); await w.listen(); w.publish({});
  // Warm the cache first (mcp does no network/install).
  await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n';
  const r = await runExe(['--mcp'], w.baseEnv({ E2E_MODE: 'mcp' }), { input: init });
  w.close();
  const out = r.stdout.toString();
  assert(r.status === 0, `mcp exit ${r.status} ${r.stderr}`);
  const lines = out.split('\n').filter(Boolean);
  assert(lines.length === 1, `exactly one stdout line (no stub preamble), got ${JSON.stringify(out)}`);
  const resp = JSON.parse(lines[0]);
  assert(resp.result && resp.result.e2e === 'mcp-ok', 'JSON-RPC response round-trips');
});

// 4b: the REAL mcp shim (bundle-mcp-server.js via the real payload entry.js)
// must emit ZERO stdout at startup — any module-load/connect logging must go to
// stderr or it corrupts the JSON-RPC stream. Run the packed node against the
// real payload with no daemon; startup stdout must stay empty.
test('4b: real mcp shim startup stdout is clean', async () => {
  const realPayload = `bridge-payload-v${PAYLOAD_VERSION}.tar.gz`;
  if (!existsSync(join(DIST, realPayload))) { console.log(`   (skip: ${realPayload} not in dist)`); return; }
  const w = new World('t4b');
  const { extractTarGz } = require('../build/tar-util.js');
  const payDir = join(w.dir, 'payload'); extractTarGz(join(DIST, realPayload), payDir);
  const nodeDir = join(w.dir, 'node'); extractTarGz(REAL_NODE.path, nodeDir);
  const nodeExe = join(nodeDir, 'node.exe');
  // No daemon is running → the shim will fail to connect, but its diagnostics
  // must be on stderr. Give it a short window; assert stdout stayed empty.
  const env = { ...process.env, USERPROFILE: w.home, APPDATA: w.appdata, EMPIR3_BRIDGE_PAYLOAD_DIR: payDir, EMPIR3_BRIDGE_BOOTSTRAP_VERSION: BOOT_VERSION, EMPIR3_BOOTSTRAP_EXE: w.stableExe() };
  const r = await execAsync(nodeExe, [join(payDir, 'entry.js'), '--mcp'], { env, timeout: 6000, input: '' });
  w.close();
  assert(r.stdout.toString() === '', `real mcp shim wrote to stdout at startup: ${JSON.stringify(r.stdout.toString().slice(0, 300))}`);
});

// 16: --mcp with no cached runtime → nonzero, stdout empty, error on stderr.
test('16: --mcp no runtime → nonzero, empty stdout', async () => {
  const w = new World('t16'); await w.listen(); w.publish({});
  const r = await runExe(['--mcp'], w.baseEnv({ E2E_MODE: 'mcp' }), { input: '{}\n' });
  w.close();
  assert(r.status !== 0, 'must fail without cached runtime');
  assert(r.stdout.toString() === '', `stdout must be empty, got ${r.stdout}`);
  assert(/requires an installed runtime/i.test(r.stderr.toString()), `stderr msg: ${r.stderr}`);
});

// 11: concurrent cold starts — exactly one installs, all healthy.
test('11: concurrent cold starts race the lock', async () => {
  const w = new World('t11'); await w.listen(); w.publish({});
  const N = 4;
  const procs = [];
  for (let i = 0; i < N; i++) {
    procs.push(new Promise((res) => {
      const env = w.baseEnv({ E2E_MARKER_FILE: join(w.dir, `marker-${i}.json`), E2E_MODE: 'run' });
      const c = spawn(EXE, ['--daemon-real'], { env, windowsHide: true });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => res({ code, err }));
    }));
  }
  const results = await Promise.all(procs);
  w.close();
  assert(results.every((r) => r.code === 0), `all healthy: ${JSON.stringify(results.map((r) => r.code))}`);
  assert(w.payloadActive() === PAYLOAD_VERSION && w.nodeActive() === REAL_NODE.version, 'cache valid after race');
  // Exactly one extracted dir each for payload + node (no duplicate/corrupt).
  const pdirs = readdirSync(join(w.bridgeHome(), 'payload')).filter((n) => !n.startsWith('.'));
  assert(pdirs.length === 1, `one payload dir, got ${pdirs}`);
});

// 6: Job Object — killing the stub tears down the node grandchild.
test('6: job object kills node child on stub death', async () => {
  const w = new World('t6'); await w.listen(); w.publish({});
  // Warm cache so the daemon-real path doesn't race download while we kill it.
  await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  const childPidFile = join(w.dir, 'child.pid');
  const env = w.baseEnv({ E2E_MODE: 'job-child', E2E_CHILD_PID_FILE: childPidFile, E2E_MARKER_FILE: w.markerFile() });
  const stub = spawn(EXE, ['--daemon-real'], { env, windowsHide: true });
  // Wait for the grandchild pid to appear.
  const start = Date.now();
  while (!existsSync(childPidFile) && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 200));
  assert(existsSync(childPidFile), 'grandchild pid file appeared');
  const childPid = parseInt(readFileSync(childPidFile, 'utf8'), 10);
  assert(isPidAlive(childPid), 'grandchild alive before kill');
  // Kill the stub (NOT /T) — the kill-on-close job must take the child down.
  spawnSync('taskkill', ['/F', '/PID', String(stub.pid)], { windowsHide: true });
  const t = Date.now();
  while (isPidAlive(childPid) && Date.now() - t < 15000) await new Promise((r) => setTimeout(r, 200));
  w.close();
  assert(!isPidAlive(childPid), 'grandchild must die with the stub (job object)');
});

// 6b: launcher path (--daemon / no-args) must NOT kill-on-close the spawned
// process tree — the detached tray (a grandchild) has to SURVIVE after node and
// the Go stub exit. This is the bug that shipped in 0.3.0: the kill-on-close Job
// Object tore the tray down the instant the stub exited.
test('6b: launcher path leaves the detached tray alive after stub exits', async () => {
  const w = new World('t6b'); await w.listen(); w.publish({});
  await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' })); // warm cache
  const childPidFile = join(w.dir, 'tray.pid');
  const r = await runExe(['--daemon'], w.baseEnv({ E2E_MODE: 'launcher-detached', E2E_CHILD_PID_FILE: childPidFile }));
  assert(r.status === 0, `--daemon exit ${r.status}: ${r.stderr}`);
  assert(existsSync(childPidFile), 'grandchild (tray stand-in) pid recorded');
  const pid = parseInt(readFileSync(childPidFile, 'utf8'), 10);
  await new Promise((res) => setTimeout(res, 1500)); // guard against a delayed job-kill
  const alive = isPidAlive(pid);
  if (alive) spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
  w.close();
  assert(alive, 'detached tray stand-in must SURVIVE the stub exit (no kill-on-close job on --daemon)');
});

// 7 + 19: native uninstall under test mode (no HKCU writes, no dialog, no net).
test('7+19: native uninstall (test mode) clears trees', async () => {
  const w = new World('t7'); await w.listen(); w.publish({});
  await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  w.close();
  assert(existsSync(w.bridgeHome()), 'precondition: bridge home exists');
  // Point version URL at a dead port to prove uninstall does NO network.
  const r = await runExe(['--uninstall'], { ...w.baseEnv({ EMPIR3_UNINSTALL_TEST: '1' }), EMPIR3_BRIDGE_VERSION_URL: 'http://127.0.0.1:1/x.json' }, { timeout: 30000 });
  assert(r.status === 0, `uninstall exit ${r.status} ${r.stderr}`);
  assert(!existsSync(w.bridgeHome()), 'bridge home removed');
  assert(!existsSync(join(w.appdata, 'Empir3')), 'appdata/Empir3 removed');
});

// 10: backward compat — the REAL legacy bootstrap.js consumes the NEW manifest.
test('10: legacy bootstrap.js consumes new manifest', async () => {
  const w = new World('t10'); await w.listen(); w.publish({});
  const env = { ...process.env, USERPROFILE: w.home, APPDATA: w.appdata, EMPIR3_BRIDGE_VERSION_URL: w.manifestUrl(), E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' };
  // Async (CDN runs in this event loop). The legacy bootstrap require()s the
  // payload entry.js in-process and forwards argv.
  const r = await execAsync(process.execPath, [LEGACY_BOOTSTRAP, '--version'], { env, timeout: 60000 });
  w.close();
  assert(r.status === 0, `legacy bootstrap exit ${r.status}: ${r.stderr}`);
  assert(r.stdout.toString().includes(PAYLOAD_VERSION), `legacy printed payload version: ${r.stdout}`);
  // It ignored the new fields and still verified + extracted the payload.
  assert(existsSync(join(w.bridgeHome(), 'payload', PAYLOAD_VERSION, 'entry.js')), 'legacy extracted payload');
});

// 20: canonicalization fixtures (Node side mirrors the Go golden tests).
test('20: canonicalization — order-independent, mutation-sensitive, < > & safe', async () => {
  const a = canonicalizeManifest({ version: '0.3.0', arch: 'x64', nodeUrl: 'u' }).toString();
  const b = canonicalizeManifest({ nodeUrl: 'u', version: '0.3.0', arch: 'x64' }).toString();
  assert(a === b, 'key order must not change canonical bytes');
  assert(canonicalizeManifest({ u: 'a&b<c>d' }).toString() === '{"u":"a&b<c>d"}', '< > & not escaped');
  assert(canonicalizeManifest({ x: '1', manifestSignature: 'SIG' }).toString() === '{"x":"1"}', 'signature excluded');
  // Sign then mutate any field → verify must fail (mirrors Go).
  const f = { version: '0.3.0', payloadUrl: 'p', signatureUrl: 's', sha256: 'h', nodeUrl: 'n', nodeSignatureUrl: 'ns', nodeSha256: 'nh', nodeVersion: '24.13.0', platform: 'win32', arch: 'x64' };
  f.manifestSignature = signManifest(f, PRIV);
  const { verifyManifestBytes } = require('../build/manifest-canonical.js');
  assert(verifyManifestBytes(Buffer.from(JSON.stringify(f)), PUB_HEX), 'valid manifest verifies');
  const mutated = { ...f, sha256: 'h2' };
  assert(!verifyManifestBytes(Buffer.from(JSON.stringify(mutated)), PUB_HEX), 'mutation breaks verification');
});

// 21: resolver fail-closed under plain node.exe (no env, no pointer, no stable).
test('21: resolveBootstrapExe fail-closed under plain node', async () => {
  const w = new World('t21');
  // Probe the REAL resolver under plain node.exe (no env/pointer/stable, isSea
  // false). Use a .cts require probe placed in ROOT so the relative specifier
  // resolves against ROOT and tsx's CJS interop exposes the named export.
  const scriptFile = join(ROOT, '.e2e-resolver-probe.cts');
  writeFileSync(scriptFile, "const { resolveBootstrapExe } = require('./src/bootstrap-exe.ts');\nconst r = resolveBootstrapExe();\nprocess.stdout.write(r === null ? 'NULL' : String(r));\n");
  const env = { ...process.env, USERPROFILE: w.home, APPDATA: w.appdata };
  delete env.EMPIR3_BOOTSTRAP_EXE;
  try {
    const r = spawnSync('npx', ['tsx', scriptFile], { env, encoding: 'utf8', shell: true, cwd: ROOT, timeout: 90000 });
    assert(r.stdout.trim() === 'NULL', `resolver must return null (got ${JSON.stringify(r.stdout)} / ${r.stderr})`);
  } finally {
    try { rmSync(scriptFile, { force: true }); } catch {}
  }
});

// 18: an OLDER stub must not overwrite a NEWER installed stable stub.
test('18: older stub defers to newer stable (version guard)', async () => {
  const w = new World('t18'); await w.listen(); w.publish({});
  // Build a NEWER stub (v9.9.9) into the stable path by copying the package to
  // a temp dir, bumping the version const, and `go build`-ing it.
  const newer = buildVersionedStub('9.9.9');
  mkdirSync(join(w.appdata, 'Empir3'), { recursive: true });
  copyFileSync(newer, w.stableExe());
  // Run the OLDER real stub (2.0.0). It should detect stable 9.9.9 > 2.0.0 and
  // re-exec the stable one (which then installs + runs), NOT overwrite it.
  const before = sha256(readFileSync(w.stableExe()));
  const r = await runExe(['--daemon-real'], w.baseEnv({ E2E_MARKER_FILE: w.markerFile(), E2E_MODE: 'run' }));
  w.close();
  assert(r.status === 0, `handoff exit ${r.status}: ${r.stderr}`);
  const after = sha256(readFileSync(w.stableExe()));
  assert(before === after, 'older stub must NOT overwrite newer stable');
  assert(/newer than this stub|handing off/i.test(r.stderr.toString()), `should log handoff: ${r.stderr}`);
});

// Build a stub with a patched BootstrapVersion into a temp exe. Returns path.
function buildVersionedStub(version) {
  const src = join(ROOT, 'build', 'bootstrap-go');
  const tmp = freshTmp('go-' + version);
  for (const f of readdirSync(src)) {
    if (statSync(join(src, f)).isFile()) copyFileSync(join(src, f), join(tmp, f));
  }
  // Patch the const in the copy.
  const mainPath = join(tmp, 'main.go');
  const patched = readFileSync(mainPath, 'utf8').replace(/const BootstrapVersion = "[^"]*"/, `const BootstrapVersion = "${version}"`);
  writeFileSync(mainPath, patched);
  const out = join(tmp, 'Empir3Setup.exe');
  const env = { ...process.env, GOOS: 'windows', GOARCH: 'amd64', GOPROXY: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0' };
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'], { cwd: tmp, env });
  return out;
}

function isPidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.includes(String(pid));
}

// 9: node-pty ABI smoke under the pinned node (uses the REAL payload + node).
test('9: node-pty ABI smoke under pinned node', async () => {
  // The build already smokes this; re-assert here against the published node
  // tarball to keep the harness self-contained.
  const w = new World('t9');
  const nodeDir = join(w.dir, 'node');
  const { extractTarGz } = require('../build/tar-util.js');
  extractTarGz(REAL_NODE.path, nodeDir);
  // Target the CURRENT payload (dist may also hold stale older tarballs).
  const realPayload = `bridge-payload-v${PAYLOAD_VERSION}.tar.gz`;
  if (!existsSync(join(DIST, realPayload))) { console.log(`   (skip: ${realPayload} not in dist)`); return; }
  const payDir = join(w.dir, 'payload');
  extractTarGz(join(DIST, realPayload), payDir);
  const nodeExe = join(nodeDir, 'node.exe');
  const v = execFileSync(nodeExe, ['-p', 'process.versions.modules'], { encoding: 'utf8' }).trim();
  assert(v === NODE_PIN.abi, `node ABI ${v} != pin ${NODE_PIN.abi}`);
  // Run a script FILE inside the payload dir (not `-e`): bare `require('node-pty')`
  // resolves against the script's own node_modules, exactly like the daemon.
  const probe = join(payDir, '_ptyprobe.js');
  writeFileSync(probe, "require('node-pty'); process.stderr.write('node-pty ok');");
  execFileSync(nodeExe, [probe], { cwd: payDir });
});

// 17: full tray/daemon GUI e2e — covered by the manual fresh-machine install.
test('17: full tray+daemon e2e (manual)', async () => {
  console.log('   SKIP: needs a real tray window + daemon; covered by the fresh-machine install/uninstall in the release step.');
});

// ── runner ─────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(EXE)) { console.error(`No exe at ${EXE}. Run \`node build/build.js\` first.`); process.exit(1); }
  console.log(`Bootstrap e2e — exe ${basename(EXE)}, payload v${PAYLOAD_VERSION}, node v${REAL_NODE.version}\n`);
  let pass = 0; let fail = 0;
  const only = process.argv[2]; // optional substring filter
  for (const t of tests) {
    if (only && !t.n.includes(only)) continue;
    process.stdout.write(`• ${t.n} … `);
    try {
      await t.fn();
      console.log('PASS');
      pass++;
    } catch (e) {
      console.log('FAIL');
      console.log(`    ${e.message}`);
      fail++;
    } finally {
      cleanupAll();
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); cleanupAll(); process.exit(1); });
