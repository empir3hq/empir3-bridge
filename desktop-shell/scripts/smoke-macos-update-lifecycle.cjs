'use strict';

const { createHash, generateKeyPairSync } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildReleaseManifestV3 } = require('../../build/release-manifest-v3.js');
const { signManifest } = require('../../build/manifest-canonical.js');
const {
  checkForDesktopUpdate,
  downloadVerifiedArtifact,
} = require('../src/updater.cjs');

if (process.platform !== 'darwin') throw new Error('macOS update lifecycle smoke requires a native Mac');
if (process.env.CI !== 'true' && process.env.EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST !== '1') {
  throw new Error('macOS update lifecycle smoke is restricted to CI unless EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST=1 is explicitly set');
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function oneDmg(root, label) {
  const matches = walk(root).filter((file) => file.toLowerCase().endsWith('.dmg'));
  if (matches.length !== 1) throw new Error(`Expected one ${label} DMG, found ${matches.length}`);
  return matches[0];
}

function verifyDmg(dmg) {
  run('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
  run('xcrun', ['stapler', 'validate', '-v', dmg]);
}

function mountedApp(mountPoint) {
  const apps = readdirSync(mountPoint)
    .filter((name) => name.endsWith('.app'))
    .map((name) => join(mountPoint, name));
  if (apps.length !== 1) throw new Error(`Expected one app in mounted DMG, found ${apps.length}`);
  return apps[0];
}

function appVersion(appPath) {
  return run('plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
    join(appPath, 'Contents', 'Info.plist'),
  ], { capture: true });
}

function installFromDmg(dmg, destination, scratch, label) {
  verifyDmg(dmg);
  const mountPoint = join(scratch, `mount-${label}`);
  mkdirSync(mountPoint, { recursive: true });
  run('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mountPoint]);
  try {
    const source = mountedApp(mountPoint);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', source]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', source]);
    run('xcrun', ['stapler', 'validate', '-v', source]);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    run('ditto', [source, destination]);
  } finally {
    run('hdiutil', ['detach', mountPoint]);
    rmSync(mountPoint, { recursive: true, force: true });
  }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', destination]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', destination]);
  run('xcrun', ['stapler', 'validate', '-v', destination]);
  return appVersion(destination);
}

function runInstalledSmoke(appPath, version, persistentSmokeRoot) {
  const executable = join(appPath, 'Contents', 'MacOS', 'empir3-bridge');
  if (!existsSync(executable)) throw new Error(`Installed app executable is missing: ${executable}`);
  run(process.execPath, [smokeScript], {
    env: {
      ...process.env,
      EMPIR3_DESKTOP_SMOKE_EXECUTABLE: executable,
      EMPIR3_DESKTOP_ARCH: 'universal',
      EMPIR3_DESKTOP_SMOKE_EXPECTED_VERSION: version,
      EMPIR3_DESKTOP_SMOKE_ROOT: persistentSmokeRoot,
    },
  });
}

