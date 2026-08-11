'use strict';

const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  shell,
} = require('electron');
const {
  createFileLogger,
  createRestartLimiter,
  getLaunchAtLogin,
  isWindowsUninstallEvent,
  logDirectory,
  prepareForUninstall,
  setLaunchAtLogin,
} = require('./lifecycle.cjs');
const {
  checkForDesktopUpdate,
  downloadVerifiedArtifact,
  loadOrCreateUpdateState,
  saveUpdateState,
  writeHealthReceipt,
} = require('./updater.cjs');

const SQUIRREL_EVENT_HANDLED = process.platform === 'win32' && require('electron-squirrel-startup');
const INSTALLER_TEST_FIRST_RUN_HANDLED = process.platform === 'win32'
  && process.env.EMPIR3_INSTALLER_TEST_FIRST_RUN === '1'
  && process.argv.includes('--squirrel-firstrun');
if (SQUIRREL_EVENT_HANDLED) {
  if (isWindowsUninstallEvent()) {
    try { prepareForUninstall({ electronApp: app, executable: process.execPath }); } catch {}
  }
  app.quit();
}
if (INSTALLER_TEST_FIRST_RUN_HANDLED) app.quit();
const {
  externalNavigationCommand,
  fetchJson,
  isAllowedLocalUrl,
  makeRuntimeEnvironment,
  providerConsoleUrl,
  resolveBridgeRoot,
  resolvePorts,
  resolveRuntimeCommand,
  resolveRuntimeEntry,
  statusUrl,
  waitForBridge,
} = require('./runtime.cjs');
const { assertSmokeEnvironmentIsolation } = require('./smoke-isolation.cjs');

const SMOKE_MODE = process.argv.includes('--smoke');
const MCP_MODE = process.argv.includes('--mcp');
const START_HIDDEN = process.argv.includes('--hidden') || process.argv.includes('--daemon');
const SMOKE_PROVIDER_URL = String(process.env.EMPIR3_DESKTOP_SMOKE_PROVIDER_URL || '').replace(/\/+$/, '');
const SMOKE_CLI = String(process.env.EMPIR3_DESKTOP_SMOKE_CLI || '').trim().toLowerCase();
const SMOKE_STATE_ROOT = String(process.env.EMPIR3_DESKTOP_SMOKE_STATE_ROOT || '').trim();
const SMOKE_ISOLATION_ROOT = String(process.env.EMPIR3_DESKTOP_SMOKE_ISOLATION_ROOT || '').trim();

let mainWindow = null;
let tray = null;
let trayConnectionTimer = null;
let managedBridge = null;
let attachedToExistingBridge = false;
let quitting = false;
let bridgeRoot = '';
let ports = null;
let fileLogger = null;
let updateState = null;
let updateStatePath = '';
let updateCheckInProgress = false;
let managedRestartInProgress = false;
const managedRestartLimiter = createRestartLimiter({ maxRestarts: 3, windowMs: 60_000 });

function bridgeAssetPath(...parts) {
  return join(bridgeRoot, 'assets', ...parts);
}

function loadBridgeIcon(filename, size) {
  const iconPath = bridgeAssetPath('icons', filename);
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error(`Bridge icon is missing at ${iconPath}`);
  return size ? image.resize({ width: size, height: size, quality: 'best' }) : image;
}

function logChild(stream, label) {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.log(`[bridge:${label}] ${line}`);
      if (fileLogger) fileLogger.write(`bridge-${label}`, line);
    }
  });
}

function showManagedBridgeFailure(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showErrorBox('Empir3 Bridge stopped', message);
}

