/**
 * desktop-x11.js — Linux desktop control backend (X11).
 *
 * The Windows desktop surface is PowerShell + System.Drawing; this is its
 * Linux counterpart, built on the two standard X utilities:
 *   scrot    screen capture
 *   xdotool  pointer + keyboard synthesis
 *
 * Why X11 only, deliberately: Wayland has no portable synthetic-input API, so
 * a "works everywhere" promise there is not one we can keep. An agent box runs
 * Xvfb, which is X11, always present from boot and never waiting for a human
 * to log in — unlike an xrdp/VNC session, which only exists while someone is
 * connected. That difference is the whole reason a Linux agent box is simpler
 * than a Windows one, where the desktop is torn down on disconnect.
 *
 * Scope is the core computer-use loop: see the screen, move/click, type, and
 * report geometry. Window management, clipboard, notifications and app
 * control stay refused by the capability gate — they are genuinely
 * PowerShell-shaped today and pretending otherwise would trade a clear
 * refusal for a confusing half-failure.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXEC_TIMEOUT_MS = 20000;

function run(bin, args, display) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: EXEC_TIMEOUT_MS, env: { ...process.env, DISPLAY: display }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || err?.message || ''),
      }),
    );
  });
}

/** Which of the tools this backend needs are actually installed. */
function toolStatus() {
  const found = {};
  for (const bin of ['scrot', 'xdotool']) {
    found[bin] = process.env.PATH.split(path.delimiter)
      .some((dir) => { try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; } });
  }
  return found;
}

/**
 * Can this machine actually serve desktop tools over X11?
 * Both a display AND the tools must be present — a display with no scrot is
 * a promise we cannot keep, and the caller deserves to know which is missing.
 */
function x11Readiness(profile) {
  const display = profile?.x11Display || '';
  const tools = toolStatus();
  const missing = Object.entries(tools).filter(([, ok]) => !ok).map(([b]) => b);
  return {
    ready: !!display && missing.length === 0,
    display,
    missing,
    reason: !display
      ? 'no X display found (start Xvfb, e.g. `Xvfb :99 -screen 0 1280x800x24`)'
      : missing.length
        ? `missing tool(s): ${missing.join(', ')} (apt install ${missing.join(' ')})`
        : '',
  };
}

/** Screen geometry of the display, via xdotool. */
async function geometry(display) {
  const r = await run('xdotool', ['getdisplaygeometry'], display);
  if (!r.ok) return null;
  const [w, h] = r.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
}

/**
 * Capture the display (optionally a region) to a PNG under outDir.
 * Mirrors the Windows handler's return shape so callers stay platform-blind.
 */
async function screenshot({ display, outDir, region }) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const geo = await geometry(display);

  let file;
  let args;
  if (region) {
    const x = Math.round(Number(region.x));
    const y = Math.round(Number(region.y));
    const w = Math.round(Number(region.width));
    const h = Math.round(Number(region.height));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      return { success: false, error: 'region requires numeric x, y, width>0, height>0' };
    }
    file = path.join(outDir, `desktop-${stamp}-region-${x}x${y}-${w}x${h}.png`);
    // -a is scrot's region grab; -o overwrites rather than erroring
    args = ['-o', '-a', `${x},${y},${w},${h}`, file];
  } else {
    file = path.join(outDir, `desktop-${stamp}-full.png`);
    args = ['-o', file];
  }

  const r = await run('scrot', args, display);
  if (!r.ok || !fs.existsSync(file)) {
    return { success: false, error: `scrot failed: ${r.stderr.trim() || 'no output file'}` };
  }
  return {
    success: true,
    path: file,
    bytes: fs.statSync(file).size,
    display,
    bounds: region
      ? { x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) }
      : { x: 0, y: 0, width: geo?.width ?? 0, height: geo?.height ?? 0 },
    coordinateSpace: 'x11-display',
  };
}

