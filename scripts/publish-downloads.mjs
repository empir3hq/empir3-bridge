#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { basename, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Publish the bridge download artifacts in a STAGED order so a fresh Go stub can
 * never observe a manifest that points at not-yet-live artifacts, and the public
 * Empir3Setup.exe never reads a manifest before it is live:
 *
 *   1. node + payload tarballs (+ their .sig)  ── the manifest points at these
 *   2. bridge-version.json                      ── now points at #1, all live
 *   3. Empir3Setup.exe                          ── only after its manifest is live
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
const publicBase = process.env.EMPIR3_PAYLOAD_PUBLIC_URL_BASE || 'https://app.empir3.com/downloads';
const dryRun = process.argv.includes('--dry-run');
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

function sha256OfFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
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
    run('scp', [f.path, `${server}:${tmp}`]);
    if (dryRun) continue;
    const out = run('ssh', [server, `sha256sum '${tmp}'`], { capture: true });
    const remoteSha = (out.trim().split(/\s+/)[0] || '').toLowerCase();
    if (remoteSha !== f.sha) {
      run('ssh', [server, `rm -f '${tmp}'`]);
      fail(`server sha mismatch for ${name}: local ${f.sha} != remote ${remoteSha}`);
    }
    run('ssh', [server, `mv -f '${tmp}' '${final}'`]); // atomic swap into place
    console.log(`[publish-downloads]   ✓ ${name} on server (sha ok, atomic mv)`);
  }
}

// Verify a fresh client can actually fetch the artifact at the EXACT URL it will
// use, with the right bytes. The artifact URLs carry a cache-bust query, so this
// bypasses any Cloudflare cache and reflects origin.
function publicShaCheck(url, wantSha) {
  if (dryRun) return;
  const out = run('ssh', [server, `curl -fsSL '${url}' | sha256sum`], { capture: true });
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
    const out = run('ssh', [server, `curl -fsSL '${url}' | sha256sum`], { capture: true });
    const got = (out.trim().split(/\s+/)[0] || '').toLowerCase();
    if (got === wantSha) { console.log(`[publish-downloads]   ✓ public ${url.split('/').pop()} reflects new bytes (try ${i})`); return; }
    console.log(`[publish-downloads]   … public ${url.split('/').pop()} still stale (try ${i}/${tries}); got ${got.slice(0, 12)}…`);
    if (i < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); // block delayMs
  }
  fail(`public ${url} never returned the new sha (${wantSha}). Purge the Cloudflare cache for that URL, then re-run — the exe was NOT published, so nothing is half-live.`);
}

function publicGet200(name) {
  if (dryRun) return;
  run('ssh', [server, `curl -fsS -o /dev/null -w '%{http_code}' '${publicBase}/${name}' | grep -q 200 || (echo 'not 200' && exit 1)`]);
}

if (!existsSync(dist)) fail(`missing dist directory: ${dist}. Run npm run build:windows first.`);

const manifestPath = join(dist, 'bridge-version.json');
if (!existsSync(manifestPath)) fail('required artifact missing: bridge-version.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
if (!manifest.version) fail('bridge-version.json is missing version');
if (!manifest.nodeVersion) fail('bridge-version.json is missing nodeVersion (rebuild with the Go-bootstrapper build.js)');
if (!manifest.manifestSignature) fail('bridge-version.json is missing manifestSignature (rebuild)');

const payloadTar = `bridge-payload-v${manifest.version}.tar.gz`;
const payloadSig = `bridge-payload-v${manifest.version}.sig`;
const nodeTar = `node-win-x64-v${manifest.nodeVersion}.tar.gz`;
const nodeSig = `node-win-x64-v${manifest.nodeVersion}.sig`;

const f = (name, sha) => ({ path: requireArtifact(name), sha });

// sha of tarballs comes from the (signed) manifest; sigs/exe/manifest are
// verified by local-computed sha against the server copy.
const payloadTarFile = f(payloadTar, manifest.sha256.toLowerCase());
const nodeTarFile = f(nodeTar, manifest.nodeSha256.toLowerCase());
const payloadSigFile = f(payloadSig, sha256OfFile(requireArtifact(payloadSig)));
const nodeSigFile = f(nodeSig, sha256OfFile(requireArtifact(nodeSig)));
const manifestFile = f('bridge-version.json', sha256OfFile(manifestPath));
const exeFile = f('Empir3Setup.exe', sha256OfFile(requireArtifact('Empir3Setup.exe')));

// Local sanity: the tarballs on disk must match the manifest's declared shas.
if (sha256OfFile(payloadTarFile.path) !== payloadTarFile.sha) fail('local payload tarball sha != manifest.sha256 — rebuild');
if (sha256OfFile(nodeTarFile.path) !== nodeTarFile.sha) fail('local node tarball sha != manifest.nodeSha256 — rebuild');

console.log(`[publish-downloads] publishing bridge v${manifest.version} (node v${manifest.nodeVersion}) to ${server}:${remoteDir}`);
run('ssh', [server, `mkdir -p '${remoteDir}'`]);

// 1. Artifacts FIRST (the manifest will point at these).
uploadAndVerify('Stage 1: node + payload artifacts (+ sigs)',
  [nodeTarFile, nodeSigFile, payloadTarFile, payloadSigFile]);

// 1b. Confirm a fresh stub can fetch the EXACT signed URLs (payload/node tarballs
// AND their .sig — the stub fetches all four). These carry a unique ?v=&t= query,
// so Cloudflare can't serve a stale copy.
console.log('\n[publish-downloads] === Verify stub-visible artifact URLs ===');
publicShaCheck(manifest.nodeUrl, manifest.nodeSha256.toLowerCase());
publicShaCheck(manifest.payloadUrl, manifest.sha256.toLowerCase());
publicShaCheck(manifest.nodeSignatureUrl, sha256OfFile(nodeSigFile.path));
publicShaCheck(manifest.signatureUrl, sha256OfFile(payloadSigFile.path));

// 2. Manifest NEXT (now everything it references is live).
uploadAndVerify('Stage 2: signed manifest', [manifestFile]);

// 2b. CRITICAL ORDERING GATE: the public, fixed-name manifest URL must already
// return the NEW bytes BEFORE we publish the exe. The exe is the trigger — if it
// went live while bridge-version.json was still the stale (possibly pre-Go,
// nodeUrl-less) manifest, a fresh stub would read the wrong manifest. This
// fixed-name URL CAN be Cloudflare-cached, so retry briefly; if it never matches,
// abort and tell the operator to purge the CF cache for bridge-version.json.
console.log('\n[publish-downloads] === Gate: public manifest must reflect new bytes before exe ===');
publicShaCheckRetry(`${publicBase}/bridge-version.json`, manifestFile.sha, { tries: 10, delayMs: 3000 });

// 3. Empir3Setup.exe LAST (only after the manifest it reads is confirmed live).
uploadAndVerify('Stage 3: Empir3Setup.exe', [exeFile]);

// Final reachability of the exe (a stale-cached old exe still works since it
// re-reconciles, so a 200 is sufficient here).
publicGet200('Empir3Setup.exe');

console.log('\n[publish-downloads] done');
console.log(`  Installer: ${publicBase}/Empir3Setup.exe`);
console.log(`  Manifest:  ${publicBase}/bridge-version.json`);
console.log(`  Node:      ${publicBase}/${nodeTar}`);
console.log(`  Payload:   ${publicBase}/${payloadTar}`);
