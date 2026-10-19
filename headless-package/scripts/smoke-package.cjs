'use strict';

const { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { extractTarGz } = require('../../build/tar-util.js');

function makeRuntimeReadOnly(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      makeRuntimeReadOnly(path);
      chmodSync(path, 0o555);
    } else if (stat.isFile()) {
      chmodSync(path, 0o444);
    }
  }
  chmodSync(root, 0o555);
}

function makeRuntimeRemovable(root) {
  chmodSync(root, 0o755);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) makeRuntimeRemovable(path);
    else if (stat.isFile()) chmodSync(path, 0o644);
  }
}

if (process.platform !== 'linux') throw new Error('Headless package smoke must run on Linux');
const packageRoot = resolve(__dirname, '..');
const bridgeRoot = resolve(packageRoot, '..');
const outRoot = join(packageRoot, 'out');
const archives = readdirSync(outRoot).filter((name) => name.endsWith('.tar.gz'));
if (archives.length !== 1) throw new Error(`Expected one headless archive; found ${archives.length}`);
const tempRoot = join(tmpdir(), `empir3-headless-package-${process.pid}-${Date.now()}`);
const extractRoot = join(tempRoot, 'package');
const runtimeRoot = join(extractRoot, 'runtime');
mkdirSync(extractRoot, { recursive: true });
try {
  extractTarGz(join(outRoot, archives[0]), extractRoot);
  for (const required of ['install.sh', 'uninstall.sh', 'package-metadata.json', 'runtime/trust/update-public-key.json', 'runtime/src/headless-entry.js', 'runtime/src/headless-update.cjs', 'runtime/src/install-config.cjs', 'runtime/dist/bundle-pair-claim.js']) {
    if (!existsSync(join(extractRoot, required))) throw new Error(`Package is missing ${required}`);
  }
  const metadata = JSON.parse(readFileSync(join(extractRoot, 'package-metadata.json'), 'utf8'));
  if (metadata.platform !== 'linux' || metadata.arch !== process.arch) throw new Error('Package metadata target mismatch');
  const nativeProbe = spawnSync(process.execPath, ['-e', "require('node-pty'); process.stdout.write('node-pty ok')"], {
    cwd: runtimeRoot,
    encoding: 'utf8',
  });
  if (nativeProbe.status !== 0 || nativeProbe.stdout !== 'node-pty ok') {
    throw new Error(`Packaged node-pty failed: ${nativeProbe.stderr || nativeProbe.stdout}`);
  }
  const workingRoot = join(tempRoot, 'service-home');
  mkdirSync(workingRoot, { recursive: true });
  makeRuntimeReadOnly(runtimeRoot);
  const smoke = spawnSync(process.execPath, [join(bridgeRoot, 'scripts', 'smoke-headless.mjs')], {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      EMPIR3_SMOKE_RUNTIME_ROOT: runtimeRoot,
      EMPIR3_SMOKE_WORKING_DIR: workingRoot,
      EMPIR3_SMOKE_ALIVE_MS: process.env.EMPIR3_SMOKE_ALIVE_MS || '3000',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(smoke.stdout || '');
  process.stderr.write(smoke.stderr || '');
  if (smoke.status !== 0) throw new Error(`Packaged headless runtime smoke failed (${smoke.status})`);
  console.log(JSON.stringify({ ok: true, archive: archives[0], version: metadata.version, arch: metadata.arch }));
} finally {
  if (existsSync(runtimeRoot)) makeRuntimeRemovable(runtimeRoot);
  rmSync(tempRoot, { recursive: true, force: true });
}
