'use strict';

const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('macOS installer smoke requires a native macOS host');
if (process.env.CI !== 'true' && process.env.EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST !== '1') {
  throw new Error('macOS installer smoke is restricted to CI unless EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST=1 is explicitly set');
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

function run(command, args, { env = process.env, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: shellRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args.join(' ')} failed (${result.status})`);
}

function findApp(root) {
  const apps = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(root, entry.name));
  if (apps.length !== 1) throw new Error(`Expected one app bundle in mounted DMG, found ${apps.length}`);
  return apps[0];
}

function runInstalledSmoke(appPath) {
  const executable = join(appPath, 'Contents', 'MacOS', 'empir3-bridge');
  if (!existsSync(executable)) throw new Error(`Installed app executable is missing: ${executable}`);
  run(process.execPath, [smokeScript], {
    env: {
      ...process.env,
      EMPIR3_DESKTOP_SMOKE_EXECUTABLE: executable,
      EMPIR3_DESKTOP_ARCH: 'universal',
    },
  });
}

function main() {
  const dmgs = walk(join(shellRoot, 'out', 'make')).filter((file) => file.endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error(`Expected one DMG installer, found ${dmgs.length}`);
  const scratch = mkdtempSync(join(tmpdir(), 'empir3-macos-installer-'));
  const mountPoint = join(scratch, 'mount');
  const applications = join(scratch, 'Applications');
  const installedApp = join(applications, 'Empir3 Bridge.app');
  const retainedState = join(scratch, 'home', '.empir3-bridge', 'installer-retention.json');
  mkdirSync(mountPoint, { recursive: true });
  mkdirSync(applications, { recursive: true });
  let mounted = false;
  try {
    run('hdiutil', ['attach', dmgs[0], '-nobrowse', '-readonly', '-mountpoint', mountPoint]);
    mounted = true;
    const sourceApp = findApp(mountPoint);
    run('ditto', [sourceApp, installedApp]);
    runInstalledSmoke(installedApp);
    mkdirSync(join(scratch, 'home', '.empir3-bridge'), { recursive: true });
    writeFileSync(retainedState, '{"retained":true}\n');

    rmSync(installedApp, { recursive: true, force: true });
    if (!existsSync(retainedState)) throw new Error('App removal deleted retained user state');
    run('ditto', [sourceApp, installedApp]);
    runInstalledSmoke(installedApp);
    rmSync(installedApp, { recursive: true, force: true });
    if (existsSync(installedApp)) throw new Error('Final app removal left the installed bundle behind');

    console.log(JSON.stringify({
      ok: true,
      installer: basename(dmgs[0]),
      arch: 'universal',
      mount: true,
      install: true,
      launch: true,
      uninstallRetainedState: true,
      reinstall: true,
      finalUninstall: true,
    }));
  } finally {
    if (mounted) {
      try { run('hdiutil', ['detach', mountPoint]); } catch {}
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
