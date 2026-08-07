'use strict';

const { createHash, generateKeyPairSync } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { buildReleaseManifestV3 } = require('../../build/release-manifest-v3.js');
const { signManifest } = require('../../build/manifest-canonical.js');
const {
  checkForDesktopUpdate,
  downloadVerifiedArtifact,
} = require('../src/updater.cjs');

if (process.platform !== 'linux') throw new Error('Linux update lifecycle smoke requires a native Linux host');
if (process.env.CI !== 'true' && process.env.EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST !== '1') {
  throw new Error('Linux update lifecycle smoke changes the native package database and is restricted to CI unless EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST=1 is explicitly set');
}

const shellRoot = resolve(__dirname, '..');
const smokeScript = join(__dirname, 'smoke-package.cjs');

function walk(root, files = []) {
  if (!existsSync(root)) return files;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function run(command, args, { capture = false, env = process.env, timeout = 240_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: shellRoot,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function packagePresent(packageName) {
  const result = spawnSync('dpkg-query', ['-W', '-f=${db:Status-Abbrev}', packageName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && String(result.stdout).trim().length > 0;
}

function packageVersion(packageName) {
  return run('dpkg-query', ['-W', '-f=${Version}', packageName], { capture: true });
}

function installedExecutable(packageName) {
  const paths = run('dpkg', ['-L', packageName], { capture: true }).split(/\r?\n/)
    .filter((path) => basename(path) === 'empir3-bridge' && existsSync(path));
  const executable = paths.find((path) => statSync(path).isFile()) || paths[0];
  if (!executable) throw new Error(`Installed package ${packageName} exposed no empir3-bridge executable`);
  return executable;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function nextPatchVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Cannot synthesize update from non-release version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function createVersionedDeb(sourceDeb, version, scratch) {
  const unpacked = join(scratch, `deb-${version}`);
  run('dpkg-deb', ['-R', sourceDeb, unpacked]);

  const controlPath = join(unpacked, 'DEBIAN', 'control');
  const control = readFileSync(controlPath, 'utf8');
  if (!/^Version:\s*\S+/m.test(control)) throw new Error('DEB control file has no Version field');
  writeFileSync(controlPath, control.replace(/^Version:\s*\S+/m, `Version: ${version}`));
  rmSync(join(unpacked, 'DEBIAN', 'md5sums'), { force: true });

  const archives = walk(unpacked).filter((file) => basename(file) === 'app.asar');
  if (archives.length !== 1) throw new Error(`Expected one app.asar in DEB, found ${archives.length}`);
  const appRoot = join(scratch, `asar-${version}`);
  asar.extractAll(archives[0], appRoot);
  const packagePath = join(appRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const rebuiltAsar = `${archives[0]}.next`;
  await asar.createPackage(appRoot, rebuiltAsar);
  rmSync(archives[0]);
  renameSync(rebuiltAsar, archives[0]);

  const output = join(scratch, `empir3-bridge-desktop_${version}_${process.arch}.deb`);
  run('fakeroot', ['dpkg-deb', '--build', unpacked, output]);
  return output;
}

function makeSignedWorld({ debPath, version, rolloutState, previousVersion = '', privateKey, publicKeyHex }) {
  const bytes = readFileSync(debPath);
  const target = `desktop-linux-${process.arch}`;
  const artifactName = `empir3-bridge-linux-${process.arch}-${version}.deb`;
  const artifactUrl = `https://native-update.empir3.test/${artifactName}`;
  const indexUrl = `https://native-update.empir3.test/index-${version}-${rolloutState}.json`;
  const manifestUrl = `https://native-update.empir3.test/manifest-${version}-${rolloutState}.json`;
  const artifact = {
    id: `${target}-installer-deb`,
    target,
    platform: 'linux',
    arch: process.arch,
    kind: 'installer',
    format: 'deb',
    sourceName: basename(debPath),
    sourcePath: debPath,
    publicName: artifactName,
    url: artifactUrl,
    bytes: bytes.length,
    sha256: sha256(bytes),
    signed: true,
    authenticationScheme: 'ed25519-manifest-sha256',
  };
  const index = {
    schemaVersion: 1,
    version,
    rollout: {
      channel: 'production',
      state: rolloutState,
      percent: 100,
      seed: `native-${process.arch}-${version}-${rolloutState}`,
      previousVersion,
    },
    health: { [target]: 'release-approved' },
    artifacts: [artifact],
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  const manifest = buildReleaseManifestV3({
    version,
    payloadUrl: 'https://native-update.empir3.test/legacy-payload.tar.gz',
    signatureUrl: 'https://native-update.empir3.test/legacy-payload.sig',
    sha256: '0'.repeat(64),
  }, index, {
    artifactIndexUrl: indexUrl,
    artifactIndexSha256: sha256(indexBytes),
  });
  manifest.manifestSignature = signManifest(manifest, privateKey);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const fetcher = async (url) => {
    const body = url === manifestUrl
      ? manifestBytes
      : url === indexUrl
        ? indexBytes
        : url === artifactUrl
          ? bytes
          : null;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
  return { artifact, fetcher, manifestUrl, publicKeyHex };
}

function installDeb(debPath, { allowDowngrade = false } = {}) {
  const args = ['apt-get', 'install', '-y'];
  if (allowDowngrade) args.push('--allow-downgrades');
  args.push(debPath);
  run('sudo', args);
}

function runInstalledSmoke(packageName, version, persistentSmokeRoot) {
  const executable = installedExecutable(packageName);
  run(process.execPath, [smokeScript], {
    env: {
      ...process.env,
      EMPIR3_DESKTOP_SMOKE_EXECUTABLE: executable,
      EMPIR3_DESKTOP_ARCH: process.arch,
      EMPIR3_DESKTOP_SMOKE_EXPECTED_VERSION: version,
      EMPIR3_DESKTOP_SMOKE_ROOT: persistentSmokeRoot,
    },
  });
}

async function selectAndDownload(world, currentVersion, destination, expectedStatus) {
  const result = await checkForDesktopUpdate({
    manifestUrl: world.manifestUrl,
    currentVersion,
    platform: 'linux',
    arch: process.arch,
    deviceId: `native-${process.arch}-acceptance`,
    publicKeyHex: world.publicKeyHex,
    fetcher: world.fetcher,
  });
  if (result.status !== expectedStatus) {
    throw new Error(`Expected signed update status ${expectedStatus}, got ${result.status}`);
  }
  const downloaded = await downloadVerifiedArtifact(result.artifact, destination, { fetcher: world.fetcher });
  if (downloaded.reused) throw new Error('Fresh signed installer download was unexpectedly reused');
  return downloaded.path;
}

async function main() {
  const debs = walk(join(shellRoot, 'out', 'make')).filter((file) => file.endsWith('.deb'));
  if (debs.length !== 1) throw new Error(`Expected one DEB installer, found ${debs.length}`);
  const sourceDeb = debs[0];
  const packageName = run('dpkg-deb', ['-f', sourceDeb, 'Package'], { capture: true });
  const baseVersion = run('dpkg-deb', ['-f', sourceDeb, 'Version'], { capture: true });
  if (!/^[a-z0-9][a-z0-9+.-]+$/.test(packageName)) throw new Error(`Unsafe DEB package name: ${packageName}`);
  if (packagePresent(packageName)) throw new Error(`Refusing to replace pre-existing package ${packageName}`);

  const scratch = mkdtempSync(join(tmpdir(), 'empir3-linux-update-'));
  const persistentSmokeRoot = join(scratch, 'persistent-smoke');
  const retainedState = join(persistentSmokeRoot, 'appdata-roaming', '.empir3-bridge', 'update-retention.json');
  const nextVersion = nextPatchVersion(baseVersion);
  const keys = generateKeyPairSync('ed25519');
  const publicKeyHex = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  let installAttempted = false;
  try {
    const nextDeb = await createVersionedDeb(sourceDeb, nextVersion, scratch);
    const updateWorld = makeSignedWorld({
      debPath: nextDeb,
      version: nextVersion,
      rolloutState: 'live',
      privateKey: keys.privateKey,
      publicKeyHex,
    });
    const rollbackWorld = makeSignedWorld({
      debPath: sourceDeb,
      version: baseVersion,
      rolloutState: 'rollback',
      previousVersion: nextVersion,
      privateKey: keys.privateKey,
      publicKeyHex,
    });

    installAttempted = true;
    installDeb(sourceDeb);
    if (packageVersion(packageName) !== baseVersion) throw new Error('Initial DEB version did not install');
    runInstalledSmoke(packageName, baseVersion, persistentSmokeRoot);
    mkdirSync(dirname(retainedState), { recursive: true });
    writeFileSync(retainedState, '{"retained":true}\n');

    const updateDeb = await selectAndDownload(
      updateWorld,
      baseVersion,
      join(scratch, `verified-update-${nextVersion}.deb`),
      'available',
    );
    installDeb(updateDeb);
    if (packageVersion(packageName) !== nextVersion) throw new Error('Signed DEB update did not install');
    runInstalledSmoke(packageName, nextVersion, persistentSmokeRoot);
    if (!existsSync(retainedState)) throw new Error('Signed DEB update lost retained local state');

    const rollbackDeb = await selectAndDownload(
      rollbackWorld,
      nextVersion,
      join(scratch, `verified-rollback-${baseVersion}.deb`),
      'rollback-available',
    );
    installDeb(rollbackDeb, { allowDowngrade: true });
    if (packageVersion(packageName) !== baseVersion) throw new Error('Signed DEB rollback did not install');
    runInstalledSmoke(packageName, baseVersion, persistentSmokeRoot);
    if (!existsSync(retainedState) || JSON.parse(readFileSync(retainedState, 'utf8')).retained !== true) {
      throw new Error('Signed DEB rollback lost retained local state');
    }

    run('sudo', ['dpkg', '--purge', packageName]);
    installAttempted = false;
    console.log(JSON.stringify({
      ok: true,
      packageName,
      arch: process.arch,
      baseVersion,
      updateVersion: nextVersion,
      manifestAuthentication: 'ed25519-manifest-sha256',
      update: true,
      rollback: true,
      launchAfterEachTransition: true,
      retainedState: true,
      purge: true,
    }));
  } finally {
    if (installAttempted || packagePresent(packageName)) {
      try { run('sudo', ['dpkg', '--purge', packageName]); } catch {}
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
