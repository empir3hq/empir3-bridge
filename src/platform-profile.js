/**
 * Platform profile — what kind of machine is this bridge running on?
 *
 * One computed answer, shared by the capability gate, /api/status, and
 * (later) fleet identity reports. The distinction that matters downstream is
 * deviceClass: a 'workstation' has a desktop the bridge can drive (screenshot,
 * click, windows); a 'server' is headless — shell, files, browser, CLI lending
 * and monitoring only. The Empir3 UI renders the two classes with different
 * tool palettes, so a Linux VPS reads as "different by design" rather than
 * "half the buttons are broken".
 *
 * Plain CommonJS (like proc-util.js) so it is require()-able from the JS
 * entrypoints and directly importable by `node --test` without a TS loader.
 */

'use strict';

const fs = require('fs');

function defaultFsExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function defaultReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Compute the platform profile. Every input can be overridden for tests;
 * production callers use getPlatformProfile() below.
 *
 * @param {object} [overrides]
 * @param {string} [overrides.platform]   process.platform stand-in
 * @param {string} [overrides.arch]       process.arch stand-in
 * @param {object} [overrides.env]        process.env stand-in
 * @param {(p: string) => boolean} [overrides.fsExists]
 * @param {(p: string) => string} [overrides.readText]
 */
function computePlatformProfile(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const arch = overrides.arch || process.arch;
  const env = overrides.env || process.env;
  const fsExists = overrides.fsExists || defaultFsExists;
  const readText = overrides.readText || defaultReadText;

  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;

  // Windows and macOS always have a display server for our purposes; on
  // Linux the presence of X11/Wayland is the signal. (Linux desktop control
  // is deferred anyway — Wayland has no portable synthetic-input API — but
  // hasDisplay still matters for choosing Chromium's headless flag.)
  const hasDisplay = platform === 'win32' || platform === 'darwin'
    ? true
    : !!(env.DISPLAY || env.WAYLAND_DISPLAY);

  const headless = env.EMPIR3_HEADLESS === '1'
    || env.BRIDGE_HEADLESS === 'true'
    || !hasDisplay;

  const deviceClass = headless ? 'server' : 'workstation';

  let container = false;
  let distro = '';
  if (platform === 'linux') {
    container = fsExists('/.dockerenv')
      || fsExists('/run/.containerenv')
      || /\b(docker|lxc|containerd|kubepods)\b/.test(readText('/proc/1/cgroup'));
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readText('/etc/os-release'));
    distro = m ? m[1] : '';
  }

  const osPretty = platform === 'win32' ? 'Windows'
    : platform === 'darwin' ? 'macOS'
    : (distro || 'Linux');

  return { os, osPretty, arch, headless, hasDisplay, deviceClass, container, distro };
}

let cachedProfile = null;

/** Cached production profile. Env-derived, so computed once per process. */
function getPlatformProfile() {
  if (!cachedProfile) cachedProfile = computePlatformProfile();
  return cachedProfile;
}

module.exports = { computePlatformProfile, getPlatformProfile };