/** Move the pointer, optionally clicking. button: 1 left, 2 middle, 3 right. */
async function click({ display, x, y, button = 1, double = false }) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { success: false, error: 'click requires numeric x and y' };
  }
  const move = await run('xdotool', ['mousemove', '--sync', String(px), String(py)], display);
  if (!move.ok) return { success: false, error: `xdotool mousemove failed: ${move.stderr.trim()}` };
  const args = double
    ? ['click', '--repeat', '2', '--delay', '80', String(button)]
    : ['click', String(button)];
  const r = await run('xdotool', args, display);
  if (!r.ok) return { success: false, error: `xdotool click failed: ${r.stderr.trim()}` };
  return { success: true, clicked: { x: px, y: py, button, double }, display };
}

/** Move the pointer without clicking. */
async function hover({ display, x, y }) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { success: false, error: 'hover requires numeric x and y' };
  }
  const r = await run('xdotool', ['mousemove', '--sync', String(px), String(py)], display);
  return r.ok
    ? { success: true, moved: { x: px, y: py }, display }
    : { success: false, error: `xdotool mousemove failed: ${r.stderr.trim()}` };
}

/** Press-drag-release between two points. */
async function drag({ display, fromX, fromY, toX, toY, button = 1 }) {
  const pts = [fromX, fromY, toX, toY].map((n) => Math.round(Number(n)));
  if (!pts.every(Number.isFinite)) {
    return { success: false, error: 'drag requires numeric fromX, fromY, toX, toY' };
  }
  const [fx, fy, tx, ty] = pts;
  for (const step of [
    ['mousemove', '--sync', String(fx), String(fy)],
    ['mousedown', String(button)],
    ['mousemove', '--sync', String(tx), String(ty)],
    ['mouseup', String(button)],
  ]) {
    const r = await run('xdotool', step, display);
    if (!r.ok) {
      // Never leave a button stuck down if a later step fails.
      await run('xdotool', ['mouseup', String(button)], display);
      return { success: false, error: `xdotool ${step[0]} failed: ${r.stderr.trim()}` };
    }
  }
  return { success: true, dragged: { fromX: fx, fromY: fy, toX: tx, toY: ty, button }, display };
}

/** Type literal text into whatever holds focus. */
async function type({ display, text, delayMs = 40 }) {
  const s = String(text ?? '');
  if (!s) return { success: false, error: 'type requires non-empty text' };
  const r = await run('xdotool', ['type', '--delay', String(delayMs), '--', s], display);
  return r.ok
    ? { success: true, typed: s.length, display }
    : { success: false, error: `xdotool type failed: ${r.stderr.trim()}` };
}

/** Send a key or chord, e.g. 'Return', 'ctrl+s', 'alt+Tab'. */
async function key({ display, keys }) {
  const k = String(keys ?? '').trim();
  if (!k) return { success: false, error: 'key requires a key name, e.g. Return or ctrl+s' };
  const r = await run('xdotool', ['key', '--', k], display);
  return r.ok
    ? { success: true, key: k, display }
    : { success: false, error: `xdotool key failed: ${r.stderr.trim()}` };
}

/** Current pointer position. */
async function cursorPosition(display) {
  const r = await run('xdotool', ['getmouselocation', '--shell'], display);
  if (!r.ok) return { success: false, error: `xdotool getmouselocation failed: ${r.stderr.trim()}` };
  const out = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^(X|Y|SCREEN|WINDOW)=(\d+)$/.exec(line.trim());
    if (m) out[m[1].toLowerCase()] = Number(m[2]);
  }
  return { success: true, x: out.x ?? 0, y: out.y ?? 0, display };
}

/**
 * One logical "monitor" — an X display is a single canvas, so this reports it
 * as one entry rather than inventing per-head geometry we cannot see.
 */
async function monitors(display) {
  const geo = await geometry(display);
  if (!geo) return { success: false, error: 'could not read display geometry' };
  return {
    success: true,
    coordinateSpace: 'x11-display',
    monitors: [{
      id: display,
      deviceName: display,
      primary: true,
      bounds: { x: 0, y: 0, width: geo.width, height: geo.height, right: geo.width, bottom: geo.height },
    }],
  };
}

module.exports = {
  x11Readiness,
  toolStatus,
  geometry,
  screenshot,
  click,
  hover,
  drag,
  type,
  key,
  cursorPosition,
  monitors,
  defaultOutDir: () => path.join(os.homedir(), '.empir3-bridge', 'feedback', 'desktop'),
};