async function restartManagedBridgeAfterExit(exitReason) {
  if (quitting || SMOKE_MODE || managedRestartInProgress) return;
  const restart = managedRestartLimiter.tryAcquire();
  if (!restart.allowed) {
    const message = 'The local Bridge engine requested more than three restarts in one minute. It was stopped to avoid a restart loop. Reopen the application to try again.';
    console.error(`[desktop-shell] ${message}`);
    if (fileLogger) fileLogger.write('error', message);
    showManagedBridgeFailure(message);
    return;
  }

  managedRestartInProgress = true;
  const reason = `${exitReason}; restarting managed engine (${restart.count}/3)`;
  console.log(`[desktop-shell] ${reason}`);
  if (fileLogger) fileLogger.write('info', reason);
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    if (quitting) return;
    await startOrAttachBridge();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    if (fileLogger) fileLogger.write('info', 'Managed Bridge restarted successfully');
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    console.error('[desktop-shell] managed Bridge restart failed:', error);
    if (fileLogger) fileLogger.write('error', `Managed Bridge restart failed: ${detail}`);
    showManagedBridgeFailure(`The local Bridge engine could not restart after saving your settings. Reopen the application to try again.\n\n${detail}`);
  } finally {
    managedRestartInProgress = false;
  }
}

async function startOrAttachBridge() {
  try {
    await fetchJson(statusUrl(ports.wrapper), 1000);
    if (SMOKE_MODE) {
      throw new Error(`Packaged smoke refuses to attach to an existing Bridge on :${ports.wrapper}`);
    }
    attachedToExistingBridge = true;
    console.log(`[desktop-shell] attached to existing Bridge on :${ports.wrapper}`);
    if (fileLogger) fileLogger.write('info', `Attached to existing Bridge on :${ports.wrapper}`);
    return;
  } catch {
    attachedToExistingBridge = false;
  }

  const entry = resolveRuntimeEntry(bridgeRoot);
  const runtime = resolveRuntimeCommand({
    isPackaged: app.isPackaged,
    electronExecutable: process.execPath,
  });
  const childEnv = {
    ...makeRuntimeEnvironment({ ports, isPackaged: app.isPackaged, bridgeRoot }),
    ...runtime.extraEnv,
    ...(app.isPackaged ? { EMPIR3_DESKTOP_EXE: process.execPath } : {}),
  };

  managedBridge = spawn(runtime.executable, [entry], {
    cwd: bridgeRoot,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  logChild(managedBridge.stdout, 'out');
  logChild(managedBridge.stderr, 'err');
  const child = managedBridge;
  managedBridge.once('exit', (code, signal) => {
    const expected = quitting || SMOKE_MODE;
    console.log(`[desktop-shell] managed Bridge exited code=${code} signal=${signal || 'none'}`);
    if (fileLogger) fileLogger.write('info', `Managed Bridge exited code=${code} signal=${signal || 'none'}`);
    if (managedBridge === child) managedBridge = null;
    if (expected) return;
    const exitReason = `Managed Bridge exited code=${code == null ? 'none' : code} signal=${signal || 'none'}`;
    void restartManagedBridgeAfterExit(exitReason);
  });
  managedBridge.once('error', (error) => {
    console.error('[desktop-shell] failed to launch Bridge:', error);
    if (fileLogger) fileLogger.write('error', `Failed to launch Bridge: ${error.message || error}`);
  });

  await waitForBridge({ wrapperPort: ports.wrapper, timeoutMs: 60_000 });
  console.log(`[desktop-shell] managed Bridge ready on :${ports.wrapper}`);
  if (fileLogger) fileLogger.write('info', `Managed Bridge ready on :${ports.wrapper}`);
}

function stopManagedBridge() {
  if (!managedBridge || attachedToExistingBridge) return;
  try {
    managedBridge.kill();
  } catch (error) {
    console.warn('[desktop-shell] Bridge stop failed:', error && error.message ? error.message : error);
  }
}

async function stopManagedBridgeAndWait(timeoutMs = 5_000) {
  const child = managedBridge;
  stopManagedBridge();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function selectProviderPane() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(
    "document.querySelector('[data-nav=\"clis\"]')?.click(); true;",
    true,
  ).catch(() => {});
}

async function bridgeRequest(pathname, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${ports.wrapper}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new Error(`${method} ${pathname} failed with HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function openInBridgeBrowser(url) {
  const command = externalNavigationCommand(url);
  if (!command) return;
  try {
    await bridgeRequest('/api/command', {
      method: 'POST',
      body: command,
      timeoutMs: 25_000,
    });
    if (fileLogger) fileLogger.write('info', `Opened external navigation in isolated Bridge browser: ${command.url}`);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (fileLogger) fileLogger.write('error', `Could not open isolated Bridge browser: ${detail}`);
    showManagedBridgeFailure(`The separate Bridge browser could not open this page.\n\n${detail}`);
  }
}

async function showBridgeBrowser() {
  try {
    await bridgeRequest('/api/browser/show', {
      method: 'POST',
      body: {},
      timeoutMs: 25_000,
    });
    if (fileLogger) fileLogger.write('info', 'Opened isolated Bridge browser');
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (fileLogger) fileLogger.write('error', `Could not open isolated Bridge browser: ${detail}`);
    showManagedBridgeFailure(`The separate Bridge browser could not be opened.\n\n${detail}`);
  }
}

async function runDesktopTrayCommand(command, failureMessage) {
  try {
    await bridgeRequest('/api/command', { method: 'POST', body: command, timeoutMs: 130_000 });
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (fileLogger) fileLogger.write('error', `${failureMessage}: ${detail}`);
    showManagedBridgeFailure(`${failureMessage}.\n\n${detail}`);
  }
}

async function reconnectBridge() {
  try {
    await bridgeRequest('/api/shutdown', { method: 'POST', timeoutMs: 5_000 });
    if (fileLogger) fileLogger.write('info', 'Manual Bridge reconnect requested from tray');
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (fileLogger) fileLogger.write('error', `Manual Bridge reconnect failed: ${detail}`);
    showManagedBridgeFailure(`The local Bridge engine could not be restarted.\n\n${detail}`);
  }
}

async function runProviderSmoke() {
  if (!SMOKE_PROVIDER_URL) return null;
  const slug = 'desktop-package-smoke';
  const added = await bridgeRequest('/api/cli/providers', {
    method: 'POST',
    body: {
      slug,
      name: 'Desktop Package Smoke',
      apiBaseUrl: SMOKE_PROVIDER_URL,
      apiKey: 'empir3-package-smoke-key',
      lend: true,
    },
  });
  if (!added.ok || !added.provider?.available || !added.provider.models?.includes('smoke-model')) {
    throw new Error(`Packaged provider discovery failed: ${JSON.stringify(added)}`);
  }
  await bridgeRequest('/api/settings/state', {
    method: 'POST',
    body: { bridge: { globalSafety: { execute: true } } },
    timeoutMs: 90_000,
  });
  const command = await bridgeRequest('/api/command', {
    method: 'POST',
    body: {
      type: 'custom_llm',
      params: { provider: slug, model: 'smoke-model', prompt: 'hello packaged bridge' },
    },
  });
  if (!command.ok || command.result?.success !== true || command.result.text !== 'smoke: hello packaged bridge') {
    throw new Error(`Packaged provider completion failed: ${JSON.stringify(command)}`);
  }
  await bridgeRequest(`/api/cli/providers/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  return {
    provider: slug,
    discoveredModel: 'smoke-model',
    completion: command.result.text,
  };
}

async function assertSmokeIsolation() {
  if (!SMOKE_STATE_ROOT) throw new Error('Packaged smoke state root is required');
  // A cold Windows host can legitimately need more than 15 seconds to probe
  // the installed CLI roster (some CLIs boot a full runtime for --version).
  // The server de-duplicates and caches that work, so wait for the shared
  // initial probe instead of treating a slow runner as a failed package.
  const state = await bridgeRequest('/api/settings/state', { timeoutMs: 90_000 });
  const expected = resolve(SMOKE_STATE_ROOT).toLowerCase();
  const actual = resolve(String(state.paths?.dataDir || '')).toLowerCase();
  if (actual !== expected && !actual.startsWith(`${expected}${sep}`)) {
    throw new Error(`Packaged smoke escaped its isolated settings root: ${actual}`);
  }
  return actual;
}

async function runCliSmoke() {
  if (!SMOKE_CLI) return null;
  if (SMOKE_CLI !== 'codex') throw new Error(`Unsupported packaged CLI smoke model: ${SMOKE_CLI}`);
  await bridgeRequest('/api/settings/state', {
    method: 'POST',
    body: {
      bridge: {
        lendOpenAiCodex: true,
        globalSafety: { execute: true },
      },
    },
    timeoutMs: 90_000,
  });
  const state = await bridgeRequest('/api/settings/state', { timeoutMs: 90_000 });
  if (!state.providers?.codex?.available) {
    throw new Error(`Packaged CLI discovery failed: ${JSON.stringify(state.providers?.codex || null)}`);
  }
  const command = await bridgeRequest('/api/command', {
    method: 'POST',
    body: {
      type: 'cli_run',
      params: {
        model: 'codex',
        prompt: 'hello packaged cli',
        timeoutMs: 15_000,
      },
    },
  });
  const result = command.result?.result;
  if (!command.ok || command.result?.success !== true || result?.text !== 'smoke-cli: hello packaged cli') {
    throw new Error(`Packaged CLI turn failed: ${JSON.stringify(command)}`);
  }
  return {
    model: 'codex',
    status: result.status,
    completion: result.text,
  };
}

async function runScaleSmoke() {
  let started = false;
  let originalSafety = null;
  try {
    const state = await bridgeRequest('/api/settings/state', { timeoutMs: 90_000 });
    originalSafety = state.bridge?.globalSafety || { read: true, write: false, execute: false };
    await bridgeRequest('/api/settings/state', {
      method: 'POST',
      body: {
        bridge: {
          globalSafety: { ...originalSafety, execute: true },
        },
      },
      timeoutMs: 90_000,
    });
    const up = await bridgeRequest('/api/command', {
      method: 'POST',
      body: { type: 'bridge_scale', action: 'up', params: { action: 'up', count: 2 } },
      timeoutMs: 60_000,
    });
    const sibling = up.result?.instances?.find((instance) => instance.index === 2);
    started = sibling?.running === true;
    if (!up.ok || !up.result?.success || !sibling?.running || sibling.via !== 'payload-headless-entry') {
      throw new Error(`Packaged scale-up failed: ${JSON.stringify(up)}`);
    }
    const siblingStatus = await fetchJson(`http://127.0.0.1:${ports.wrapper + 100}/api/status`, 10_000);
    if (siblingStatus?.running !== true || siblingStatus?.engine !== 'empir3-bridge') {
      throw new Error(`Packaged scale sibling is not usable: ${JSON.stringify(siblingStatus)}`);
    }
    return {
      instance: 2,
      bridgeUrl: sibling.bridgeUrl,
      via: sibling.via,
      browserRunning: siblingStatus.running,
    };
  } finally {
    try {
      if (started) {
        const down = await bridgeRequest('/api/command', {
          method: 'POST',
          body: { type: 'bridge_scale', action: 'down', params: { action: 'down', count: 2 } },
          timeoutMs: 30_000,
        });
        const sibling = down.result?.instances?.find((instance) => instance.index === 2);
        if (!down.ok || sibling?.running !== false || sibling?.stopped !== true) {
          throw new Error(`Packaged scale-down failed: ${JSON.stringify(down)}`);
        }
      }
    } finally {
      if (originalSafety) {
        await bridgeRequest('/api/settings/state', {
          method: 'POST',
          body: { bridge: { globalSafety: originalSafety } },
          timeoutMs: 90_000,
        });
      }
    }
  }
}

function showPane(pane) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.executeJavaScript(
    `document.querySelector('[data-nav="${pane}"]')?.click(); true;`,
    true,
  ).catch(() => {});
}

function showProviders() {
  showPane('clis');
}

function showConsole() {
  showPane('overview');
}

function updateTrustKeyHex() {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'payload-signing-pub.json')
    : resolve(__dirname, '..', '..', 'build', 'payload-signing-pub.json');
  const trust = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[0-9a-f]{64}$/i.test(String(trust.publicKeyHex || ''))) {
    throw new Error(`Desktop update trust root is invalid at ${path}`);
  }
  return String(trust.publicKeyHex).toLowerCase();
}

