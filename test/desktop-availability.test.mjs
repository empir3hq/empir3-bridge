/**
 * One desktop-availability answer (Work Board 22e20910, P2).
 *
 * The same platform gap (no desktop control on this host) used to produce
 * three different sentences depending on which tool was called:
 *   desktop_monitors      → "missing tool(s): scrot, xdotool (apt install …)"  (Debian hint on Arch)
 *   desktop_snapshot      → "<tool> is not supported on this workstation (Omarchy)"
 *   bridge_setup_status   → "Desktop tools are currently available on Windows only."
 * These tests pin the single message every path now reads from the
 * capability gate, and that the package hint follows the host's distro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const gate = require_('../src/capability-gate.js');
const { computePlatformProfile, detectDistroFamily } = require_('../src/platform-profile.js');
const { desktopAvailability, desktopUnavailableMessage, capabilityRefusal, unsupportedDesktopCommand, DESKTOP_UNAVAILABLE_PREFIX } = gate;

const OMARCHY_OS_RELEASE = 'NAME="Omarchy"\nPRETTY_NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\n';
const UBUNTU_OS_RELEASE = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n';

// Hyprland session with XWayland: an X socket exists, WAYLAND_DISPLAY is set,
// and the X11 helper binaries are not installed.
const archHyprlandXWayland = computePlatformProfile({
  platform: 'linux',
  env: { WAYLAND_DISPLAY: 'wayland-1' },
  fsExists: () => false,
  readText: (p) => (p === '/etc/os-release' ? OMARCHY_OS_RELEASE : ''),
  readDir: (p) => (p === '/tmp/.X11-unix' ? ['X0'] : []),
});
const noTools = { toolStatus: { xdotool: false, scrot: false } };

const archWaylandOnly = computePlatformProfile({
  platform: 'linux',
  env: { WAYLAND_DISPLAY: 'wayland-1' },
  fsExists: () => false,
  readText: (p) => (p === '/etc/os-release' ? OMARCHY_OS_RELEASE : ''),
  readDir: () => [],
});

const ubuntuX11 = computePlatformProfile({
  platform: 'linux',
  env: { DISPLAY: ':0' },
  fsExists: () => false,
  readText: (p) => (p === '/etc/os-release' ? UBUNTU_OS_RELEASE : ''),
  readDir: () => [],
});

const windows = computePlatformProfile({ platform: 'win32', env: {} });
const mac = computePlatformProfile({ platform: 'darwin', env: {} });

test('distro family is parsed from ID / ID_LIKE, Omarchy counts as Arch', () => {
  assert.equal(detectDistroFamily(OMARCHY_OS_RELEASE), 'arch');
  assert.equal(detectDistroFamily(UBUNTU_OS_RELEASE), 'debian');
  assert.equal(detectDistroFamily('ID=fedora\n'), 'fedora');
  assert.equal(detectDistroFamily('ID=nobara\nID_LIKE="rhel centos fedora"\n'), 'fedora');
  assert.equal(detectDistroFamily('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n'), 'suse');
  assert.equal(detectDistroFamily('ID=alpine\n'), 'alpine');
  assert.equal(detectDistroFamily('ID=someotherlinux\n'), '');
  assert.equal(archHyprlandXWayland.distroFamily, 'arch');
  assert.equal(archHyprlandXWayland.waylandOnly, false, 'XWayland socket present → not wayland-only');
  assert.equal(archWaylandOnly.waylandOnly, true);
});

test('Arch host with X display but no xdotool/scrot: pacman hint, never apt', () => {
  const a = desktopAvailability(archHyprlandXWayland, noTools);
  assert.equal(a.available, false);
  assert.equal(a.code, 'x11_tools_missing');
  assert.ok(a.message.startsWith(DESKTOP_UNAVAILABLE_PREFIX), a.message);
  assert.match(a.message, /xdotool, scrot/);
  assert.match(a.message, /sudo pacman -S xdotool scrot/);
  assert.doesNotMatch(a.message, /apt/);
  assert.doesNotMatch(a.message, /Windows only/i);
});

test('Debian host gets the apt hint; unknown distro gets a neutral sentence', () => {
  const deb = desktopAvailability(ubuntuX11, { toolStatus: { xdotool: true, scrot: false } });
  assert.match(deb.message, /sudo apt install scrot/);
  assert.doesNotMatch(deb.message, /xdotool and scrot/);
  const unknown = desktopAvailability({ ...ubuntuX11, distroFamily: '' }, noTools);
  assert.match(unknown.message, /your distribution's package manager/);
  assert.doesNotMatch(unknown.message, /apt|pacman|dnf/);
});

test('Wayland-only session explains the X11 requirement instead of "Windows only"', () => {
  const a = desktopAvailability(archWaylandOnly);
  assert.equal(a.available, false);
  assert.equal(a.code, 'wayland_no_x11');
  assert.match(a.message, /Wayland session \(Omarchy\)/);
  assert.match(a.message, /XWayland|Xvfb/);
  assert.match(a.message, /Browser, shell, file, and CLI tools can be used when enabled in Bridge Permissions/);
  assert.doesNotMatch(a.message, /Windows only/i);
  assert.doesNotMatch(a.message, /apt install/);
});

test('macOS and Windows answer honestly too', () => {
  assert.equal(desktopAvailability(windows).available, true);
  assert.equal(desktopAvailability(windows).backend, 'windows');
  const m = desktopAvailability(mac);
  assert.equal(m.available, false);
  assert.match(m.message, /macOS desktop control is not implemented yet/);
});

test('Linux X11 with tools present: available through the x11 backend with the supported subset', () => {
  const a = desktopAvailability(ubuntuX11, { toolStatus: { xdotool: true, scrot: true } });
  assert.equal(a.available, true);
  assert.equal(a.backend, 'x11');
  assert.ok(a.supported.includes('desktop_screenshot'));
  assert.ok(!a.supported.includes('desktop_snapshot'));
});

test('every desktop_* refusal on the same host carries the same sentence', () => {
  // Tools outside the X11 subset on a host with an X display: Windows-only,
  // and the message names what IS available rather than the distro.
  const snapshot = unsupportedDesktopCommand('desktop_snapshot', '', archHyprlandXWayland);
  const pointer = unsupportedDesktopCommand('desktop_pointer_status', '', archHyprlandXWayland);
  const calibration = unsupportedDesktopCommand('desktop_calibration_status', '', archHyprlandXWayland);
  for (const refusal of [snapshot, pointer, calibration]) {
    assert.ok(refusal, 'must be refused');
    assert.ok(refusal.error.startsWith(DESKTOP_UNAVAILABLE_PREFIX), refusal.error);
    assert.match(refusal.error, /Windows-only today/);
    assert.match(refusal.hint, /desktop_screenshot, desktop_click/);
    assert.doesNotMatch(refusal.error, /workstation \(Omarchy\)|not supported on this/);
    assert.doesNotMatch(refusal.hint + refusal.error, /apt install/);
  }
  // Tools inside the subset pass the gate; the X11 executor then reports the
  // tools-missing sentence — identical prefix, distro-correct hint.
  assert.equal(unsupportedDesktopCommand('desktop_monitors', '', archHyprlandXWayland), null);
  const exec = desktopAvailability(archHyprlandXWayland, noTools);
  assert.ok(exec.message.startsWith(DESKTOP_UNAVAILABLE_PREFIX));
  // And a Wayland-only host says the same single thing for every tool.
  const w1 = capabilityRefusal('desktop_snapshot', archWaylandOnly);
  const w2 = capabilityRefusal('desktop_monitors', archWaylandOnly);
  assert.equal(w1.error, w2.error);
  assert.equal(w1.error, desktopUnavailableMessage(archWaylandOnly));
});

test('the old contradictory wording is gone from the runtime', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const x11 = readFileSync(new URL('../src/desktop-x11.js', import.meta.url), 'utf8');
  const services = readFileSync(new URL('../src/control-services.js', import.meta.url), 'utf8');
  assert.ok(!server.includes('Desktop tools are currently available on Windows only'), 'server.ts must not say Windows only');
  assert.ok(!x11.includes('apt install'), 'desktop-x11.js must not assume apt');
  assert.ok(!services.includes('native window control requires Windows.'), 'control-services must use the shared sentence');
  assert.ok(server.includes('desktopUnavailableMessage(getPlatformProfile())'));
  assert.ok(server.includes('desktopAvailability(getPlatformProfile())'), 'setup status and smoke read the shared availability');
});
