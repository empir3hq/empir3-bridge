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

/**
 * Flat desktop commands the X11 backend (desktop-x11.js) can serve on Linux:
 * the core computer-use loop of see / point / click / type.
 *
 * Everything else in the desktop_* family stays refused on Linux even with a
 * display, because it is genuinely PowerShell-shaped today (window control,
 * clipboard, notifications, app launch, the SOM/grid overlay pipeline and the
 * page↔screen mapper). A clear refusal beats a half-working tool.
 */
const X11_SUPPORTED_DESKTOP_TYPES = new Set([
  'desktop_screenshot',
  'desktop_click',
  'desktop_hover',
  'desktop_drag',
  'desktop_type',
  'desktop_key',
  'desktop_press',
  'desktop_cursor_position',
  'desktop_monitors',
]);

// ─── One desktop-availability answer ────────────────────────────────
//
// Every desktop_* tool, bridge_setup_status, bridge_reliability_smoke and the
// native-window control path used to explain the same platform gap in their
// own words ("Windows only", "missing tool(s): … (apt install …)",
// "not supported on this workstation (Omarchy)"). An agent reading three
// different sentences for one condition cannot tell whether it is looking at
// one problem or three. desktopAvailability() is the single source of truth
// and desktopUnavailableMessage() the single sentence; the refusal builders
// below and the server's Windows-only guards all read from it.

const DESKTOP_UNAVAILABLE_PREFIX = 'desktop control unavailable on this host';
const X11_REQUIRED_TOOLS = ['xdotool', 'scrot'];
const OTHER_TOOLS_WORK = 'Browser, shell, file, and CLI tools can be used when enabled in Bridge Permissions. Use gui:catalog to check support before choosing another action.';
const XVFB_EXAMPLE = 'Xvfb :99 -screen 0 1280x800x24';

/** Distro-family → install command for the X11 helper binaries. */
const PACKAGE_INSTALL = {
  arch: (pkgs) => `sudo pacman -S ${pkgs.join(' ')}`,
  debian: (pkgs) => `sudo apt install ${pkgs.join(' ')}`,
  fedora: (pkgs) => `sudo dnf install ${pkgs.join(' ')}`,
  suse: (pkgs) => `sudo zypper install ${pkgs.join(' ')}`,
  alpine: (pkgs) => `sudo apk add ${pkgs.join(' ')}`,
  nixos: (pkgs) => `nix-env -iA ${pkgs.map((p) => `nixos.${p}`).join(' ')}`,
};

function x11InstallHint(profile, missing) {
  const pkgs = missing.length ? missing : X11_REQUIRED_TOOLS;
  const build = PACKAGE_INSTALL[profile?.distroFamily || ''];
  const how = build ? `(${build(pkgs)})` : "with your distribution's package manager";
  return `Install ${pkgs.join(' and ')} ${how} and retry; no Bridge restart is required.`;
}

function unavailable(code, reason, hint) {
  return {
    available: false,
    backend: null,
    code,
    reason,
    hint,
    message: `${DESKTOP_UNAVAILABLE_PREFIX} — ${reason}. ${hint}`,
  };
}

function defaultX11ToolStatus() {
  try { return require('./desktop-x11.js').toolStatus(); } catch { return {}; }
}

/**
 * Can this machine drive its desktop at all, and through which backend?
 *
 * @param {object} profile           PlatformProfile from platform-profile.js.
 * @param {object} [options]
 * @param {string[]} [options.missingTools]  X11 helper binaries known to be
 *        absent (skips the PATH probe). Only consulted when an X display exists.
 * @param {Record<string,boolean>} [options.toolStatus]  Pre-computed PATH probe.
 * @returns {{available:boolean, backend:string|null, code:string|null, reason:string, hint:string, message?:string, display?:string, supported?:string[]}}
 */
