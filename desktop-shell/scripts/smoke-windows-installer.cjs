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
const { basename, dirname, join, resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('Windows installer smoke requires a native Windows host');
const shellRoot = resolve(__dirname, '..');

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

function run(command, args, { env, timeout = 120_000, cwd = shellRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function stopProcessesUnderRoot(installRoot, env) {
  const script = [
    '$root=[IO.Path]::GetFullPath($env:EMPIR3_INSTALL_TEST_ROOT).TrimEnd([char]92,[char]47)',
    '$prefix=$root+[IO.Path]::DirectorySeparatorChar',
    'Get-CimInstance Win32_Process | Where-Object { if (-not $_.ExecutablePath) { return $false }; try { [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) } catch { $false } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, EMPIR3_INSTALL_TEST_ROOT: installRoot },
    timeout: 30_000,
  });
}

function removeDeadInstallRoot(installRoot, env) {
  if (!existsSync(join(installRoot, '.dead'))) {
    throw new Error(`Squirrel did not mark the test install dead: ${installRoot}`);
  }
  // Squirrel may briefly leave an updater child alive after --uninstall exits.
  // Stop only processes whose executable is inside this known test install.
  stopProcessesUnderRoot(installRoot, env);
  rmSync(installRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  if (existsSync(installRoot)) throw new Error(`Dead Squirrel test root remained: ${installRoot}`);
}

function stopExactExecutable(executable, env) {
  const script = [
    '$target=[IO.Path]::GetFullPath($env:EMPIR3_INSTALL_TEST_EXE)',
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join('; ');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, EMPIR3_INSTALL_TEST_EXE: executable },
    timeout: 30_000,
  });
}

function waitForFile(find, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = find();
    if (found) return found;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 250'], {
      windowsHide: true,
    });
  }
  return '';
}

function runSmoke(executable, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['--smoke'], {
      cwd: shellRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Installed app smoke timed out after 90 seconds'));
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal || code !== 0) {
        reject(new Error(`Installed app smoke failed (${signal || code}): ${stderr || stdout}`));
        return;
      }
      const receiptLine = stdout.split(/\r?\n/).find((line) => line.startsWith('{"ok":true'));
      if (!receiptLine) {
        reject(new Error(`Installed app smoke produced no receipt: ${stderr || stdout}`));
        return;
      }
      resolvePromise(JSON.parse(receiptLine));
    });
  });
}

