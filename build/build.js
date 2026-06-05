#!/usr/bin/env node
/**
 * Empir3 Bridge — build pipeline (Phase 9: native Go bootstrapper).
 *
 * Empir3Setup.exe is now a small native **Go** stub (build/bootstrap-go/),
 * ~6.6 MB, that fetches a signed payload + a signed pinned Node runtime at
 * first run and caches both. The old 86 MB Node-SEA bootstrapper is gone.
 *
 * One `node build/build.js` run produces four independently-signed artifact
 * streams plus one signed manifest:
 *
 *   1. Empir3Setup.exe         ← `go build` of build/bootstrap-go. Embeds the
 *                                Ed25519 pubkey + BOOTSTRAP_VERSION as source
 *                                constants (asserted against
 *                                payload-signing-pub.json here) and an
 *                                asInvoker manifest (committed .syso) so the
 *                                "*Setup.exe" name does not trip UAC.
 *
 *   2. node-win-x64-v<ver>.tar.gz (+ .sig)
 *                              ← a pinned official Node runtime (node-pin.json),
 *                                downloaded, sha-verified, repacked flat
 *                                (node.exe + LICENSE) and Ed25519-signed. The
 *                                ABI is pinned to match node-pty's prebuilds.
 *
 *   3. bridge-payload-vX.Y.Z.tar.gz (+ .sig)
 *                              ← bundle-daemon/bridge/server/installer/mcp +
 *                                entry.js + installer-ui + tray + node-pty
 *                                runtime, deterministic tar.gz, Ed25519-signed.
 *                                Contains NO Node runtime (kept lean).
 *
 *   4. bridge-version.json     ← the SIGNED release manifest. Legacy fields
 *                                (version/payloadUrl/signatureUrl/sha256) kept
 *                                verbatim for old SEA installs; new node + trust
 *                                fields added alongside; an embedded
 *                                `manifestSignature` (Ed25519 over the canonical
 *                                form — see build/manifest-canonical.js, which is
 *                                byte-identical to the Go stub's verifier).
 *
 * Run:
 *   cd bridge && node build/build.js              (full Windows build)
 *   cd bridge && node build/build.js --check       (release preflight, bundles only)
 *
 * Outputs (under bridge/build/dist/):
 *   Empir3Setup.exe
 *   node-win-x64-v<nodeVer>.tar.gz  + .sig
 *   bridge-payload-vX.Y.Z.tar.gz    + .sig
 *   bridge-version.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
const { canonicalizeManifest, signManifest, verifyManifestBytes } = require('./manifest-canonical');
const { buildDeterministicTarGz, extractTarGz } = require('./tar-util');

const BRIDGE_DIR = path.resolve(__dirname, '..');
const BUILD_DIR  = __dirname;
const DIST_DIR   = path.join(BUILD_DIR, 'dist');
const CHECK_DIR  = path.join(BUILD_DIR, 'check');
const CHECK_ONLY = process.argv.includes('--check');

// ── Go bootstrapper (becomes Empir3Setup.exe) ──────────────────────
const GO_DIR   = path.join(BUILD_DIR, 'bootstrap-go');
const GO_MAIN  = path.join(GO_DIR, 'main.go');
const EXE_OUT  = path.join(DIST_DIR, 'Empir3Setup.exe');

// ── Signing ─────────────────────────────────────────────────────────
const SIGNING_KEY  = path.join(BUILD_DIR, 'payload-signing-key.pem');
const PUB_JSON     = path.join(BUILD_DIR, 'payload-signing-pub.json');

// ── Pinned Node runtime ─────────────────────────────────────────────
const NODE_PIN_FILE = path.join(BUILD_DIR, 'node-pin.json');
const NODE_CACHE_DIR = path.join(BUILD_DIR, 'node-cache'); // verified upstream zips

// ── Payload (signed tarball, served from CDN) ──────────────────────
const PAYLOAD_VERSION  = readPayloadVersion();
const PAYLOAD_STAGING  = path.join(BUILD_DIR, 'payload-staging');
const PAYLOAD_TARBALL  = path.join(DIST_DIR, `bridge-payload-v${PAYLOAD_VERSION}.tar.gz`);
const PAYLOAD_SIG      = path.join(DIST_DIR, `bridge-payload-v${PAYLOAD_VERSION}.sig`);
const VERSION_MANIFEST = path.join(DIST_DIR, 'bridge-version.json');

const DAEMON_SRC       = path.join(BRIDGE_DIR, 'src', 'payload-daemon.ts');
const BRIDGE_SRC       = path.join(BRIDGE_DIR, 'src', 'bridge.ts');
const SERVER_SRC       = path.join(BRIDGE_DIR, 'src', 'server.ts');
const INSTALLER_SRC    = path.join(BRIDGE_DIR, 'installer', 'server.js');
const MCP_SERVER_SRC   = path.join(BRIDGE_DIR, 'src', 'mcp-server.ts');
const PAIR_CLAIM_SRC   = path.join(BRIDGE_DIR, 'src', 'pair-claim.ts');
const PAYLOAD_ENTRY_SRC = path.join(BUILD_DIR, 'payload-entry.js');

// ── Tray (PyInstaller — Windows-only) ──────────────────────────────
const TRAY_DIR         = path.join(BRIDGE_DIR, 'tray');
const TRAY_PY          = path.join(TRAY_DIR, 'tray.py');
const TRAY_BUILD_PY    = path.join(TRAY_DIR, 'build.py');
const TRAY_EXE         = path.join(DIST_DIR, 'Empir3Tray.exe');

const PAYLOAD_BASE_URL = process.env.EMPIR3_PAYLOAD_PUBLIC_URL_BASE
  || 'https://app.empir3.com/downloads';

function readPayloadVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'package.json'), 'utf8'));
  return pkg.version || '0.0.0';
}

function step(label) { console.log(`\n[build] ${label}`); }
function run(cmd, args, opts = {}) {
  const executable = process.platform === 'win32' && cmd === 'npx' ? 'npx.cmd' : cmd;
  const r = spawnSync(executable, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}
function rmIfExists(p) { try { fs.rmSync(p, { force: true, recursive: true }); } catch {} }
function sha256OfFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function sha256OfBuf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

function loadPubKeyHex() {
  const pub = JSON.parse(fs.readFileSync(PUB_JSON, 'utf8'));
  if (!pub.publicKeyHex || !/^[0-9a-f]{64}$/i.test(pub.publicKeyHex)) {
    throw new Error(`${PUB_JSON} publicKeyHex missing or not 32-byte hex`);
  }
  return pub.publicKeyHex.toLowerCase();
}

function loadPrivateKey() {
  if (!fs.existsSync(SIGNING_KEY)) {
    throw new Error(
      `Missing payload signing key at ${SIGNING_KEY}. The full Windows build needs the private signing key.`,
    );
  }
  return crypto.createPrivateKey(fs.readFileSync(SIGNING_KEY));
}

// Sign arbitrary bytes with the Ed25519 key; verify against the embedded
// pubkey before returning (catches a key/pub mismatch immediately).
function signBytes(buf, privateKey, pubKeyHex) {
  const sig = crypto.sign(null, buf, privateKey);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!crypto.verify(null, buf, pub, sig)) {
    throw new Error('Self-verify of signature FAILED — signing key + pub mismatch?');
  }
  return sig;
}

function bundle(inputPath, outputPath, label) {
  step(`Bundling ${label} → ${path.relative(BRIDGE_DIR, outputPath)}`);
  const esbuild = path.join(BRIDGE_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild');
  run(process.execPath, [
    esbuild,
    inputPath,
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    `--outfile=${outputPath}`,
    '--external:node:sea',
    '--external:node-pty',
  ], { cwd: BRIDGE_DIR });
}

// ── STAGE 1: Go bootstrapper → Empir3Setup.exe ──────────────────────

// Read a `const Name = "value"` string constant out of a Go source file.
function readGoStringConst(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

// The Go stub embeds the pubkey + bootstrap version as source constants
// (golden-tested). Assert they agree with payload-signing-pub.json so the exe
// we ship can never verify against a different trust root than the artifacts.
function assertGoConstants(pubKeyHex) {
  const src = fs.readFileSync(GO_MAIN, 'utf8');
  const goPub = (readGoStringConst(src, 'PubKeyHex') || '').toLowerCase();
  const goVer = readGoStringConst(src, 'BootstrapVersion') || '';
  if (goPub !== pubKeyHex) {
    throw new Error(`Go stub PubKeyHex (${goPub}) != payload-signing-pub.json (${pubKeyHex})`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(goVer)) {
    throw new Error(`Go stub BootstrapVersion looks wrong: ${goVer}`);
  }
  step(`Go constants OK — pubkey matches, BOOTSTRAP_VERSION=${goVer}`);
  return goVer;
}

function buildBootstrapExe(pubKeyHex) {
  step('=== STAGE 1: Go bootstrapper → Empir3Setup.exe ===');
  const bootVer = assertGoConstants(pubKeyHex);

  rmIfExists(EXE_OUT);
  // GOOS/GOARCH pinned so the windows/amd64 .syso (asInvoker manifest + icon)
  // is always linked, even when building from a non-Windows host. GOPROXY=off
  // + GOTOOLCHAIN=local: the stub has zero module deps, so it must build fully
  // offline and never fetch a toolchain.
  const goEnv = {
    ...process.env,
    GOOS: 'windows',
    GOARCH: 'amd64',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    CGO_ENABLED: '0',
  };
  run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', EXE_OUT, '.'],
    { cwd: GO_DIR, env: goEnv });
  if (!fs.existsSync(EXE_OUT)) throw new Error('go build produced no exe');

  verifyExeManifestAndLaunch(bootVer);

  const exeHash = sha256OfFile(EXE_OUT);
  const sz = (fs.statSync(EXE_OUT).size / 1024 / 1024).toFixed(1);
  step(`Empir3Setup.exe ready — ${sz} MB, sha256=${exeHash}`);
  return { hash: exeHash, bootstrapVersion: bootVer };
}

// CI guard (Codex): the built exe MUST carry an asInvoker manifest and MUST
// launch without elevation. We assert the manifest string is embedded, and —
// when building on Windows — that `--bootstrap-version` runs non-elevated and
// prints the expected version (an installer-detected exe would force a UAC
// prompt and the non-elevated spawn would fail).
function verifyExeManifestAndLaunch(bootVer) {
  const bytes = fs.readFileSync(EXE_OUT);
  if (bytes.includes(Buffer.from('asInvoker', 'utf16le')) || bytes.includes(Buffer.from('asInvoker', 'latin1'))) {
    step('asInvoker manifest present in exe');
  } else {
    throw new Error('Built exe is MISSING the asInvoker manifest (resource_windows_amd64.syso not linked?)');
  }
  if (process.platform !== 'win32') {
    step('skipping non-elevated launch check (not on Windows)');
    return;
  }
  const r = spawnSync(EXE_OUT, ['--bootstrap-version'], { encoding: 'utf8' });
  if (r.status !== 0 || !String(r.stdout || '').includes(bootVer)) {
    throw new Error(
      `Non-elevated launch check failed (status=${r.status}, stdout=${JSON.stringify(r.stdout)}, ` +
      `stderr=${JSON.stringify(r.stderr)}). The exe may be tripping UAC installer detection.`);
  }
  step(`Non-elevated launch OK — printed "${String(r.stdout).trim()}"`);
}

// ── STAGE 2: pinned Node runtime artifact ───────────────────────────

function readNodePin() {
  const pin = JSON.parse(fs.readFileSync(NODE_PIN_FILE, 'utf8'));
  for (const k of ['version', 'url', 'sha256', 'abi']) {
    if (!pin[k]) throw new Error(`node-pin.json missing ${k}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(pin.sha256)) throw new Error('node-pin.json sha256 not 64-hex');
  return pin;
}

// Fetch a URL to a Buffer via Node's built-in fetch (Node 18+). Bounded.
async function fetchToBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Download (or reuse a verified cache of) the official Node win-x64 zip, verify
// its sha256 against the pin BEFORE touching it.
async function fetchPinnedNodeZip(pin) {
  fs.mkdirSync(NODE_CACHE_DIR, { recursive: true });
  const zipName = path.basename(new URL(pin.url).pathname);
  const cached = path.join(NODE_CACHE_DIR, zipName);
  if (fs.existsSync(cached) && sha256OfFile(cached) === pin.sha256.toLowerCase()) {
    step(`Using cached verified Node zip: ${path.relative(BRIDGE_DIR, cached)}`);
    return cached;
  }
  step(`Downloading pinned Node ${pin.version} from ${pin.url}`);
  const buf = await fetchToBuffer(pin.url);
  const got = sha256OfBuf(buf).toLowerCase();
  if (got !== pin.sha256.toLowerCase()) {
    throw new Error(`Pinned Node sha256 mismatch: got ${got}, pinned ${pin.sha256}`);
  }
  fs.writeFileSync(cached, buf);
  step(`Pinned Node zip verified (sha256 ok) → ${path.relative(BRIDGE_DIR, cached)}`);
  return cached;
}

// Extract node.exe + LICENSE (+ any root *.dll) from the official zip. The
// official archive nests everything under node-vX.Y.Z-win-x64/. We pull the
// minimal runtime into a flat staging dir so the repacked tarball extracts to
// <nodeDir>/node.exe (what the Go stub's nodeExe() expects).
function extractMinimalNode(zipPath, pin, stagingDir) {
  rmIfExists(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  const unzipDir = path.join(stagingDir, '_unzip');
  fs.mkdirSync(unzipDir, { recursive: true });

  // PowerShell Expand-Archive is present on every Win10/11. (tar.exe can read
  // zips too, but Expand-Archive is the most portable on Windows.)
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${unzipDir.replace(/'/g, "''")}' -Force`]);
  } else {
    run('unzip', ['-q', zipPath, '-d', unzipDir]);
  }

  const inner = path.join(unzipDir, `node-v${pin.version}-win-x64`);
  if (!fs.existsSync(inner)) throw new Error(`expected ${inner} inside node zip`);

  const flat = path.join(stagingDir, 'flat');
  fs.mkdirSync(flat, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(inner)) {
    const abs = path.join(inner, name);
    const st = fs.statSync(abs);
    if (!st.isFile()) continue;
    if (name === 'node.exe' || name === 'LICENSE' || /\.dll$/i.test(name)) {
      fs.copyFileSync(abs, path.join(flat, name));
      copied++;
    }
  }
  if (!fs.existsSync(path.join(flat, 'node.exe'))) {
    throw new Error('node.exe not found in pinned Node zip');
  }
  step(`Repacked minimal Node runtime: ${copied} file(s) (node.exe + LICENSE${copied > 2 ? ' + dll(s)' : ''})`);
  return flat;
}

async function buildNodeArtifact(privateKey, pubKeyHex) {
  step('=== STAGE 2: pinned Node runtime (signed) ===');
  if (process.platform !== 'win32') {
    console.warn('[build] WARN: Node artifact repack/verify needs Windows (must run node.exe). Skipping.');
    return null;
  }
  const pin = readNodePin();
  const zip = await fetchPinnedNodeZip(pin);
  const staging = path.join(BUILD_DIR, 'node-staging');
  const flat = extractMinimalNode(zip, pin, staging);

  const tarball = path.join(DIST_DIR, `node-win-x64-v${pin.version}.tar.gz`);
  const sig = path.join(DIST_DIR, `node-win-x64-v${pin.version}.sig`);
  fs.mkdirSync(DIST_DIR, { recursive: true });

  step(`Packing Node tarball → ${path.relative(BRIDGE_DIR, tarball)}`);
  const tarGz = buildDeterministicTarGz(flat);
  fs.writeFileSync(tarball, tarGz);

  step(`Signing Node tarball → ${path.relative(BRIDGE_DIR, sig)}`);
  fs.writeFileSync(sig, signBytes(tarGz, privateKey, pubKeyHex));

  const sha256 = sha256OfFile(tarball);

  // Verify against the PACKED artifact (not the prepack dir): extract the
  // just-built tarball to a temp dir and run THAT node.exe.
  const verifyDir = path.join(staging, 'verify');
  extractTarGz(tarball, verifyDir);
  const verifyNode = path.join(verifyDir, 'node.exe');
  const verStr = execFileSync(verifyNode, ['--version'], { encoding: 'utf8' }).trim();
  if (verStr !== `v${pin.version}`) {
    throw new Error(`packed node --version = ${verStr}, expected v${pin.version}`);
  }
  const abiStr = execFileSync(verifyNode, ['-p', 'process.versions.modules'], { encoding: 'utf8' }).trim();
  if (abiStr !== String(pin.abi)) {
    throw new Error(`packed node ABI = ${abiStr}, pin.abi = ${pin.abi} (node-pty prebuilds would mismatch)`);
  }
  step(`Packed Node verified: ${verStr}, ABI ${abiStr}`);

  rmIfExists(staging);

  const sz = (tarGz.length / 1024 / 1024).toFixed(1);
  step(`Node artifact v${pin.version} — ${sz} MB, sha256=${sha256}`);
  return {
    version: pin.version,
    abi: String(pin.abi),
    platform: pin.platform || 'win32',
    arch: pin.arch || 'x64',
    tarballName: path.basename(tarball),
    sigName: path.basename(sig),
    tarballPath: tarball,
    sha256,
  };
}

// ── deterministic tar.gz writer (shared by node + payload artifacts) ──

function copyTreeFlat(srcDir, destDir, files) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const abs = path.join(srcDir, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    fs.copyFileSync(abs, path.join(destDir, f));
  }
}

function copyTreeRecursive(srcDir, destDir, opts = {}) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (opts.skip && opts.skip(name)) continue;
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyTreeRecursive(src, dest, opts);
    else if (st.isFile()) fs.copyFileSync(src, dest);
  }
}

function copyNodePtyRuntime(stagingDir) {
  const src = path.join(BRIDGE_DIR, 'node_modules', 'node-pty');
  if (!fs.existsSync(src)) {
    throw new Error('node-pty dependency missing. Run `npm install` before building the bridge payload.');
  }
  const dest = path.join(stagingDir, 'node_modules', 'node-pty');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['package.json', 'LICENSE']) {
    const abs = path.join(src, file);
    if (fs.existsSync(abs)) fs.copyFileSync(abs, path.join(dest, file));
  }
  const skipDebugSymbols = (name) => /\.pdb$/i.test(name);
  copyTreeRecursive(path.join(src, 'lib'), path.join(dest, 'lib'));
  copyTreeRecursive(path.join(src, 'prebuilds'), path.join(dest, 'prebuilds'), { skip: skipDebugSymbols });
  copyTreeRecursive(path.join(src, 'build', 'Release'), path.join(dest, 'build', 'Release'), { skip: skipDebugSymbols });
  step(`Copied node-pty runtime into payload (${path.relative(BRIDGE_DIR, dest)})`);
}

// ── STAGE 3: payload tarball (signed) ───────────────────────────────

function buildPayload(privateKey, pubKeyHex) {
  step('=== STAGE 3: payload (daemon + installer + assets, signed) ===');

  rmIfExists(PAYLOAD_STAGING);
  fs.mkdirSync(PAYLOAD_STAGING, { recursive: true });

  bundle(DAEMON_SRC, path.join(PAYLOAD_STAGING, 'bundle-daemon.js'), 'daemon');
  bundle(BRIDGE_SRC, path.join(PAYLOAD_STAGING, 'bundle-bridge.js'), 'cdp bridge');
  bundle(SERVER_SRC, path.join(PAYLOAD_STAGING, 'bundle-server.js'), 'http wrapper');
  bundle(INSTALLER_SRC, path.join(PAYLOAD_STAGING, 'bundle-installer.js'), 'installer');
  bundle(MCP_SERVER_SRC, path.join(PAYLOAD_STAGING, 'bundle-mcp-server.js'), 'mcp-server');
  bundle(PAIR_CLAIM_SRC, path.join(PAYLOAD_STAGING, 'bundle-pair-claim.js'), 'pair-claim');

  copyNodePtyRuntime(PAYLOAD_STAGING);

  fs.copyFileSync(PAYLOAD_ENTRY_SRC, path.join(PAYLOAD_STAGING, 'entry.js'));

  const uiSrc = path.join(BRIDGE_DIR, 'installer', 'ui');
  copyTreeFlat(uiSrc, path.join(PAYLOAD_STAGING, 'installer-ui'),
    fs.readdirSync(uiSrc).filter((f) => fs.statSync(path.join(uiSrc, f)).isFile()));

  if (fs.existsSync(TRAY_EXE)) {
    const dest = path.join(PAYLOAD_STAGING, 'Empir3Tray.exe');
    fs.copyFileSync(TRAY_EXE, dest);
    step(`Bundled tray into payload: ${path.relative(BRIDGE_DIR, dest)}`);
  } else if (process.platform === 'win32') {
    // RELEASE INVARIANT (Codex): a Windows release payload MUST carry the tray.
    // Without it the --daemon launcher path has no GUI surface and would take
    // the supervised-fallback relaunch — acceptable as a runtime safety net, but
    // shipping a payload with no tray at all is a defect, not a warning.
    throw new Error(`Empir3Tray.exe missing at ${TRAY_EXE} — refusing to build a tray-less release payload. Build the tray first (python ${path.relative(BRIDGE_DIR, TRAY_BUILD_PY)}).`);
  } else {
    console.warn(`[build] WARN: tray exe not found at ${TRAY_EXE} (non-Windows dev build) — payload will use the headless fallback.`);
  }

  const accuracyLabSrc = path.join(BRIDGE_DIR, 'assets', 'accuracy-lab.html');
  if (fs.existsSync(accuracyLabSrc)) {
    fs.copyFileSync(accuracyLabSrc, path.join(PAYLOAD_STAGING, 'accuracy-lab.html'));
    step('Bundled accuracy-lab.html into payload');
  }

  fs.writeFileSync(path.join(PAYLOAD_STAGING, '.payload-version'), PAYLOAD_VERSION);

  step(`Packing payload tarball → ${path.relative(BRIDGE_DIR, PAYLOAD_TARBALL)}`);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const tarGz = buildDeterministicTarGz(PAYLOAD_STAGING);
  fs.writeFileSync(PAYLOAD_TARBALL, tarGz);

  step(`Signing payload → ${path.relative(BRIDGE_DIR, PAYLOAD_SIG)}`);
  fs.writeFileSync(PAYLOAD_SIG, signBytes(tarGz, privateKey, pubKeyHex));

  const sha256 = sha256OfFile(PAYLOAD_TARBALL);
  step(`Payload v${PAYLOAD_VERSION} — ${(tarGz.length / 1024 / 1024).toFixed(1)} MB, sha256=${sha256}`);
  return {
    version: PAYLOAD_VERSION,
    tarballName: path.basename(PAYLOAD_TARBALL),
    sigName: path.basename(PAYLOAD_SIG),
    sha256,
  };
}

// ── STAGE 4: signed release manifest ────────────────────────────────

function buildManifest(payload, node, privateKey, pubKeyHex) {
  step('=== STAGE 4: signed release manifest (bridge-version.json) ===');
  if (!node) {
    throw new Error('Cannot build manifest without the Node artifact (Windows build required).');
  }
  // Cache-bust query string keeps Cloudflare from serving a stale artifact at a
  // reused filename. It is part of the signed URL strings.
  const t = Date.now();
  const bust = (v) => `?v=${encodeURIComponent(v)}&t=${t}`;
  const base = PAYLOAD_BASE_URL;

  // EVERY value is a string (no numbers/floats/nulls) — required by the
  // canonicalization contract. Legacy fields kept verbatim for old SEA
  // bootstrappers (version/payloadUrl/signatureUrl/sha256).
  const fields = {
    // ── legacy (do NOT rename) ──
    version: payload.version,
    payloadUrl: `${base}/${payload.tarballName}${bust(payload.version)}`,
    signatureUrl: `${base}/${payload.sigName}${bust(payload.version)}`,
    sha256: payload.sha256,
    // ── new (Go stub only; old bootstrappers ignore) ──
    schemaVersion: '2',
    nodeUrl: `${base}/${node.tarballName}${bust(node.version)}`,
    nodeSignatureUrl: `${base}/${node.sigName}${bust(node.version)}`,
    nodeSha256: node.sha256,
    nodeVersion: node.version,
    nodeAbi: node.abi,
    platform: node.platform,
    arch: node.arch,
    publishedAt: new Date(t).toISOString(),
  };
  // Embed manifestSignature (Ed25519 over the canonical form of all OTHER
  // fields). build/manifest-canonical.js is byte-identical to the Go verifier.
  fields.manifestSignature = signManifest(fields, privateKey);

  fs.writeFileSync(VERSION_MANIFEST, JSON.stringify(fields, null, 2) + '\n');
  step(`Manifest written → ${path.relative(BRIDGE_DIR, VERSION_MANIFEST)}`);
  return fields;
}

// ── Self-verify everything the stub will check, the way the stub checks it ──

function selfVerifyAll(payload, node, pubKeyHex) {
  step('=== Self-verify: payload sig, node sig, manifest sig ===');

  const verifyDetached = (label, tarball, sigFile) => {
    const data = fs.readFileSync(tarball);
    const sig = fs.readFileSync(sigFile);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubKeyHex, 'hex')]);
    const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (!crypto.verify(null, data, pub, sig)) throw new Error(`${label} signature self-verify FAILED`);
    if (sha256OfFile(tarball) !== (label === 'payload' ? payload.sha256 : node.sha256)) {
      throw new Error(`${label} sha256 self-check FAILED`);
    }
    step(`  ${label} sig + sha256 OK`);
  };

  verifyDetached('payload', PAYLOAD_TARBALL, PAYLOAD_SIG);
  verifyDetached('node', node.tarballPath, path.join(DIST_DIR, node.sigName));

  // Re-parse the manifest from disk and verify exactly like the stub.
  const raw = fs.readFileSync(VERSION_MANIFEST);
  if (!verifyManifestBytes(raw, pubKeyHex)) {
    throw new Error('manifest signature self-verify FAILED (would be refused by the stub)');
  }
  step('  manifest sig OK (re-parsed like the stub)');
}

// Smoke: extract payload + node to a temp dir and run the PACKED node against
// entry.js (--version) and require('node-pty') (ABI match).
function smokePackedRuntime(node) {
  step('=== Smoke: packed node runs entry.js + loads node-pty ===');
  if (process.platform !== 'win32' || !node) {
    console.warn('[build] WARN: skipping runtime smoke (needs Windows + node artifact).');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empir3-smoke-'));
  try {
    const payloadDir = path.join(tmp, 'payload');
    const nodeDir = path.join(tmp, 'node');
    extractTarGz(PAYLOAD_TARBALL, payloadDir);
    extractTarGz(node.tarballPath, nodeDir);
    const nodeExe = path.join(nodeDir, 'node.exe');

    const v = execFileSync(nodeExe, [path.join(payloadDir, 'entry.js'), '--version'],
      { cwd: payloadDir, encoding: 'utf8', env: { ...process.env, EMPIR3_BRIDGE_PAYLOAD_DIR: payloadDir } }).trim();
    if (v !== PAYLOAD_VERSION) throw new Error(`entry.js --version = ${v}, expected ${PAYLOAD_VERSION}`);
    step(`  node entry.js --version → ${v}`);

    execFileSync(nodeExe, ['-e', "require('node-pty'); console.error('node-pty ok')"],
      { cwd: payloadDir, encoding: 'utf8' });
    step('  node -e "require(\'node-pty\')" OK (ABI matches)');
  } finally {
    rmIfExists(tmp);
  }
}

// ── Tray exe (PyInstaller) ──────────────────────────────────────────

function buildTrayExe() {
  step('=== STAGE 2b: tray (Empir3Tray.exe via PyInstaller) ===');

  if (process.platform !== 'win32') {
    console.warn('[build] WARN: skipping tray build — only supported on Windows for now.');
    return;
  }
  if (!fs.existsSync(TRAY_PY) || !fs.existsSync(TRAY_BUILD_PY)) {
    console.warn(`[build] WARN: tray sources missing (${TRAY_PY}); skipping tray build.`);
    return;
  }

  // Clear any prior tray exe first so a failed PyInstaller run can never let a
  // stale tray slip into the payload (Codex hardening).
  rmIfExists(TRAY_EXE);
  const py = process.env.PYTHON || 'python';
  const r = spawnSync(py, [TRAY_BUILD_PY], { stdio: 'inherit', cwd: TRAY_DIR, shell: false });
  if (r.status !== 0) {
    console.warn(`[build] WARN: tray PyInstaller build failed (exit ${r.status}). Payload will fall back to headless --daemon.`);
    return;
  }
  if (!fs.existsSync(TRAY_EXE)) {
    console.warn(`[build] WARN: PyInstaller reported success but ${TRAY_EXE} missing.`);
    return;
  }
  const sz = (fs.statSync(TRAY_EXE).size / 1024 / 1024).toFixed(1);
  step(`Tray exe ready → ${path.relative(BRIDGE_DIR, TRAY_EXE)} (${sz} MB)`);
}

function checkReleaseInputs() {
  step('=== Release preflight: bundle inputs only ===');
  rmIfExists(CHECK_DIR);
  fs.mkdirSync(CHECK_DIR, { recursive: true });

  bundle(DAEMON_SRC, path.join(CHECK_DIR, 'bundle-daemon.js'), 'daemon');
  bundle(BRIDGE_SRC, path.join(CHECK_DIR, 'bundle-bridge.js'), 'cdp bridge');
  bundle(SERVER_SRC, path.join(CHECK_DIR, 'bundle-server.js'), 'http wrapper');
  bundle(INSTALLER_SRC, path.join(CHECK_DIR, 'bundle-installer.js'), 'installer');
  bundle(MCP_SERVER_SRC, path.join(CHECK_DIR, 'bundle-mcp-server.js'), 'mcp-server');
  bundle(PAIR_CLAIM_SRC, path.join(CHECK_DIR, 'bundle-pair-claim.js'), 'pair-claim');

  // Assert the Go trust root matches the pub json (cheap, no Go toolchain).
  assertGoConstants(loadPubKeyHex());

  const required = [
    PAYLOAD_ENTRY_SRC,
    path.join(BRIDGE_DIR, 'installer', 'ui', 'index.html'),
    TRAY_PY,
    TRAY_BUILD_PY,
    PUB_JSON,
    NODE_PIN_FILE,
    GO_MAIN,
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error(`Missing release input: ${file}`);
  }
  step(`Release preflight OK for payload v${PAYLOAD_VERSION}`);
  step('Full Windows build still requires: Go toolchain, the private signing key, Windows tray tooling, network for the pinned Node download.');
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  if (CHECK_ONLY) {
    checkReleaseInputs();
    return;
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });

  const pubKeyHex = loadPubKeyHex();
  const privateKey = loadPrivateKey();

  const exe = buildBootstrapExe(pubKeyHex);
  const node = await buildNodeArtifact(privateKey, pubKeyHex);
  buildTrayExe();                       // before buildPayload so the tarball includes it
  const payload = buildPayload(privateKey, pubKeyHex);
  const manifest = buildManifest(payload, node, privateKey, pubKeyHex);

  selfVerifyAll(payload, node, pubKeyHex);
  smokePackedRuntime(node);

  step('=== Done ===');
  step(`Empir3Setup.exe sha256: ${exe.hash} (bootstrap v${exe.bootstrapVersion})`);
  step(`Node runtime:           v${node.version} (ABI ${node.abi}) sha256 ${node.sha256}`);
  step(`Payload:                v${manifest.version} sha256 ${manifest.sha256}`);
  step('');
  step('Publish (enforces order: node+payload → manifest → exe):');
  step('  npm run publish:downloads');
}

main().catch((e) => {
  console.error('\n[build] FAILED:', e.stack || e.message);
  process.exit(1);
});