function desktopAvailability(profile, options = {}) {
  if (!profile || profile.os === 'windows') {
    return { available: true, backend: 'windows', code: null, reason: '', hint: '' };
  }
  if (profile.os === 'macos') {
    return unavailable('macos_unsupported', 'macOS desktop control is not implemented yet', OTHER_TOOLS_WORK);
  }
  if (profile.os !== 'linux') {
    return unavailable('platform_unsupported', `desktop control is not implemented for ${profile.osPretty}`, OTHER_TOOLS_WORK);
  }
  if (!profile.x11Display) {
    if (profile.waylandOnly) {
      return unavailable(
        'wayland_no_x11',
        `this is a Wayland session (${profile.osPretty}) with no X11 display for synthetic input`,
        `The Bridge drives Linux desktops through X11. Enable XWayland in your compositor, or run Xvfb (${XVFB_EXAMPLE}) and start the Bridge with DISPLAY=:99. ${OTHER_TOOLS_WORK}`,
      );
    }
    return unavailable(
      'no_display',
      'no X display was found',
      `Start an X server or Xvfb (${XVFB_EXAMPLE}) and start the Bridge with DISPLAY=:99. ${OTHER_TOOLS_WORK}`,
    );
  }
  const missing = Array.isArray(options.missingTools)
    ? options.missingTools
    : Object.entries(options.toolStatus || defaultX11ToolStatus()).filter(([, ok]) => !ok).map(([bin]) => bin);
  if (missing.length) {
    return unavailable('x11_tools_missing', `X11 tooling is missing: ${missing.join(', ')}`, x11InstallHint(profile, missing));
  }
  return {
    available: true,
    backend: 'x11',
    display: profile.x11Display,
    code: null,
    reason: '',
    hint: '',
    supported: [...X11_SUPPORTED_DESKTOP_TYPES],
  };
}

/** The one sentence every desktop-unavailable path emits. */
function desktopUnavailableMessage(profile, options) {
  const availability = desktopAvailability(profile, options);
  if (!availability.available) return availability.message;
  return `${DESKTOP_UNAVAILABLE_PREFIX} — the requested tool is not served by the ${availability.backend} backend. ${OTHER_TOOLS_WORK}`;
}

function capabilityRefusal(capability, profile, options) {
  const availability = desktopAvailability(profile, options);
  let error;
  let hint;
  if (profile.os === 'linux' && profile.x11Display && !X11_SUPPORTED_DESKTOP_TYPES.has(capability)) {
    // An X display exists; this particular tool is just not in the Linux
    // subset yet. Installing xdotool/scrot would not change that, so say
    // Windows-only and name what IS available here.
    error = `${DESKTOP_UNAVAILABLE_PREFIX} — ${capability} is Windows-only today`;
    hint = `On Linux (${profile.osPretty}) the Bridge serves ${[...X11_SUPPORTED_DESKTOP_TYPES].join(', ')} through X11. ${OTHER_TOOLS_WORK}`;
  } else if (availability.available) {
    error = `${DESKTOP_UNAVAILABLE_PREFIX} — ${capability} is not served by the ${availability.backend} backend`;
    hint = OTHER_TOOLS_WORK;
  } else {
    error = availability.message;
    hint = availability.hint;
  }
  return {
    success: false,
    code: 'capability_unsupported',
    capability,
    deviceClass: profile.deviceClass,
    platform: profile.os,
    error,
    hint,
    availability: {
      available: availability.available,
      backend: availability.backend,
      code: availability.code,
      reason: availability.reason,
    },
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

  // These GUI actions only inspect portable metadata. Keep discovery usable
  // even on hosts that cannot provide native desktop input or screenshots.
  if (base === 'desktop:gui' && ['catalog', 'control_status', 'diagnostics'].includes(String(action || ''))) return null;

  const cap = WINDOWS_ONLY_DESKTOP_BASES[base];
  if (cap) return capabilityRefusal(cap, profile);

  if (base === 'desktop:sysinfo' && WINDOWS_ONLY_SYSINFO_QUERIES.has(String(action || ''))) {
    return capabilityRefusal(`system_info:${action}`, profile);
  }

  // Flat MCP/api command types: desktop_screenshot, desktop_click,
  // desktop_toolbar, desktop_pointer_*, … — most of the desktop_* family is
  // PowerShell-driven GUI control, as is the page↔screen coordinate mapper.
  if (/^desktop_/.test(base) || base === 'page_to_screen') {
    // Linux with a real X display serves the core subset through
    // desktop-x11.js. The display may be Xvfb with nobody watching — that is
    // an agent computer, not a broken workstation, so it is allowed.
    if (profile.os === 'linux' && profile.x11Display && X11_SUPPORTED_DESKTOP_TYPES.has(base)) {
      return null;
    }
    return capabilityRefusal(base, profile);
  }

  return null;
}

module.exports = {
  unsupportedDesktopCommand,
  capabilityRefusal,
  desktopAvailability,
  desktopUnavailableMessage,
  DESKTOP_UNAVAILABLE_PREFIX,
  X11_REQUIRED_TOOLS,
  WINDOWS_ONLY_DESKTOP_BASES,
  WINDOWS_ONLY_SYSINFO_QUERIES,
  X11_SUPPORTED_DESKTOP_TYPES,
};