function updateStatusMessage(result) {
  const messages = {
    'up-to-date': `Empir3 Bridge ${app.getVersion()} is current.`,
    held: 'A release exists, but it is currently on hold and will not be installed.',
    'not-selected': 'A staged release exists, but this device is not in the current rollout group.',
    'legacy-manifest': 'The current release channel does not yet advertise desktop app updates.',
    'newer-local-version': 'This installation is newer than the current release channel.',
    'health-blocked': `The ${process.platform}/${process.arch} package has not passed its release health gate.`,
    'unsigned-blocked': 'The available package is not production-signed, so Empir3 Bridge refused it.',
  };
  return messages[result.status] || `No installable update is available (${result.status}).`;
}

async function runDesktopUpdateCheck({ manual = false } = {}) {
  if (updateCheckInProgress || SMOKE_MODE) return;
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Empir3 Bridge updates', message: 'Update checks run from an installed Empir3 Bridge package.',
      buttons: ['OK'], noLink: true,
    }).catch(() => {});
    return;
  }
  updateCheckInProgress = true;
  try {
    const result = await checkForDesktopUpdate({
      manifestUrl: process.env.EMPIR3_DESKTOP_MANIFEST_URL,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      deviceId: updateState.deviceId,
      publicKeyHex: updateTrustKeyHex(),
    });
    updateState.lastCheckedAt = new Date().toISOString();
    updateState.lastResult = result.status;
    saveUpdateState(updateStatePath, updateState);

    if (result.status !== 'available' && result.status !== 'rollback-available') {
      if (manual) await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Empir3 Bridge updates', message: updateStatusMessage(result),
        buttons: ['OK'], noLink: true,
      });
      return;
    }
    if (!manual && updateState.lastPromptedVersion === result.manifest.version) return;
    updateState.lastPromptedVersion = result.manifest.version;
    saveUpdateState(updateStatePath, updateState);
    const rollback = result.status === 'rollback-available';
    const choice = await dialog.showMessageBox(mainWindow, {
      type: rollback ? 'warning' : 'info',
      title: rollback ? 'Empir3 Bridge rollback available' : 'Empir3 Bridge update available',
      message: rollback
        ? `A signed rollback from ${app.getVersion()} to ${result.manifest.version} is ready.`
        : `Empir3 Bridge ${result.manifest.version} is ready.`,
      detail: `The ${result.artifact.format.toUpperCase()} installer will be downloaded, hash-checked, and opened only if it matches the signed release.`,
      buttons: [rollback ? 'Download rollback' : 'Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response !== 0) return;

    const destination = join(app.getPath('temp'), 'empir3-bridge-updates', result.artifact.publicName);
    if (fileLogger) fileLogger.write('info', `Downloading signed desktop release ${result.manifest.version}`);
    const downloaded = await downloadVerifiedArtifact(result.artifact, destination);
    const ready = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Empir3 Bridge installer verified',
      message: `${result.artifact.publicName} passed its signed size and SHA-256 checks.`,
      detail: 'Opening it will close this Bridge after your operating system starts the installer.',
      buttons: ['Open installer', 'Keep for later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (ready.response !== 0) return;
    const openError = await shell.openPath(downloaded.path);
    if (openError) throw new Error(openError);
    quitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    await stopManagedBridgeAndWait();
    app.quit();
  } catch (error) {
    if (fileLogger) fileLogger.write('error', `Desktop update check failed: ${error.stack || error}`);
    if (manual) dialog.showErrorBox('Empir3 Bridge update check failed', error.message || String(error));
  } finally {
    updateCheckInProgress = false;
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Empir3 Bridge — Providers',
    width: 1240,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0b0e',
    icon: loadBridgeIcon(process.platform === 'win32' ? 'bridge.ico' : 'bridge.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedLocalUrl(url, ports.wrapper)) return;
    event.preventDefault();
    void openInBridgeBrowser(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openInBridgeBrowser(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-finish-load', selectProviderPane);
  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN && !SMOKE_MODE) showProviders();
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  await mainWindow.loadURL(providerConsoleUrl(ports.wrapper));
  selectProviderPane();
  return mainWindow.webContents.executeJavaScript(`(() => {
    const providerNav = document.querySelector('[data-nav="clis"]');
    const providerPane = document.querySelector('[data-pane="clis"]');
    return {
      providerNavPresent: Boolean(providerNav),
      providerPanePresent: Boolean(providerPane),
      providerPaneActive: Boolean(providerPane && providerPane.classList.contains('active')),
    };
  })()`, true);
}

function createTray() {
  let icon;
  try {
    icon = loadBridgeIcon('bridge-tray-disconnected.png', 18);
  } catch (error) {
    console.warn(`[desktop-shell] ${error.message}; tray disabled`);
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip('Empir3 Bridge — reconnecting');
  let launchAtLogin = false;
  try { launchAtLogin = getLaunchAtLogin({ electronApp: app }); } catch {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Empir3 Bridge v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Bridge Console', default: true, click: showConsole },
    { label: 'Open Providers', click: showProviders },
    { label: 'Launch Browser', click: () => { void showBridgeBrowser(); } },
    {
      label: 'Settings',
      submenu: [
        { label: 'Account & Sign In', click: () => showPane('account') },
        { label: 'Providers & CLIs', click: showProviders },
        { label: 'Permissions', click: () => showPane('permissions') },
        { label: 'MCP Connection', click: () => showPane('mcp') },
      ],
    },
    process.platform === 'win32' ? {
      label: 'Desktop Tools',
      submenu: [
        {
          label: 'Open Floating Toolbar',
          click: () => { void runDesktopTrayCommand({ type: 'desktop_toolbar', action: 'show' }, 'The desktop toolbar could not be opened'); },
        },
        {
          label: 'Select Agent Region…',
          click: () => { void runDesktopTrayCommand({ type: 'desktop_select_region', timeoutMs: 120_000 }, 'The agent region could not be selected'); },
        },
        {
          label: 'Release Agent Focus',
          click: () => { void runDesktopTrayCommand({ type: 'desktop_release_focus' }, 'Agent focus could not be released'); },
        },
      ],
    } : null,
    { type: 'separator' },
    { label: 'Reconnect Bridge', click: () => { void reconnectBridge(); } },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: launchAtLogin,
      click: (item) => {
        try {
          const result = setLaunchAtLogin(item.checked, { electronApp: app, executable: process.execPath });
          if (fileLogger) fileLogger.write('info', `Launch at login ${result.enabled ? 'enabled' : 'disabled'}`);
        } catch (error) {
          item.checked = !item.checked;
          if (fileLogger) fileLogger.write('error', `Launch-at-login change failed: ${error.message || error}`);
          dialog.showErrorBox('Startup setting could not be changed', error.message || String(error));
        }
      },
    },
    {
      label: 'Open Logs Folder',
      click: async () => {
        if (!fileLogger) return;
        const error = await shell.openPath(fileLogger.directory);
        if (error) dialog.showErrorBox('Logs folder could not be opened', error);
      },
    },
    {
      label: 'Check for Updates…',
      click: () => runDesktopUpdateCheck({ manual: true }),
    },
    {
      label: 'Prepare for Uninstall…',
      click: async () => {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Prepare Empir3 Bridge for uninstall',
          message: 'Stop Empir3 Bridge and remove its startup registration?',
          detail: 'Your local provider definitions, API keys, model endpoints, and logs will be kept so reinstalling restores them.',
          buttons: ['Prepare and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (choice.response !== 0) return;
        try {
          const result = prepareForUninstall({ electronApp: app, executable: process.execPath });
          if (fileLogger) fileLogger.write('info', `Prepared for uninstall; data retention=${result.dataRetention}`);
          quitting = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
          await stopManagedBridgeAndWait();
          app.exit(0);
        } catch (error) {
          if (fileLogger) fileLogger.write('error', `Uninstall preparation failed: ${error.message || error}`);
          dialog.showErrorBox('Could not prepare for uninstall', error.message || String(error));
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Empir3 Bridge',
      click: () => {
        quitting = true;
        stopManagedBridge();
        app.quit();
      },
    },
  ].filter(Boolean)));
  tray.on('click', showConsole);

  const refreshTrayConnection = async () => {
    if (!tray || tray.isDestroyed()) return;
    let connected = false;
    try {
      const status = await fetchJson(`http://127.0.0.1:${ports.wrapper}/api/relay-status`, 2500);
      connected = status?.relay?.connected === true;
    } catch {}
    try {
      tray.setImage(loadBridgeIcon(
        connected ? 'bridge-tray-connected.png' : 'bridge-tray-disconnected.png',
        18,
      ));
      tray.setToolTip(connected ? 'Empir3 Bridge — connected' : 'Empir3 Bridge — disconnected');
    } catch (error) {
      if (fileLogger) fileLogger.write('error', `Tray status icon failed: ${error.message || error}`);
    }
  };
  void refreshTrayConnection();
  trayConnectionTimer = setInterval(refreshTrayConnection, 5_000);
}

function runMcpMode() {
  const runtimeRoot = resolveBridgeRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    shellSourceDir: __dirname,
  });
  const mcpEntry = join(runtimeRoot, 'dist', 'bundle-mcp-server.js');
  if (!existsSync(mcpEntry)) {
    process.stderr.write(`[Empir3 MCP] packaged MCP runtime is missing at ${mcpEntry}\n`);
    process.exitCode = 1;
    return;
  }
  const mcpEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    EMPIR3_BRIDGE_PAYLOAD_DIR: runtimeRoot,
    EMPIR3_BRIDGE_PAYLOAD_VERSION: app.getVersion(),
    ...(app.isPackaged ? { EMPIR3_DESKTOP_EXE: process.execPath } : {}),
  };
  // A packaged Windows Electron binary uses the GUI subsystem, so running the
  // MCP module inside this browser process does not provide reliable stdout.
  // Re-exec the same signed binary in Electron's Node mode and inherit the
  // exact stdio handles the MCP client gave us.
  const mcpArgs = [mcpEntry];
  // Preserve an explicit Linux sandbox override across the Electron -> Node
  // MCP handoff. Production launches do not include this flag.
  if (process.platform === 'linux' && process.argv.includes('--no-sandbox')) mcpArgs.push('--no-sandbox');
  const child = spawn(process.execPath, mcpArgs, {
    cwd: runtimeRoot,
    env: mcpEnv,
    windowsHide: true,
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    process.stderr.write(`[Empir3 MCP] could not start packaged MCP runtime: ${error.message || error}\n`);
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch { process.exit(1); }
      return;
    }
    process.exit(code == null ? 0 : code);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { try { child.kill(signal); } catch {} });
  }
}

async function run() {
  fileLogger = createFileLogger({ directory: logDirectory(app) });
  fileLogger.write('info', `Empir3 Bridge desktop starting (${process.platform}/${process.arch}, packaged=${app.isPackaged})`);
  ports = resolvePorts({ isPackaged: app.isPackaged });
  bridgeRoot = resolveBridgeRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    shellSourceDir: __dirname,
  });
  if (SMOKE_MODE) {
    assertSmokeEnvironmentIsolation({
      isolationRoot: SMOKE_ISOLATION_ROOT,
      stateRoot: SMOKE_STATE_ROOT,
      userData: app.getPath('userData'),
      env: process.env,
    });
  }
  await startOrAttachBridge();
  const updateTrustRootReady = Boolean(updateTrustKeyHex());
  updateStatePath = join(app.getPath('userData'), 'update-state.json');
  updateState = loadOrCreateUpdateState(updateStatePath);
  writeHealthReceipt(join(app.getPath('userData'), 'update-health.json'), {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    bridgeHealthy: true,
  });

  if (SMOKE_MODE) {
    const status = await fetchJson(statusUrl(ports.wrapper));
    const ui = await createWindow();
    if (!ui.providerNavPresent || !ui.providerPanePresent || !ui.providerPaneActive) {
      throw new Error(`Provider console did not become active: ${JSON.stringify(ui)}`);
    }
    if (!attachedToExistingBridge && status.running === true) {
      throw new Error('Provider-only startup unexpectedly launched automation Chrome');
    }
    const isolatedStateRoot = await assertSmokeIsolation();
    const providerIntegration = await runProviderSmoke();
    const cliIntegration = await runCliSmoke();
    const scaleIntegration = await runScaleSmoke();
    console.log(JSON.stringify({
      ok: true,
      daemonHealthy: true,
      attachedToExistingBridge,
      managedBridge: !attachedToExistingBridge,
      wrapperPort: ports.wrapper,
      version: app.getVersion(),
      chromeAutolaunch: false,
      browserRunning: status.running === true,
      providerPaneActive: ui.providerPaneActive,
      isolatedStateRoot,
      providerIntegration,
      cliIntegration,
      scaleIntegration,
      updateTrustRootReady,
    }));
    quitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    await stopManagedBridgeAndWait();
    app.exit(0);
    return;
  }

  await createWindow();
  createTray();
  setTimeout(() => runDesktopUpdateCheck({ manual: false }), 15_000);
}

