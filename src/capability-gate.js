/**
 * Capability gate — one structured refusal for desktop tools on machines
 * that cannot run them, instead of 270 call sites ENOENTing on powershell.exe.
 *
 * The desktop-control surface (GUI input, window management, clipboard,
 * notifications, app launch/kill) is implemented in PowerShell and is
 * therefore Windows-only today. Rather than letting each handler die with a
 * spawn error on Linux/macOS, the TWO dispatchers (the relay path and the
 * /api/command path) consult this gate and return a machine-readable
 *   { success:false, code:'capability_unsupported', capability, deviceClass, hint }
 * so the agent can pick a different tool and the UI can render an explained
 * grey button instead of a red error.
 *
 * What is deliberately NOT gated: shell execute, file push/pull/sync,
 * project sync, browser control (headless Chromium works fine on a server),
 * CLI lending, capabilities probes, and the portable sysinfo queries.
 */

'use strict';

/** Relay-style desktop bases whose implementation is Windows-only. */
const WINDOWS_ONLY_DESKTOP_BASES = {
  'desktop:gui': 'desktop_gui',
  'desktop:window': 'window_control',
  'desktop:notify': 'notifications',
  'desktop:clipboard': 'clipboard',
  'desktop:app': 'app_control',
};

/**
 * sysinfo queries backed by PowerShell (portable pure-Node twins arrive with
 * fleet health reporting). 'overview' and 'network' are pure Node and pass.
 */
const WINDOWS_ONLY_SYSINFO_QUERIES = new Set(['processes', 'disk', 'battery', 'installed']);

function capabilityRefusal(capability, profile) {
  return {
    success: false,
    code: 'capability_unsupported',
    capability,
    deviceClass: profile.deviceClass,
    platform: profile.os,
    error: `${capability} is not supported on this ${profile.deviceClass} (${profile.osPretty})`,
    hint: profile.deviceClass === 'server'
      ? 'This machine is a headless server — desktop-control tools are unavailable here. Shell, file, browser, and CLI tools work on this device.'
      : `Desktop-control tools are Windows-only today; this device runs ${profile.osPretty}. Shell, file, browser, and CLI tools work on this device.`,
  };
}

/**
 * Decide whether a desktop command is supported on this machine.
 *
 * @param {string} baseOrType  Relay base ('desktop:gui') or flat command type
 *                             ('desktop_screenshot', 'page_to_screen').
 * @param {string} action      The command action (used for desktop:sysinfo).
 * @param {object} profile     PlatformProfile from platform-profile.js.
 * @returns {object|null}      null when allowed; a structured refusal otherwise.
 */
function unsupportedDesktopCommand(baseOrType, action, profile) {
  if (!profile || profile.os === 'windows') return null;
  const base = String(baseOrType || '');

  const cap = WINDOWS_ONLY_DESKTOP_BASES[base];
  if (cap) return capabilityRefusal(cap, profile);

  if (base === 'desktop:sysinfo' && WINDOWS_ONLY_SYSINFO_QUERIES.has(String(action || ''))) {
    return capabilityRefusal(`system_info:${action}`, profile);
  }

  // Flat MCP/api command types: desktop_screenshot, desktop_click,
  // desktop_toolbar, desktop_pointer_*, … — the whole desktop_* family is
  // PowerShell-driven GUI control, as is the page↔screen coordinate mapper.
  if (/^desktop_/.test(base) || base === 'page_to_screen') {
    return capabilityRefusal(base, profile);
  }

  return null;
}

module.exports = {
  unsupportedDesktopCommand,
  capabilityRefusal,
  WINDOWS_ONLY_DESKTOP_BASES,
  WINDOWS_ONLY_SYSINFO_QUERIES,
};
