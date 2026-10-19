'use strict';

const {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

const LINUX_AUTOSTART_FILE = 'empir3-bridge.desktop';
const LOG_FILE = 'bridge-desktop.log';

function createRestartLimiter({ maxRestarts = 3, windowMs = 60_000, now = Date.now } = {}) {
  if (!Number.isInteger(maxRestarts) || maxRestarts < 1) throw new Error('maxRestarts must be a positive integer');
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error('windowMs must be positive');
  let restarts = [];

  return {
    tryAcquire() {
      const timestamp = Number(now());
      restarts = restarts.filter((value) => timestamp - value < windowMs);
      if (restarts.length >= maxRestarts) {
        return {
          allowed: false,
          count: restarts.length,
          retryAfterMs: Math.max(1, windowMs - (timestamp - restarts[0])),
        };
      }
      restarts.push(timestamp);
      return { allowed: true, count: restarts.length, retryAfterMs: 0 };
    },
  };
}

function linuxAutostartPath({ env = process.env, home = homedir() } = {}) {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'autostart', LINUX_AUTOSTART_FILE);
}

function quoteDesktopExecArg(value) {
  return `"${String(value).replace(/([\\"`$])/g, '\\$1')}"`;
}

function linuxAutostartContents(executable) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Empir3 Bridge',
    'Comment=Start the local Empir3 provider and CLI bridge',
    `Exec=${quoteDesktopExecArg(executable)} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-Empir3-Managed=true',
    '',
  ].join('\n');
}

function getLaunchAtLogin({ platform = process.platform, electronApp, env, home } = {}) {
  if (platform === 'linux') {
    const path = linuxAutostartPath({ env, home });
    if (!existsSync(path)) return false;
    try {
      return readFileSync(path, 'utf8').includes('X-Empir3-Managed=true');
    } catch {
      return false;
    }
  }
  if (!electronApp || typeof electronApp.getLoginItemSettings !== 'function') return false;
  return electronApp.getLoginItemSettings().openAtLogin === true;
}

function setLaunchAtLogin(enabled, {
  platform = process.platform,
  electronApp,
  executable = process.execPath,
  env,
  home,
} = {}) {
  if (platform === 'linux') {
    const path = linuxAutostartPath({ env, home });
    const exists = existsSync(path);
    const managed = exists && (() => {
      try { return readFileSync(path, 'utf8').includes('X-Empir3-Managed=true'); }
      catch { return false; }
    })();
    if (!enabled) {
      if (managed) unlinkSync(path);
      return { enabled: false, path };
    }
    if (exists && !managed) {
      throw new Error(`Refusing to replace an unmanaged autostart entry at ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, linuxAutostartContents(executable), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch {}
    return { enabled: true, path };
  }
  if (!electronApp || typeof electronApp.setLoginItemSettings !== 'function') {
    throw new Error(`Launch at login is not supported on ${platform}`);
  }
  electronApp.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    ...(platform === 'win32' ? { path: executable, args: ['--hidden'] } : {}),
  });
  return { enabled: Boolean(enabled), path: executable };
}

function isWindowsUninstallEvent(argv = process.argv) {
  return argv.some((arg) => String(arg).toLowerCase() === '--squirrel-uninstall');
}

function prepareForUninstall(options = {}) {
  const startup = setLaunchAtLogin(false, options);
  return {
    startupRemoved: startup.enabled === false,
    dataRetention: 'keep',
    message: 'Local provider definitions, API keys, model endpoints, and logs are retained unless the user explicitly resets them.',
  };
}

function logDirectory(electronApp) {
  return join(electronApp.getPath('userData'), 'logs');
}

function createFileLogger({ directory, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!directory) throw new Error('log directory is required');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, LOG_FILE);
  const previousPath = `${path}.1`;

  function rotateIfNeeded(extraBytes) {
    let current = 0;
    try { current = statSync(path).size; } catch {}
    if (current + extraBytes <= maxBytes) return;
    try { if (existsSync(previousPath)) unlinkSync(previousPath); } catch {}
    try { renameSync(path, previousPath); } catch {}
  }

  function write(level, message) {
    const clean = String(message ?? '').replace(/[\r\n]+$/g, '');
    const line = `${new Date().toISOString()} ${String(level || 'info').toUpperCase()} ${clean}\n`;
    try {
      rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging is diagnostic support, never a reason to stop the Bridge.
    }
  }

  return { path, directory, write };
}

module.exports = {
  LINUX_AUTOSTART_FILE,
  LOG_FILE,
  createRestartLimiter,
  linuxAutostartPath,
  quoteDesktopExecArg,
  linuxAutostartContents,
  getLaunchAtLogin,
  setLaunchAtLogin,
  isWindowsUninstallEvent,
  prepareForUninstall,
  logDirectory,
  createFileLogger,
};