async function main() {
  if (process.env.CI !== 'true' && process.env.EMPIR3_INSTALLER_TEST_ALLOW_REAL_PROFILE !== '1') {
    throw new Error('Installer lifecycle smoke uses the native Squirrel per-user profile and is restricted to an ephemeral CI runner unless EMPIR3_INSTALLER_TEST_ALLOW_REAL_PROFILE=1 is explicitly set');
  }
  const setups = walk(join(shellRoot, 'out', 'make')).filter((file) => / Setup\.exe$/i.test(file));
  if (setups.length !== 1) throw new Error(`Expected one Squirrel Setup.exe, found ${setups.length}`);
  const scratch = mkdtempSync(join(tmpdir(), 'empir3-windows-installer-'));
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is required for the native Squirrel install test');
  const installRoot = join(localAppData, 'empir3_bridge');
  if (existsSync(installRoot)) throw new Error(`Refusing to overwrite an existing Squirrel install: ${installRoot}`);
  const roamingAppData = join(scratch, 'roaming');
  const home = join(scratch, 'home');
  const temp = join(scratch, 'temp');
  for (const path of [roamingAppData, home, temp]) mkdirSync(path, { recursive: true });
  const stateSentinel = join(roamingAppData, 'empir3-installer-retention-sentinel.json');
  const ports = 45000 + (process.pid % 1000);
  const env = {
    ...process.env,
    // The app state remains isolated below, while scaled Chrome siblings use
    // the runner's real Windows profile so remote debugging is available.
    EMPIR3_SCALE_HOST_HOME: process.env.HOME || '',
    EMPIR3_SCALE_HOST_USERPROFILE: process.env.USERPROFILE || '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: roamingAppData,
    LOCALAPPDATA: join(scratch, 'local'),
    TEMP: temp,
    TMP: temp,
    EMPIR3_DESKTOP_USER_DATA: join(roamingAppData, 'electron-user-data'),
    EMPIR3_BRIDGE_PROFILE: join(roamingAppData, 'chrome-profile'),
    EMPIR3_BRIDGE_NO_RELAY: '1',
    EMPIR3_CHROME_AUTOLAUNCH: '0',
    EMPIR3_PW_PORT: String(ports),
    EMPIR3_BRIDGE_HTTP_PORT: String(ports + 1),
    EMPIR3_CDP_PORT: String(ports + 2),
    EMPIR3_DESKTOP_SMOKE_STATE_ROOT: roamingAppData,
    EMPIR3_DESKTOP_SMOKE_ISOLATION_ROOT: scratch,
  };
  // Squirrel resolves Windows known folders before the Electron app starts.
  // Keep its native profile environment intact; redirecting USERPROFILE makes
  // older Squirrel builds fall back to the current drive root. The explicit
  // flag prevents the automatically launched first-run app from touching the
  // real profile. The separately launched smoke below still uses `env` and is
  // fully isolated.
  const installerEnv = {
    ...process.env,
    EMPIR3_INSTALLER_TEST_FIRST_RUN: '1',
  };
  let installedExe = '';
  let updateExe = '';
  try {
    run(setups[0], [], { env: installerEnv, cwd: dirname(setups[0]) });
    installedExe = waitForFile(() => walk(installRoot).find((file) => basename(file).toLowerCase() === 'empir3-bridge.exe'));
    if (!installedExe) throw new Error('Squirrel did not install Empir3 Bridge under its expected per-user root');
    updateExe = walk(installRoot).find((file) => basename(file).toLowerCase() === 'update.exe');
    if (!updateExe) throw new Error('Installed Squirrel Update.exe was not found');
    stopExactExecutable(installedExe, env);
    const firstSmoke = await runSmoke(installedExe, env);
    if (!firstSmoke.daemonHealthy || !firstSmoke.providerPaneActive || firstSmoke.browserRunning) {
      throw new Error(`Installed app receipt is incomplete: ${JSON.stringify(firstSmoke)}`);
    }
    writeFileSync(stateSentinel, '{"retained":true}\n');
    stopExactExecutable(installedExe, env);
    run(updateExe, ['--uninstall', '-s'], { env: installerEnv, cwd: dirname(updateExe) });
    stopExactExecutable(installedExe, env);
    if (!waitForFile(() => existsSync(join(installRoot, '.dead')) && join(installRoot, '.dead'), 30_000)) {
      throw new Error('Squirrel uninstall did not mark the installation dead');
    }
    if (!existsSync(stateSentinel)) throw new Error('Squirrel uninstall deleted retained provider-state sentinel');
    removeDeadInstallRoot(installRoot, env);

    run(setups[0], [], { env: installerEnv, cwd: dirname(setups[0]) });
    installedExe = waitForFile(() => walk(installRoot).find((file) => basename(file).toLowerCase() === 'empir3-bridge.exe'));
    if (!installedExe) throw new Error('Squirrel reinstall did not restore the app executable');
    stopExactExecutable(installedExe, env);
    const secondSmoke = await runSmoke(installedExe, env);
    if (secondSmoke.version !== firstSmoke.version) throw new Error('Reinstalled app version changed unexpectedly');
    updateExe = walk(installRoot).find((file) => basename(file).toLowerCase() === 'update.exe');
    stopExactExecutable(installedExe, env);
    run(updateExe, ['--uninstall', '-s'], { env: installerEnv, cwd: dirname(updateExe) });
    stopExactExecutable(installedExe, env);
    if (!waitForFile(() => existsSync(join(installRoot, '.dead')) && join(installRoot, '.dead'), 30_000)) {
      throw new Error('Final Squirrel uninstall did not mark the installation dead');
    }
    removeDeadInstallRoot(installRoot, env);
    console.log(JSON.stringify({
      ok: true,
      version: secondSmoke.version,
      installer: basename(setups[0]),
      nativePerUserInstallRoot: true,
      isolatedApplicationState: true,
      install: true,
      launch: true,
      uninstallRetainedState: true,
      reinstall: true,
      finalUninstall: !existsSync(installRoot),
    }));
  } finally {
    if (installedExe) {
      try { stopExactExecutable(installedExe, env); } catch {}
    }
    if (updateExe && existsSync(updateExe)) {
      try { run(updateExe, ['--uninstall', '-s'], { env: installerEnv, timeout: 60_000, cwd: dirname(updateExe) }); } catch {}
    }
    if (existsSync(join(installRoot, '.dead'))) {
      try { removeDeadInstallRoot(installRoot, env); } catch {}
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
