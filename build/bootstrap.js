#!/usr/bin/env node
/**
 * Empir3 Bridge — bootstrapper (stable SEA entry).
 *
 * This is the part of Empir3Setup.exe that should NEVER change after the
 * first signed release. Its only job is to fetch, verify, cache, and
 * execute a remote-hosted "payload" tarball that contains the actual
 * bridge code (daemon, installer, etc.).
 *
 * Why split things this way:
 *   - Empir3Setup.exe is an unsigned binary today and a code-signed binary
 *     once we wire Azure Trusted Signing. Each rebuild produces a new
 *     hash, which throws away SmartScreen reputation. By keeping the
 *     bootstrapper code small and frozen, the exe hash stays stable and
 *     reputation accumulates. New code ships as payload updates.
 *
 *   - Mirrors how Chrome / VSCode / Electron / many CLIs do auto-updates:
 *     a small native bootstrapper validates a signed manifest + payload
 *     and hands off to it.
 *
 * Trust model:
 *   - The bootstrapper holds an Ed25519 PUBLIC key (compiled in below).
 *   - The build machine holds the matching PRIVATE key
 *     (`bridge/build/payload-signing-key.pem`, gitignored, treated as a
 *     credential — see `bridge/build/payload-signing-pub.json` for the
 *     public half + how to rotate).
 *   - Every payload is a tarball + a detached Ed25519 signature over its
 *     bytes. The bootstrapper refuses to run a payload whose signature
 *     doesn't verify against the embedded pubkey. If the signing key is
 *     ever compromised, rotation requires shipping a new bootstrapper
 *     exe (which IS a signing event under SmartScreen / Azure Trusted
 *     Signing — same shape as Chrome's stage-2 root rotation).
 *
 * Update flow at runtime:
 *   1. GET https://app.empir3.com/downloads/bridge-version.json
 *      → { version, payloadUrl, signatureUrl, sha256 }
 *   2. Compare server `version` to the locally cached payload version
 *      stored at `~/.empir3-bridge/payload/.version`.
 *   3. If newer (or no cached payload), download tarball + signature.
 *   4. Verify signature with `crypto.verify(null, tarballBuf, pubKey, sig)`
 *      (Ed25519 — Node 20+ accepts a null algorithm).
 *   5. Verify sha256 matches the manifest.
 *   6. Extract tarball into `~/.empir3-bridge/payload/<version>/`.
 *   7. Atomically swap `.version` to the new value.
 *   8. require() `payload/<version>/entry.js` and forward argv.
 *
 * Failure modes:
 *   - Server unreachable      → run last-known-good cached payload.
 *   - Signature fails         → keep cached payload, log loudly, refuse update.
 *   - sha256 mismatch         → same as above.
 *   - No cached payload AND
 *     no network              → exit with a clear "first-run requires
 *                               internet" message.
 *   - Payload entry.js throws → propagate as fatal error to the exe caller
 *                               (the payload is responsible for its own
 *                               error handling internally).
 *
 * Bootstrapper-only concerns (NOT delegated to the payload):
 *   - Hard-coded pubkey, version-check URL, payload cache layout.
 *   - The `--bootstrap-version` and `--bootstrap-pubkey` debug flags.
 *
 * Everything else — `--daemon`, `--uninstall`, `--version`, `--help`,
 * autostart, force-install policy, asset extraction, Koba installer UI,
 * relay client, CDP handlers — lives inside the payload's entry.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

// ─── Compile-time constants ────────────────────────────────────────────

const BOOTSTRAP_VERSION = '1.1.0';

// Ed25519 public key (32 raw bytes, hex). Generated once with
// `node bridge/build/build.js --gen-key` (which writes the matching
// private key to bridge/build/payload-signing-key.pem). The public half
// is also committed at bridge/build/payload-signing-pub.json for audit.
const PAYLOAD_PUBKEY_HEX = 'a0813b51654fcb6026c0cfc9d0f367c8535b96c94b52c9fff15d2fe59f7cd68a';

// The version manifest lives next to the payload tarball + signature on
// the public CDN. All four URLs end up resolved relative to this base.
const VERSION_URL = process.env.EMPIR3_BRIDGE_VERSION_URL
  || 'https://app.empir3.com/downloads/bridge-version.json';

// Where the bootstrapper caches payloads it has fetched + verified.
//   ~/.empir3-bridge/payload/.version           ← currently active version
//   ~/.empir3-bridge/payload/<version>/         ← extracted tree
//   ~/.empir3-bridge/payload/<version>.tar.gz   ← retained for re-verify
//   ~/.empir3-bridge/payload/<version>.sig      ← retained for re-verify
const HOME = os.homedir();
const BRIDGE_HOME = path.join(HOME, '.empir3-bridge');
const PAYLOAD_ROOT = path.join(BRIDGE_HOME, 'payload');
const ACTIVE_VERSION_FILE = path.join(PAYLOAD_ROOT, '.version');

// Install footprint the bootstrapper can tear down WITHOUT the payload. The
// payload (payload-entry.js) owns the canonical uninstall; these mirror its
// constants and power the no-cached-payload fallback only. Keep in sync.
const APPDATA_ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const APPDATA_DIR = path.join(APPDATA_ROAMING, 'Empir3');
const AUTOSTART_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE_NAME = 'Empir3Bridge';
const FORCELIST_KEY = 'HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist';
const EXTENSION_ID = 'gbigofjjgcpjkffhlfepjdglabhngeii';
const START_MENU_LNK = path.join(APPDATA_ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Empir3', 'Empir3.lnk');

// Network timeout for the initial version probe. Short — we fall back to
// the cached payload very fast so a flaky network doesn't slow the daemon
// or installer launch.
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const PAYLOAD_DOWNLOAD_TIMEOUT_MS = 60_000;

// ─── Public-key import (DER SPKI from raw 32 bytes) ────────────────────

// Node's crypto.verify wants a KeyObject. Wrap our 32 raw bytes in the
// fixed Ed25519 SPKI prefix:
//   30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes pubkey>
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function loadPubKey() {
  const raw = Buffer.from(PAYLOAD_PUBKEY_HEX, 'hex');
  if (raw.length !== 32) throw new Error(`Bad PAYLOAD_PUBKEY_HEX length: ${raw.length}`);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// ─── Tiny HTTPS GET helpers (no external deps) ─────────────────────────

function fetchBuffer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': `empir3-bootstrap/${BOOTSTRAP_VERSION}` } }, (res) => {
      // Follow one redirect (CDN failover etc.).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchBuffer(next, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`timeout fetching ${url}`)); });
  });
}

async function fetchJson(url, timeoutMs) {
  const buf = await fetchBuffer(url, timeoutMs);
  return JSON.parse(buf.toString('utf8'));
}

// ─── Payload cache helpers ─────────────────────────────────────────────

function readActiveVersion() {
  try { return fs.readFileSync(ACTIVE_VERSION_FILE, 'utf8').trim(); } catch { return null; }
}

function payloadDir(version) {
  return path.join(PAYLOAD_ROOT, version);
}

function payloadIsExtracted(version) {
  if (!version) return false;
  return fs.existsSync(path.join(payloadDir(version), 'entry.js'));
}

function compareVersions(a, b) {
  const left = String(a || '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10));
  const right = String(b || '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10));
  const len = Math.max(left.length, right.length, 3);
  for (let i = 0; i < len; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

function writeActiveVersion(version) {
  fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
  // Atomic-ish: write to .new then rename.
  const tmp = `${ACTIVE_VERSION_FILE}.new`;
  fs.writeFileSync(tmp, version);
  fs.renameSync(tmp, ACTIVE_VERSION_FILE);
}

// ─── Tar extraction (built-in, no npm deps) ────────────────────────────

// Minimal POSIX-tar extractor. Handles regular files + directories +
// long names (GNU 'L' headers). Inputs are .tar.gz buffers; we gunzip via
// zlib (built-in) into the raw tar stream then parse blocks of 512.
//
// Deliberately built in-process (no `tar` npm dep, no shelling out to
// bsdtar) so the bootstrapper is fully self-contained inside the SEA
// blob. ~80 lines.
async function extractTarGz(tarGzBuffer, destDir) {
  const zlib = require('zlib');
  const raw = await new Promise((resolve, reject) => {
    zlib.gunzip(tarGzBuffer, (err, out) => err ? reject(err) : resolve(out));
  });

  fs.mkdirSync(destDir, { recursive: true });

  const BLOCK = 512;
  let pos = 0;
  let pendingLongName = null;

  while (pos + BLOCK <= raw.length) {
    const header = raw.slice(pos, pos + BLOCK);
    // Empty block(s) at the end mark EOF.
    if (header.every((b) => b === 0)) { pos += BLOCK; continue; }

    // Parse name (100), size (12), typeflag (1).
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');

    if (prefix && name) name = prefix + '/' + name;
    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }

    pos += BLOCK;
    const dataEnd = pos + size;
    const data = raw.slice(pos, dataEnd);
    pos = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (!name) continue;

    if (typeflag === 'L') {
      // GNU long-name header — name of the NEXT entry is in this block's data.
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // pax extended headers — ignore, we don't need their metadata.
      continue;
    }

    // Sanitize: strip leading slashes, reject path traversal.
    const safeRel = name.replace(/^\.?\/+/, '');
    if (safeRel.includes('..')) throw new Error(`Refusing tar entry with .. in path: ${name}`);
    const out = path.join(destDir, safeRel);
    if (!out.startsWith(destDir)) throw new Error(`Tar entry escapes dest dir: ${name}`);

    if (typeflag === '5' || name.endsWith('/')) {
      fs.mkdirSync(out, { recursive: true });
    } else if (typeflag === '0' || typeflag === '' || typeflag === '\0') {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
    }
    // We ignore symlinks ('2'), hardlinks ('1'), block/char devices, etc.
    // Our payload tarballs only ship regular files + dirs (build script
    // enforces this).
  }
}

// ─── Main update + dispatch flow ───────────────────────────────────────

function log(msg) { console.log(`[empir3-bootstrap] ${msg}`); }
function warn(msg) { console.warn(`[empir3-bootstrap] WARN: ${msg}`); }
function err(msg) { console.error(`[empir3-bootstrap] ERROR: ${msg}`); }

async function tryUpdate() {
  let manifest;
  try {
    manifest = await fetchJson(VERSION_URL, VERSION_PROBE_TIMEOUT_MS);
  } catch (e) {
    warn(`version probe failed (${e.message}); using cached payload if any.`);
    return null;
  }
  if (!manifest || typeof manifest.version !== 'string' || !manifest.payloadUrl || !manifest.signatureUrl) {
    warn('version manifest malformed; using cached payload if any.');
    return null;
  }

  const active = readActiveVersion();
  if (payloadIsExtracted(active) && compareVersions(active, manifest.version) > 0) {
    warn(`active payload v${active} is newer than manifest v${manifest.version}; keeping cached payload.`);
    return active;
  }

  if (active === manifest.version && payloadIsExtracted(active)) {
    return active; // already on latest
  }

  if (payloadIsExtracted(manifest.version)) {
    writeActiveVersion(manifest.version);
    log(`using existing payload v${manifest.version}`);
    return manifest.version;
  }

  log(`fetching payload v${manifest.version} (have: ${active || 'none'})`);
  let tarball, signature;
  try {
    [tarball, signature] = await Promise.all([
      fetchBuffer(manifest.payloadUrl, PAYLOAD_DOWNLOAD_TIMEOUT_MS),
      fetchBuffer(manifest.signatureUrl, PAYLOAD_DOWNLOAD_TIMEOUT_MS),
    ]);
  } catch (e) {
    warn(`payload download failed (${e.message}); using cached payload if any.`);
    return null;
  }

  // Verify Ed25519 signature over tarball bytes.
  let pubKey;
  try { pubKey = loadPubKey(); }
  catch (e) { err(`embedded pubkey is corrupt: ${e.message}`); return null; }

  let valid = false;
  try { valid = crypto.verify(null, tarball, pubKey, signature); }
  catch (e) { err(`signature verify threw: ${e.message}`); return null; }
  if (!valid) {
    err(`SIGNATURE INVALID for payload v${manifest.version} — refusing to install. Keeping cached payload.`);
    return null;
  }

  // Verify sha256 (defence-in-depth — catches a benign CDN swap).
  if (manifest.sha256) {
    const got = crypto.createHash('sha256').update(tarball).digest('hex');
    if (got !== manifest.sha256) {
      err(`sha256 mismatch (got ${got}, expected ${manifest.sha256}) — refusing to install.`);
      return null;
    }
  }

  // Extract into a fresh dir; only flip .version once it's intact.
  const destDir = payloadDir(manifest.version);
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    await extractTarGz(tarball, destDir);
    if (!fs.existsSync(path.join(destDir, 'entry.js'))) {
      throw new Error('payload missing entry.js after extraction');
    }
    // Persist the verified tar + sig alongside (lets ops re-verify
    // off-machine without redownload, and lets uninstall clear them).
    fs.writeFileSync(path.join(PAYLOAD_ROOT, `${manifest.version}.tar.gz`), tarball);
    fs.writeFileSync(path.join(PAYLOAD_ROOT, `${manifest.version}.sig`), signature);
    writeActiveVersion(manifest.version);
    log(`installed payload v${manifest.version}`);
    return manifest.version;
  } catch (e) {
    err(`payload install failed: ${e.message}`);
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}

function dispatchToPayload(version) {
  const entry = path.join(payloadDir(version), 'entry.js');
  if (!fs.existsSync(entry)) {
    err(`payload entry.js missing at ${entry}`);
    process.exit(70); // EX_SOFTWARE
  }

  // Tell the payload where it lives + what bootstrap loaded it. The
  // payload uses these to find its bundled-asset siblings (installer-ui/)
  // without needing SEA-asset extraction.
  process.env.EMPIR3_BRIDGE_PAYLOAD_DIR = payloadDir(version);
  process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION = version;
  process.env.EMPIR3_BRIDGE_BOOTSTRAP_VERSION = BOOTSTRAP_VERSION;

  // Give the payload a clean require() that resolves against its own
  // extracted tree (so any internal `require('./foo')` works).
  const payloadRequire = Module.createRequire(entry);
  const payload = payloadRequire(entry);

  // Payload contract: export an async start(argv) function. argv is the
  // forwarded CLI args (excluding node + script).
  if (typeof payload.start !== 'function') {
    err('payload entry.js does not export start(argv)');
    process.exit(70);
  }
  return payload.start(process.argv.slice(2));
}

// ─── Uninstall (network-free) ──────────────────────────────────────────
//
// Uninstall is a teardown: it must never depend on the network or on
// fetching a fresh payload — downloading the very thing we're about to
// delete is nonsensical and would fail offline. main() dispatches to the
// cached payload's canonical uninstall when one is extracted; this native
// fallback runs only when no usable payload is on disk (corrupt / partial
// install), so a broken payload can never leave the user unable to remove
// the bridge. It mirrors payload-entry.js uninstall() — keep them aligned.

function showUninstallDoneDialog(steps) {
  if (process.platform !== 'win32') return;
  try {
    const body =
      'Empir3 Bridge has been uninstalled.\n\n' +
      `${steps} item(s) were removed. You can delete Empir3Setup.exe whenever you like.\n\n` +
      'If Chrome is open, the helper extension disappears the next time you restart it.';
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    const ps =
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null; ' +
      '[System.Windows.Forms.MessageBox]::Show(' +
      `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')),` +
      "'Empir3 Bridge','OK','Information') | Out-Null";
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps],
      { stdio: 'ignore', windowsHide: true });
  } catch {}
}

function nativeUninstall() {
  log('uninstalling (native fallback — no cached payload to delegate to)');
  let steps = 0;
  const isWin = process.platform === 'win32';

  if (isWin) {
    // Kill the tray first so it can't respawn anything we kill on a port.
    const tk = spawnSync('taskkill', ['/F', '/IM', 'Empir3Tray.exe'], { encoding: 'utf8' });
    if (tk.status === 0) { log('  killed Empir3Tray.exe'); steps++; }

    // Stop any running daemon (anything listening on 3006-3306).
    const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    if (ns.stdout) {
      const seen = new Set();
      for (const port of [3006, 3106, 3206, 3306]) {
        for (const line of ns.stdout.split('\n')) {
          if ((line.includes(`127.0.0.1:${port}`) || line.includes(`0.0.0.0:${port}`)) && /LISTENING/.test(line)) {
            const m = line.match(/(\d+)\s*$/);
            if (m) seen.add(m[1]);
          }
        }
      }
      for (const pid of seen) {
        if (pid === String(process.pid)) continue;
        spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
        log(`  killed bridge daemon pid ${pid}`); steps++;
      }
    }

    // Autostart entry — critical: without this it relaunches on next login.
    if (spawnSync('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_VALUE_NAME], { encoding: 'utf8' }).status === 0) {
      spawnSync('reg', ['delete', AUTOSTART_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'], { stdio: 'ignore' });
      log('  removed Windows autostart'); steps++;
    }

    // Chrome force-install policy — only the slots that hold OUR extension.
    const q = spawnSync('reg', ['query', FORCELIST_KEY], { encoding: 'utf8' });
    if (q.status === 0 && q.stdout) {
      const re = /\s+(\S+)\s+REG_SZ\s+(.+?)\s*$/gm;
      let m;
      while ((m = re.exec(q.stdout)) !== null) {
        if (m[2].startsWith(EXTENSION_ID + ';')) {
          spawnSync('reg', ['delete', FORCELIST_KEY, '/v', m[1], '/f'], { stdio: 'ignore' });
          log(`  removed Chrome force-install policy (slot ${m[1]})`); steps++;
        }
      }
    }

    // Start Menu shortcut + parent folder (if empty).
    try {
      if (fs.existsSync(START_MENU_LNK)) {
        fs.rmSync(START_MENU_LNK, { force: true });
        log('  removed Start Menu shortcut'); steps++;
      }
      const folder = path.dirname(START_MENU_LNK);
      if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
    } catch {}
  }

  // Cached payloads + extracted runtime files (the whole ~/.empir3-bridge).
  try {
    fs.rmSync(BRIDGE_HOME, { recursive: true, force: true });
    log('  cleared ~/.empir3-bridge (payloads + runtime files)'); steps++;
  } catch {}

  // Auth, settings, logs. The running Empir3Setup.exe lives here and can't
  // delete itself — that's expected and documented.
  if (isWin) {
    try {
      if (fs.existsSync(APPDATA_DIR)) {
        fs.rmSync(APPDATA_DIR, { recursive: true, force: true });
        log('  cleared %APPDATA%/Empir3 (auth, settings, logs)'); steps++;
      }
    } catch (e) {
      warn(`could not fully clear %APPDATA%/Empir3: ${e.message}`);
    }
  }

  log(`uninstall complete (${steps} steps).`);
  log('Note: Empir3Setup.exe can be deleted manually.');
  showUninstallDoneDialog(steps);
}

async function main() {
  const argv = process.argv.slice(2);

  // Bootstrap-only debug flags. Help/version of the bridge itself live in
  // the payload (so users get the SHIPPED help, not the frozen version
  // baked into the exe).
  if (argv.includes('--bootstrap-version')) {
    console.log(`empir3-bootstrap ${BOOTSTRAP_VERSION}`);
    return;
  }
  if (argv.includes('--bootstrap-pubkey')) {
    console.log(PAYLOAD_PUBKEY_HEX);
    return;
  }

  // Uninstall runs BEFORE any network/update logic. It tears the install
  // down using only what's already on disk — never downloads (you don't
  // fetch the thing you're about to delete, and it must work offline).
  // Delegate to the cached payload's canonical uninstall when present;
  // otherwise fall back to the self-contained native cleanup.
  if (argv.includes('--uninstall')) {
    const cached = readActiveVersion();
    if (cached && payloadIsExtracted(cached)) {
      log(`uninstalling via cached payload v${cached} (offline)`);
      await dispatchToPayload(cached);
    } else {
      nativeUninstall();
    }
    return;
  }

  // Try to bring the local payload up to date with the server's manifest.
  // Returns the new active version on success, null on any kind of fail.
  let active = await tryUpdate();
  if (!active) active = readActiveVersion();

  if (!active || !payloadIsExtracted(active)) {
    err('No usable payload installed and update failed. ' +
        'First-run requires network access to ' + VERSION_URL + '.');
    process.exit(69); // EX_UNAVAILABLE
  }

  // Hand off. The payload is now fully responsible for everything
  // (--daemon, --uninstall, --version, --help, installer UI, etc.).
  await dispatchToPayload(active);
}

main().catch((e) => {
  err(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
