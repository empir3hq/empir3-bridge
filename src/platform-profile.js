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

function defaultReadDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

/**
 * Find an X display this process could drive, even when DISPLAY is unset.
 *
 * A bridge started by systemd inherits no DISPLAY, so a server running Xvfb
 * looked display-less and refused every desktop tool while a perfectly usable
 * screen sat on :99. X servers always publish a socket per display in
 * /tmp/.X11-unix, so that directory is the ground truth rather than an
 * environment variable that happens to be absent.
 *
 * Returns a display string (':99') or '' when there is genuinely none.
 */
function discoverX11Display(env, readDir) {
  if (env.DISPLAY) return env.DISPLAY;
  const nums = readDir('/tmp/.X11-unix')
    .map((n) => /^X(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return nums.length ? `:${nums[0]}` : '';
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
 * @param {(p: string) => string[]} [overrides.readDir]
 */
function computePlatformProfile(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const arch = overrides.arch || process.arch;
  const env = overrides.env || process.env;
  const fsExists = overrides.fsExists || defaultFsExists;
  const readText = overrides.readText || defaultReadText;
  const readDir = overrides.readDir || defaultReadDir;

  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;

  // Windows and macOS always have a display server for our purposes; on
  // Linux the signal is an actual X display. DISPLAY is checked first, then
  // the X11 socket directory, because a systemd-started bridge inherits no
  // DISPLAY and would otherwise declare itself display-less while Xvfb is
  // running. (Wayland still counts as a display for Chromium's sake but has
  // no portable synthetic-input API, so it does not enable desktop control.)
  const x11Display = platform === 'win32' || platform === 'darwin'
    ? ''
    : discoverX11Display(env, readDir);
  const hasDisplay = platform === 'win32' || platform === 'darwin'
    ? true
    : !!(x11Display || env.WAYLAND_DISPLAY);

  const headless = env.EMPIR3_HEADLESS === '1'
    || env.BRIDGE_HEADLESS === 'true'
    || !hasDisplay;

  // A box whose only screen is Xvfb has no human at it, but it IS drivable —
  // which is exactly what an agent computer is. deviceClass follows what the
  // bridge can DO, not whether someone is sitting there.
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

  // Carried so the X11 desktop backend drives the same display detection
  // decided here, instead of re-deriving it and possibly disagreeing.
  return { os, osPretty, arch, headless, hasDisplay, deviceClass, container, distro, x11Display };
}

let cachedProfile = null;

/** Cached production profile. Env-derived, so computed once per process. */
function getPlatformProfile() {
  if (!cachedProfile) cachedProfile = computePlatformProfile();
  return cachedProfile;
}

module.exports = { computePlatformProfile, getPlatformProfile };
