'use strict';

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
const { basename, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'linux') throw new Error('Linux installer smoke requires a native Linux host');
if (process.env.CI !== 'true' && process.env.EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST !== '1') {
  throw new Error('Linux installer smoke changes the native package database and is restricted to CI unless EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST=1 is explicitly set');
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

function run(command, args, { capture = false, env = process.env, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: shellRoot,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout,
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

function installDeb(debPath) {
  // apt-get is the normal non-interactive Ubuntu installer path for a local
  // DEB. Unlike `dpkg -i`, it resolves the Electron runtime dependencies that
  // a clean workstation may not have yet (for example libnotify4).
  run('sudo', ['apt-get', 'install', '-y', debPath]);
}

function installedExecutable(packageName) {
  const paths = run('dpkg', ['-L', packageName], { capture: true }).split(/\r?\n/)
    .filter((path) => basename(path) === 'empir3-bridge' && existsSync(path));
  const executable = paths.find((path) => statSync(path).isFile()) || paths[0];
  if (!executable) throw new Error(`Installed package ${packageName} exposed no empir3-bridge executable`);
  return executable;
}

function runInstalledSmoke(executable) {
  run(process.execPath, [smokeScript], {
    env: {
      ...process.env,
      EMPIR3_DESKTOP_SMOKE_EXECUTABLE: executable,
      EMPIR3_DESKTOP_ARCH: process.arch,
    },
  });
}

function main() {
  const debs = walk(join(shellRoot, 'out', 'make')).filter((file) => file.endsWith('.deb'));
  if (debs.length !== 1) throw new Error(`Expected one DEB installer, found ${debs.length}`);
  const packageName = run('dpkg-deb', ['-f', debs[0], 'Package'], { capture: true });
  if (!/^[a-z0-9][a-z0-9+.-]+$/.test(packageName)) throw new Error(`Unsafe DEB package name: ${packageName}`);
  if (packagePresent(packageName)) throw new Error(`Refusing to replace pre-existing package ${packageName}`);

  const scratch = mkdtempSync(join(tmpdir(), 'empir3-linux-installer-'));
  const retainedState = join(scratch, 'home', '.empir3-bridge', 'installer-retention.json');
  let installAttempted = false;
  try {
    installAttempted = true;
    installDeb(debs[0]);
    let executable = installedExecutable(packageName);
    runInstalledSmoke(executable);
    mkdirSync(join(scratch, 'home', '.empir3-bridge'), { recursive: true });
    writeFileSync(retainedState, '{"retained":true}\n');

    run('sudo', ['dpkg', '-r', packageName]);
    if (existsSync(executable)) throw new Error('DEB removal left the installed executable behind');
    if (!existsSync(retainedState)) throw new Error('DEB removal deleted retained user state');

    installDeb(debs[0]);
    executable = installedExecutable(packageName);
    runInstalledSmoke(executable);
    run('sudo', ['dpkg', '--purge', packageName]);
    installAttempted = false;
    if (existsSync(executable)) throw new Error('DEB purge left the installed executable behind');
    if (!existsSync(retainedState) || JSON.parse(readFileSync(retainedState, 'utf8')).retained !== true) {
      throw new Error('DEB lifecycle did not retain explicit user-owned state');
    }
    console.log(JSON.stringify({
      ok: true,
      installer: basename(debs[0]),
      packageName,
      arch: process.arch,
      install: true,
      launch: true,
      uninstallRetainedState: true,
      reinstall: true,
      purge: true,
    }));
  } finally {
    if (installAttempted || packagePresent(packageName)) {
      try { run('sudo', ['dpkg', '--purge', packageName]); } catch {}
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