if (MCP_MODE && !SQUIRREL_EVENT_HANDLED && !INSTALLER_TEST_FIRST_RUN_HANDLED) {
  runMcpMode();
} else if (!SQUIRREL_EVENT_HANDLED && !INSTALLER_TEST_FIRST_RUN_HANDLED) {
  if (process.env.EMPIR3_DESKTOP_USER_DATA) {
    app.setPath('userData', process.env.EMPIR3_DESKTOP_USER_DATA);
  }

  if (process.platform === 'win32') app.setAppUserModelId('com.empir3.bridge');

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', showProviders);
    app.on('before-quit', () => {
      quitting = true;
      if (trayConnectionTimer) clearInterval(trayConnectionTimer);
      if (fileLogger) fileLogger.write('info', 'Empir3 Bridge desktop quitting');
      stopManagedBridge();
    });
    app.on('activate', showProviders);
    app.on('window-all-closed', () => {
      // The tray owns the desktop lifecycle on every supported OS.
    });
    app.whenReady().then(run).catch((error) => {
      console.error('[desktop-shell] startup failed:', error);
      if (fileLogger) fileLogger.write('error', `Startup failed: ${error.stack || error}`);
      if (!SMOKE_MODE) {
        dialog.showErrorBox('Empir3 Bridge could not start', error && error.message ? error.message : String(error));
      }
      quitting = true;
      stopManagedBridge();
      app.exit(1);
    });
  }
}