function makeSignedWorld({ dmgPath, version, rolloutState, previousVersion = '', privateKey, publicKeyHex }) {
  const bytes = readFileSync(dmgPath);
  const artifactName = `empir3-bridge-macos-universal-${version}.dmg`;
  const artifactUrl = `https://native-update.empir3.test/${artifactName}`;
  const indexUrl = `https://native-update.empir3.test/index-${version}-${rolloutState}.json`;
  const manifestUrl = `https://native-update.empir3.test/manifest-${version}-${rolloutState}.json`;
  const artifact = {
    id: 'desktop-darwin-universal-installer-dmg',
    target: 'desktop-darwin-universal',
    platform: 'darwin',
    arch: 'universal',
    kind: 'installer',
    format: 'dmg',
    sourceName: basename(dmgPath),
    sourcePath: dmgPath,
    publicName: artifactName,
    url: artifactUrl,
    bytes: bytes.length,
    sha256: sha256(bytes),
    signed: true,
    authenticationScheme: 'apple-developer-id-notarized-stapled',
  };
  const index = {
    schemaVersion: 1,
    version,
    rollout: {
      channel: 'production',
      state: rolloutState,
      percent: 100,
      seed: `native-macos-${version}-${rolloutState}`,
      previousVersion,
    },
    health: { 'desktop-darwin-universal': 'release-approved' },
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
  return { fetcher, manifestUrl, publicKeyHex };
}

async function selectAndDownload(world, currentVersion, destination, expectedStatus) {
  const result = await checkForDesktopUpdate({
    manifestUrl: world.manifestUrl,
    currentVersion,
    platform: 'darwin',
    arch: process.arch,
    deviceId: 'native-macos-acceptance',
    publicKeyHex: world.publicKeyHex,
    fetcher: world.fetcher,
  });
  if (result.status !== expectedStatus) {
    throw new Error(`Expected signed update status ${expectedStatus}, got ${result.status}`);
  }
  const downloaded = await downloadVerifiedArtifact(result.artifact, destination, { fetcher: world.fetcher });
  if (downloaded.reused) throw new Error('Fresh signed DMG download was unexpectedly reused');
  return downloaded.path;
}

async function main() {
  const baseRoot = resolve(String(process.env.EMPIR3_MAC_UPDATE_BASE_ROOT || ''));
  const nextRoot = resolve(String(process.env.EMPIR3_MAC_UPDATE_NEXT_ROOT || ''));
  if (!process.env.EMPIR3_MAC_UPDATE_BASE_ROOT || !process.env.EMPIR3_MAC_UPDATE_NEXT_ROOT) {
    throw new Error('EMPIR3_MAC_UPDATE_BASE_ROOT and EMPIR3_MAC_UPDATE_NEXT_ROOT are required');
  }
  const baseDmg = oneDmg(baseRoot, 'base');
  const nextDmg = oneDmg(nextRoot, 'next');
  const scratch = mkdtempSync(join(tmpdir(), 'empir3-macos-update-'));
  const appPath = join(scratch, 'Applications', 'Empir3 Bridge.app');
  const persistentSmokeRoot = join(scratch, 'persistent-smoke');
  const retainedState = join(persistentSmokeRoot, '.empir3-bridge', 'update-retention.json');
  const keys = generateKeyPairSync('ed25519');
  const publicKeyHex = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  try {
    const baseVersion = installFromDmg(baseDmg, appPath, scratch, 'base');
    const nextVersion = (() => {
      const mountPoint = join(scratch, 'mount-version-probe');
      mkdirSync(mountPoint, { recursive: true });
      run('hdiutil', ['attach', nextDmg, '-readonly', '-nobrowse', '-mountpoint', mountPoint]);
      try { return appVersion(mountedApp(mountPoint)); }
      finally {
        run('hdiutil', ['detach', mountPoint]);
        rmSync(mountPoint, { recursive: true, force: true });
      }
    })();
    const expectedNext = (() => {
      const match = baseVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!match) throw new Error(`Base DMG has non-release version ${baseVersion}`);
      return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
    })();
    if (nextVersion !== expectedNext) throw new Error(`Next DMG version ${nextVersion} is not ${expectedNext}`);

    runInstalledSmoke(appPath, baseVersion, persistentSmokeRoot);
    mkdirSync(dirname(retainedState), { recursive: true });
    writeFileSync(retainedState, '{"retained":true}\n');

    const updateWorld = makeSignedWorld({
      dmgPath: nextDmg,
      version: nextVersion,
      rolloutState: 'live',
      privateKey: keys.privateKey,
      publicKeyHex,
    });
    const updateDmg = await selectAndDownload(
      updateWorld,
      baseVersion,
      join(scratch, `verified-update-${nextVersion}.dmg`),
      'available',
    );
    if (installFromDmg(updateDmg, appPath, scratch, 'update') !== nextVersion) {
      throw new Error('Signed macOS update installed the wrong version');
    }
    runInstalledSmoke(appPath, nextVersion, persistentSmokeRoot);
    if (!existsSync(retainedState)) throw new Error('Signed macOS update lost retained local state');

    const rollbackWorld = makeSignedWorld({
      dmgPath: baseDmg,
      version: baseVersion,
      rolloutState: 'rollback',
      previousVersion: nextVersion,
      privateKey: keys.privateKey,
      publicKeyHex,
    });
    const rollbackDmg = await selectAndDownload(
      rollbackWorld,
      nextVersion,
      join(scratch, `verified-rollback-${baseVersion}.dmg`),
      'rollback-available',
    );
    if (installFromDmg(rollbackDmg, appPath, scratch, 'rollback') !== baseVersion) {
      throw new Error('Signed macOS rollback installed the wrong version');
    }
    runInstalledSmoke(appPath, baseVersion, persistentSmokeRoot);
    if (!existsSync(retainedState) || JSON.parse(readFileSync(retainedState, 'utf8')).retained !== true) {
      throw new Error('Signed macOS rollback lost retained local state');
    }
    console.log(JSON.stringify({
      ok: true,
      arch: process.arch,
      baseVersion,
      updateVersion: nextVersion,
      platformAuthentication: 'apple-developer-id-notarized-stapled',
      manifestAuthentication: 'ed25519',
      update: true,
      rollback: true,
      launchAfterEachTransition: true,
      retainedState: true,
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
