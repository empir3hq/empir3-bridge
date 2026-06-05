/**
 * Empir3 Browser Bridge — MCP Server
 *
 * Exposes the browser bridge as Claude Code MCP tools.
 * Requires the bridge daemon running on :3006 (run `npm start` in this repo).
 *
 * Register globally:
 *   claude mcp add empir3-browser -- npx tsx <path-to-bridge>/src/mcp-server.ts
 *
 * Tools:
 *   browser_status         — Check bridge + Empir3 connection
 *   browser_navigate       — Navigate to URL
 *   browser_click          — Click element by CSS selector
 *   browser_click_ref      — Click element by Empir3 ref (e.g., e5)
 *   browser_click_xy       — Click viewport coordinates without DOM
 *   browser_type           — Type text into element
 *   browser_type_ref       — Type text into element ref
 *   browser_press          — Press keyboard key
 *   browser_scroll         — Scroll page
 *   browser_screenshot     — Take screenshot (returns image)
 *   browser_snapshot       — Get interactive element refs from accessibility tree
 *   browser_text           — Extract page text
 *   browser_evaluate       — Run JavaScript on page
 *   browser_highlight      — Highlight element
 *   browser_chat           — Send message to browser overlay
 *   browser_read_chat      — Read chat history
 *   browser_record_start   — Start recording user actions
 *   browser_record_stop    — Stop recording and save
 *   browser_play           — Play a saved recording
 *   browser_recordings     — List saved recordings
 *   browser_refresh        — Refresh the page
 *
 *   desktop_monitors        — List DPI-aware monitor bounds
 *   desktop_screenshot      — Capture monitor(s) or a region; optional grid overlay
 *   desktop_cursor_position — Read current cursor position
 *   desktop_click           — Click physical desktop coordinates
 *   desktop_hover           — Move cursor to coordinates
 *   desktop_drag            — Drag between coordinates
 *   desktop_snapshot        — Enumerate UI Automation refs (d0..dN) for native apps
 *   desktop_click_ref       — Click by snapshot ref
 *   desktop_hover_ref       — Hover by snapshot ref
 *   desktop_overlay         — Toggle click-through labeled-box overlay
 *   desktop_select_region   — User drags a rectangle → sets agent focus (auto-scopes
 *                              screenshot/snapshot to it). 30-min TTL.
 *   desktop_release_focus   — Clear the agent-focus region
 *   desktop_focus_status    — Report current focus state
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolveBootstrapExe } from './bootstrap-exe';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3006';
const SRC = __dirname;
const ROOT = resolve(SRC, '..');
const LAUNCHER = join(SRC, 'launch.js');
const SERVER_VERSION = process.env.EMPIR3_BRIDGE_PAYLOAD_VERSION || readPackageVersion();

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

function readBridgeNonce(): string {
  const explicit = process.env.EMPIR3_BRIDGE_NONCE || process.env.BRIDGE_NONCE;
  if (explicit?.trim()) return explicit.trim();
  try {
    return readFileSync(join(homedir(), '.empir3-bridge', 'nonce'), 'utf-8').trim();
  } catch {
    return '';
  }
}

function bridgeHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  const nonce = readBridgeNonce();
  if (nonce) headers['X-Empir3-Nonce'] = nonce;
  return headers;
}

// Mirror of SETTINGS_DIR in src/server.ts. The MCP shim is a separate
// process and can't import the server module — duplicate the path so we
// can read bridge-settings.json at startup for handler-family gating.
function readBridgeSettingsFile(): any {
  try {
    const settingsDir = join(process.env.APPDATA || join(homedir(), '.empir3'), 'Empir3');
    const settingsFile = join(settingsDir, 'bridge-settings.json');
    if (!existsSync(settingsFile)) return {};
    return JSON.parse(readFileSync(settingsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function isHandlerFamilyEnabled(family: string): boolean {
  const settings = readBridgeSettingsFile();
  return !!settings?.handlers?.[family]?.enabled;
}

function hasAnyCustomProvider(): boolean {
  const settings = readBridgeSettingsFile();
  return Array.isArray(settings?.customProviders) && settings.customProviders.length > 0;
}

// ─── Helpers ─────────────────────────────────────────────────

async function bridgeApi(path: string, method = 'GET', body?: any): Promise<any> {
  const opts: RequestInit = { method, headers: bridgeHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BRIDGE_URL}${path}`, opts);
  if (!res.ok) throw new Error(`Bridge ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function bridgeCommand(cmd: any): Promise<any> {
  const result = await bridgeApi('/api/command', 'POST', { action: cmd.type, channel: 'mcp', ...cmd });
  if (!result.ok || result.result?.success === false || result.result?.ok === false) throw new Error(result.error || result.result?.error || 'Command failed');
  return result.result;
}

async function bridgeScreenshot(): Promise<Buffer> {
  // Cap at 1800px wide to stay under Claude's 2000px multi-image limit
  const res = await fetch(`${BRIDGE_URL}/api/screenshot?maxWidth=1800`, { headers: bridgeHeaders(false) });
  if (!res.ok) throw new Error(`Screenshot failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function textResult(text: unknown) {
  const normalized = typeof text === 'string'
    ? text
    : JSON.stringify(text ?? '', null, 2);
  return { content: [{ type: 'text' as const, text: normalized }] };
}

function jsonResult(data: any) {
  return textResult(JSON.stringify(data, null, 2));
}

// ─── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: 'empir3-browser',
  version: SERVER_VERSION,
});

// ── Status ───────────────────────────────────────────────────

server.tool(
  'browser_status',
  'Check browser bridge and Empir3 connection status',
  {},
  async () => {
    try {
      const status = await bridgeApi('/api/status');
      return jsonResult(status);
    } catch (e: any) {
      return textResult(`Bridge not running: ${e.message}. Start it with: npm start (in the bridge repo)`);
    }
  }
);

server.tool(
  'bridge_tool_advisor',
  'Discoverability helper: given a one-line description of what you\'re trying to do (e.g. "click a small icon in Photoshop", "type into a form on a website", "guide the user through a tutorial without taking their mouse"), returns the relevant tools and the matching slice of docs/AGENT_GUIDE.md. Call this FIRST when you are unsure which of the bridge\'s 50+ tools to use.',
  {
    intent: z.string().describe('One-line description of what you are trying to do (intent, not tool name).'),
  },
  async ({ intent }) => {
    const result = await bridgeCommand({ type: 'bridge_tool_advisor', intent });
    return jsonResult(result);
  }
);

// ── Navigate ─────────────────────────────────────────────────

server.tool(
  'bridge_reliability_status',
  'Show bridge health, enabled tools, and recent action receipts.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'reliability_status' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_overlay_reinject',
  'Re-inject and verify the browser overlay used for chat and recording capture.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'overlay_reinject', reason: 'mcp' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_setup_status',
  'Report the first-use desktop setup checklist: overlay injection, monitor detection, saved click calibration, recording/playback readiness, and saved completion state.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'bridge_setup_status' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_setup_save',
  'Save the current first-use desktop setup checklist result to bridge-settings.json so MCP and empir3 agents can confirm the device was calibrated.',
  {
    completed: z.boolean().optional().describe('Whether to mark setup complete. Default true.'),
  },
  async ({ completed }) => {
    const result = await bridgeCommand({ type: 'bridge_setup_save', completed });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_reliability_smoke',
  'Run monitor, desktop screenshot, and trusted browser coordinate-click checks.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'reliability_smoke' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_action_log',
  'Read recent bridge action receipts for debugging failed or uncertain tool calls.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'action_log' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_safety_status',
  'Show whether browser write controls, desktop controls, eval, or recordings are currently enabled.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'safety_status' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_revoke_control',
  'Immediately disable browser interact, desktop, eval, and recording tools in bridge settings.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'safety_lockdown' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_navigate',
  'Navigate the browser to a URL',
  { url: z.string().describe('The URL to navigate to') },
  async ({ url }) => {
    const result = await bridgeCommand({ type: 'navigate', url });
    return textResult(`Navigated to: ${result.url}`);
  }
);

// ── Click ────────────────────────────────────────────────────

server.tool(
  'browser_tab_state',
  'List bridge browser tabs and report which tab is agent-controlled versus user-focused. Use this before switching tab control so browsing by the user does not interrupt an agent tab.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'browser_tab_state' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_tab_focus',
  'Explicitly mark a browser tab as the user focus or hand control of that tab to the agent. This never happens automatically just because the user opens a new tab.',
  {
    targetId: z.string().optional().describe('Browser target id from browser_tab_state. Preferred over URL.'),
    url: z.string().optional().describe('Fallback URL if targetId is not available.'),
    action: z.enum(['user_focus', 'control', 'show_agent']).optional().describe('user_focus marks where the user is looking; control hands the tab to the agent; show_agent brings the current agent tab forward. Default: user_focus.'),
  },
  async ({ targetId, url, action }) => {
    const result = await bridgeCommand({ type: 'browser_tab_focus', targetId, url, tabAction: action || 'user_focus' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_click',
  'Click an element by CSS selector',
  { selector: z.string().describe('CSS selector of element to click') },
  async ({ selector }) => {
    await bridgeCommand({ type: 'click', selector });
    return textResult(`Clicked: ${selector}`);
  }
);

server.tool(
  'browser_click_ref',
  'Click an element by Empir3 ref (e.g., e5). Use browser_snapshot first to see available refs.',
  { ref: z.string().describe('Element ref from snapshot (e.g., "e5")') },
  async ({ ref }) => {
    await bridgeCommand({ type: 'click_ref', ref });
    return textResult(`Clicked ref: ${ref}`);
  }
);

server.tool(
  'browser_click_xy',
  'Click viewport coordinates using native browser mouse events, without DOM selectors or refs.',
  {
    x: z.number().describe('Viewport x coordinate in CSS pixels'),
    y: z.number().describe('Viewport y coordinate in CSS pixels'),
  },
  async ({ x, y }) => {
    await bridgeCommand({ type: 'click_xy', x, y });
    return textResult(`Clicked coordinates: ${x},${y}`);
  }
);

// ── Type ─────────────────────────────────────────────────────

server.tool(
  'browser_type',
  'Type text into an element by CSS selector',
  {
    selector: z.string().describe('CSS selector of input element'),
    text: z.string().describe('Text to type'),
  },
  async ({ selector, text }) => {
    await bridgeCommand({ type: 'type', selector, text });
    return textResult(`Typed "${text}" into ${selector}`);
  }
);

server.tool(
  'browser_type_ref',
  'Type text into an element by Empir3 ref. Use browser_snapshot first to see available refs.',
  {
    ref: z.string().describe('Element ref from snapshot (e.g., "e3")'),
    text: z.string().describe('Text to type'),
  },
  async ({ ref, text }) => {
    await bridgeCommand({ type: 'type_ref', ref, text });
    return textResult(`Typed "${text}" into ref:${ref}`);
  }
);

// ── Press ────────────────────────────────────────────────────

server.tool(
  'browser_press',
  'Press a keyboard key (e.g., Enter, Tab, Escape, Control+a)',
  { key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Control+a")') },
  async ({ key }) => {
    await bridgeCommand({ type: 'press', text: key });
    return textResult(`Pressed: ${key}`);
  }
);

// ── Scroll ───────────────────────────────────────────────────

server.tool(
  'browser_scroll',
  'Scroll the page. Positive y = down, negative y = up.',
  {
    y: z.number().describe('Vertical scroll amount in pixels (positive=down, negative=up)'),
    x: z.number().optional().describe('Horizontal scroll amount in pixels'),
  },
  async ({ y, x }) => {
    const result = await bridgeCommand({ type: 'scroll', x: x || 0, y });
    return textResult(JSON.stringify({
      requested: result.scrolled,
      moved: result.moved,
      position: result.position,
      scroll: result.scroll,
    }, null, 2));
  }
);

// ── Screenshot ───────────────────────────────────────────────

server.tool(
  'browser_screenshot',
  'Take a screenshot of the current browser page. Returns the image.',
  {},
  async () => {
    const buf = await bridgeScreenshot();
    return {
      content: [{
        type: 'image' as const,
        data: buf.toString('base64'),
        mimeType: 'image/jpeg',
      }],
    };
  }
);

// ── Snapshot ─────────────────────────────────────────────────

server.tool(
  'desktop_monitors',
  'List desktop monitors with DPI-aware physical bounds, including negative coordinates and working areas.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_monitors' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_cursor_position',
  'Get the current desktop cursor position in DPI-aware physical virtual-screen coordinates.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_cursor_position' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_screenshot',
  'Capture desktop screenshots in DPI-aware physical coordinates. Pass `monitor` for a whole display (all/primary/DISPLAY1/...), `region` for a native-res crop, `grid:true` to overlay coordinate gridlines + labels, and/or `marker:{x,y}` to draw a high-visibility crosshair + circle at proposed click coordinates BEFORE clicking. The marker is the "verify before clicking" loop: pick coords from the grid, re-screenshot with marker={x,y} to confirm it lands on the target, then desktop_click. Saves one wrong click per attempt vs. eyeballing.',
  {
    monitor: z.string().optional().describe('Monitor to capture: all, primary, DISPLAY1, DISPLAY2, or full device name. Default: all. Ignored when region is supplied.'),
    region: z.object({
      x: z.number().describe('Virtual-screen X (same coordinate space as desktop_click).'),
      y: z.number().describe('Virtual-screen Y.'),
      width: z.number().describe('Region width in pixels.'),
      height: z.number().describe('Region height in pixels.'),
    }).optional().describe('Optional rectangle to capture. When set, monitor is ignored.'),
    grid: z.union([
      z.boolean(),
      z.object({
        step: z.number().optional().describe('Grid step in pixels. Default 50.'),
        color: z.string().optional().describe('Hex color for grid lines + labels, e.g. "#7AC8FF".'),
        labels: z.enum(['virtual', 'local', 'none']).optional().describe('Coord labels: "virtual" (default, virtual-screen coords usable directly with desktop_click), "local" (region-relative), or "none".'),
        labelEvery: z.number().optional().describe('Label every Nth grid line. Default 2.'),
      })
    ]).optional().describe('Set to true for a default grid overlay, or pass an object to customize.'),
    marker: z.union([
      z.object({
        x: z.number(), y: z.number(),
        color: z.string().optional().describe('Hex color, e.g. "#FF7A33" (default).'),
        size: z.number().optional().describe('Diameter in pixels of the inner circle. Default 28.'),
        label: z.string().optional().describe('Text label drawn next to the marker. Default: "x,y".'),
      }),
      z.array(z.object({
        x: z.number(), y: z.number(),
        color: z.string().optional(),
        size: z.number().optional(),
        label: z.string().optional(),
      })),
    ]).optional().describe('Crosshair + circle marker(s) at the supplied virtual-screen coord(s). Use to visually verify proposed click coords land on the right element before firing desktop_click.'),
  },
  async ({ monitor, region, grid, marker }) => {
    // Pass `monitor` through verbatim (undefined when the caller omitted it) so
    // the daemon can distinguish an explicit monitor from the default and let
    // an explicit monitor win over an active focus region. The daemon defaults
    // to 'all' when neither monitor, region, nor a focus scope applies.
    const result = await bridgeCommand({ type: 'desktop_screenshot', monitor, region, grid, marker });
    const path = result.stitchedPath || result.captures?.[0]?.path;
    if (!path) return jsonResult(result);
    const buf = readFileSync(path);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        { type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' },
      ],
    };
  }
);

server.tool(
  'desktop_click',
  'Click desktop coordinates using Windows DPI-aware physical virtual-screen coordinates. By default x/y are absolute virtual-screen. Pass monitor to use monitor-relative coords, or space:"focus" to use coords relative to the active agent-focus region (top-left = 0,0). The persisted desktop calibration is auto-applied.',
  {
    x: z.number().describe('X coordinate. Absolute virtual-screen by default; monitor-relative when monitor is supplied; focus-relative when space:"focus".'),
    y: z.number().describe('Y coordinate. See x.'),
    monitor: z.string().optional().describe('Optional monitor id such as DISPLAY1 or DISPLAY2. When supplied, x/y are monitor-relative.'),
    space: z.enum(['desktop', 'monitor', 'focus']).optional().describe('Coordinate space. "focus" adds the active focus region\'s origin to x/y — use this when you read coords off a focus-cropped screenshot. Requires an active desktop_select_region.'),
    double: z.boolean().optional().describe('Double-click instead of single-click.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default: left.'),
  },
  async ({ x, y, monitor, space, double, button }) => {
    const resolvedSpace = space || (monitor ? 'monitor' : 'desktop');
    const result = await bridgeCommand({
      type: 'desktop_click',
      x,
      y,
      monitor,
      space: resolvedSpace,
      double: !!double,
      button: button || 'left',
    });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_hover',
  'Move the desktop cursor using Windows DPI-aware physical virtual-screen coordinates. By default x/y are absolute. Pass monitor for monitor-relative or space:"focus" for focus-relative coords.',
  {
    x: z.number(),
    y: z.number(),
    monitor: z.string().optional(),
    space: z.enum(['desktop', 'monitor', 'focus']).optional(),
  },
  async ({ x, y, monitor, space }) => {
    const resolvedSpace = space || (monitor ? 'monitor' : 'desktop');
    const result = await bridgeCommand({
      type: 'desktop_hover',
      x,
      y,
      monitor,
      space: resolvedSpace,
    });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_drag',
  'Drag between desktop coordinates using Windows DPI-aware physical virtual-screen coordinates. By default endpoints are absolute. Pass monitor for monitor-relative or space:"focus" for focus-relative endpoints.',
  {
    x: z.number(),
    y: z.number(),
    toX: z.number(),
    toY: z.number(),
    monitor: z.string().optional(),
    space: z.enum(['desktop', 'monitor', 'focus']).optional(),
    durationMs: z.number().optional().describe('Drag duration in milliseconds. Default: 500.'),
    steps: z.number().optional().describe('Interpolation steps. Default: 24.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default: left.'),
  },
  async ({ x, y, toX, toY, monitor, space, durationMs, steps, button }) => {
    const resolvedSpace = space || (monitor ? 'monitor' : 'desktop');
    const result = await bridgeCommand({
      type: 'desktop_drag',
      x,
      y,
      toX,
      toY,
      monitor,
      space: resolvedSpace,
      durationMs,
      steps,
      button: button || 'left',
    });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_snapshot',
  'Enumerate visible interactive elements (buttons, menus, inputs, list items, tabs) on the desktop via Windows UI Automation. Returns refs like "d0", "d1" with role, name, bounds, and owning window. Use these refs with desktop_click_ref and desktop_hover_ref — far more reliable than guessing pixel coordinates from a screenshot. Best on native Win32/UWP apps; Electron/Chromium apps need accessibility enabled. Default scope is the foreground window.',
  {
    scope: z.enum(['foreground', 'all-windows']).optional().describe('"foreground" (default) walks only the active window; "all-windows" enumerates every visible top-level window.'),
    maxElements: z.number().optional().describe('Cap on returned elements. Default 200, max 500.'),
  },
  async ({ scope, maxElements }) => {
    const result = await bridgeCommand({ type: 'desktop_snapshot', scope: scope || 'foreground', maxElements: maxElements ?? 200 });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_snapshot_som',
  'Set-of-Mark snapshot for the agent-focus region (or an explicit region). Runs a UIA enumeration, filters to elements inside the region, takes a focus-scoped screenshot, and DRAWS numbered colored boxes (1..N) directly on the image. The agent reads the numbers off the image and acts with desktop_click_ref using the returned `ref`. Removes pixel-coordinate guessing for native Win32 apps. For CEF/Electron/games where UIA returns nothing, this returns `empty: true` (vision-based fallback is a separate tool).',
  {
    region: z.object({
      x: z.number(), y: z.number(), width: z.number(), height: z.number(),
    }).optional().describe('Optional region override. Defaults to the active agent-focus region, then to the foreground window bounds.'),
    maxElements: z.number().optional().describe('Cap on enumerated elements. Default 200, max 500.'),
  },
  async ({ region, maxElements }) => {
    const result = await bridgeCommand({ type: 'desktop_snapshot_som', region, maxElements: maxElements ?? 200 });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_click_ref',
  'Click a desktop element by ref returned from desktop_snapshot (e.g. "d3"). Resolves to the element bounds center and performs a real Win32 click. Refs are invalidated by the next desktop_snapshot.',
  {
    ref: z.string().describe('Desktop ref from the most recent desktop_snapshot, e.g. "d0".'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default: left.'),
    double: z.boolean().optional().describe('Double-click instead of single-click.'),
  },
  async ({ ref, button, double }) => {
    const result = await bridgeCommand({ type: 'desktop_click_ref', ref, button: button || 'left', double: !!double });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_hover_ref',
  'Move the cursor to the center of a desktop element by ref returned from desktop_snapshot. Useful for hover-revealed tooltips and menus.',
  {
    ref: z.string().describe('Desktop ref from the most recent desktop_snapshot, e.g. "d0".'),
  },
  async ({ ref }) => {
    const result = await bridgeCommand({ type: 'desktop_hover_ref', ref });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_select_region',
  'Open a fullscreen overlay that lets the USER drag a rectangle around the area they want help with. Blocks until the user finishes selecting (or hits Esc to cancel). On success, sets the bridge\'s "agent focus" to that region — subsequent desktop_screenshot / desktop_snapshot calls automatically scope to it unless the caller explicitly passes its own region. A small "Agent focus active" chip appears anchored to the region so the user can see what the agent is looking at. By default the region uses IDLE-REVOKE: every real scoped use (screenshot, click, snapshot, etc.) resets a 30-minute timer, so active work never drops it, but a region left untouched for 30 min auto-clears. Pass keepOpen:true for PERSISTENT mode (no expiry — lives until desktop_release_focus); useful for long-running watches. Returns the selected region in virtual-screen coords plus the resolved persist flag.',
  {
    timeoutMs: z.number().optional().describe('How long to wait for the user before giving up. Default 60000 (60s), max 120000.'),
    keepOpen: z.boolean().optional().describe('Persistent mode: keep the focus region until explicitly released (desktop_release_focus), with NO idle expiry. Default false → idle-revoke (auto-clears after 30 min of no scoped use). If the user has set a global keep-open default, that applies when this is omitted; pass false to force idle-revoke regardless.'),
  },
  async ({ timeoutMs, keepOpen }) => {
    const result = await bridgeCommand({ type: 'desktop_select_region', timeoutMs, keepOpen });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_release_focus',
  'Clear the bridge\'s current agent-focus region (if any). After this, desktop_screenshot/desktop_snapshot revert to whole-monitor or foreground-window behavior. The on-screen chip disappears.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_release_focus' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_focus_status',
  'Report whether a desktop focus region is currently active, with bounds, mode ("idle-revoke" or "persistent"), persist flag, and remainingMs (null for persistent regions — they have no expiry; otherwise ms until idle auto-clear, which resets on every scoped use). Pure status reads do NOT extend the region.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_focus_status' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_show',
  'Show a click-through "ghost cursor" overlay at the given absolute screen coords. The cursor is purely visual — clicks pass straight through, the user\'s real mouse is unaffected. Use this to draw the user\'s attention to a specific spot ("I\'m looking here / I think you should click here") without taking control. Optional label paints a small pill next to the arrow. Stays visible until desktop_pointer_hide. By default the persisted desktop calibration is applied so the pointer lands at the same physical pixel a desktop_click would hit; pass noCalibration:true to render at raw requested coords.',
  {
    x: z.number().describe('X coordinate. Absolute virtual-screen by default, or relative to the agent-focus region top-left when space:"focus".'),
    y: z.number().describe('Y coordinate. See x.'),
    label: z.string().optional().describe('Short text shown beside the cursor (max 80 chars).'),
    space: z.enum(['desktop', 'focus']).optional().describe('"desktop" (default): x/y are absolute virtual-screen coords. "focus": x/y are relative to the top-left of the user\'s desktop_select_region selection (requires an active focus). Use focus when you\'re reading coords off a focus-cropped screenshot so you don\'t have to add focus.x/focus.y manually.'),
    noCalibration: z.boolean().optional().describe('Skip the click-calibration transform (render at raw coords). Default false.'),
  },
  async ({ x, y, label, space, noCalibration }) => {
    const result = await bridgeCommand({ type: 'desktop_pointer_show', x, y, label, space, noCalibration });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_click_page',
  'Perform a REAL OS-level mouse click on an element inside the bridge\'s OWN Chrome page. Give it a CSS selector, a browser_snapshot ref, or raw cssX/cssY viewport coords; the bridge maps the page coordinate to a physical virtual-screen pixel (content-window origin + devicePixelRatio + persisted click calibration) and dispatches a hardware click there. Use this instead of browser_click when a target needs a TRUSTED, OS-level click (drag handles, native-feel widgets, trusted-event-gated UIs) or when you want the real cursor to move onto the element. Brings the bridge Chrome window to the front first. Windows-only; bridge\'s Chrome only.',
  {
    selector: z.string().optional().describe('CSS selector of the target element. The element\'s bounding-box center is used.'),
    ref: z.string().optional().describe('A browser_snapshot element ref (e.g. "e5") — resolved via [data-empir3-ref].'),
    cssX: z.number().optional().describe('Raw CSS-viewport X (px). Use with cssY when you have explicit page coords instead of an element.'),
    cssY: z.number().optional().describe('Raw CSS-viewport Y (px). See cssX.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default left.'),
    double: z.boolean().optional().describe('Double-click instead of single. Default false.'),
  },
  async ({ selector, ref, cssX, cssY, button, double }) => {
    const result = await bridgeCommand({ type: 'desktop_click_page', selector, ref, cssX, cssY, button, double });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_page',
  'Show the click-through "ghost cursor" overlay on top of an element in the bridge\'s own Chrome page (CSS selector, snapshot ref, or cssX/cssY). Same page→physical-screen mapping as desktop_click_page, but visual-only — the user\'s real mouse is untouched and no click happens. Use to point at a page element ("I\'m looking at this button") without taking control. Windows-only; bridge\'s Chrome only.',
  {
    selector: z.string().optional().describe('CSS selector of the element to point at (bounding-box center).'),
    ref: z.string().optional().describe('A browser_snapshot element ref.'),
    cssX: z.number().optional().describe('Raw CSS-viewport X (px), with cssY.'),
    cssY: z.number().optional().describe('Raw CSS-viewport Y (px).'),
    label: z.string().optional().describe('Short text shown beside the ghost cursor (max 80 chars).'),
  },
  async ({ selector, ref, cssX, cssY, label }) => {
    const result = await bridgeCommand({ type: 'desktop_pointer_page', selector, ref, cssX, cssY, label });
    return jsonResult(result);
  }
);

server.tool(
  'page_to_screen',
  'Inspect-only: resolve an element in the bridge\'s Chrome page (CSS selector, snapshot ref, or cssX/cssY) to its physical virtual-screen coordinates. Returns the intended screen pixel (where the element actually is), the calibrated coordinate a real click would dispatch, the content-window origin, devicePixelRatio, and the element\'s CSS rect. Use to verify where desktop_click_page would land before committing, or to compute a screen coord for another desktop tool. No click, no cursor movement (but does bring the window to front to read its geometry). Windows-only.',
  {
    selector: z.string().optional().describe('CSS selector of the element (bounding-box center is mapped).'),
    ref: z.string().optional().describe('A browser_snapshot element ref.'),
    cssX: z.number().optional().describe('Raw CSS-viewport X (px), with cssY.'),
    cssY: z.number().optional().describe('Raw CSS-viewport Y (px).'),
  },
  async ({ selector, ref, cssX, cssY }) => {
    const result = await bridgeCommand({ type: 'page_to_screen', selector, ref, cssX, cssY });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_move',
  'Reposition the ghost cursor to new coords. If no pointer is currently shown, this is equivalent to desktop_pointer_show. The overlay polls every ~40ms so updates feel near real-time. Applies the persisted calibration unless noCalibration:true. Supports space:"focus" for focus-relative coords (see desktop_pointer_show).',
  {
    x: z.number(),
    y: z.number(),
    label: z.string().optional().describe('Optional new label — omit to leave the current label unchanged.'),
    space: z.enum(['desktop', 'focus']).optional(),
    noCalibration: z.boolean().optional(),
  },
  async ({ x, y, label, space, noCalibration }) => {
    const result = await bridgeCommand({ type: 'desktop_pointer_move', x, y, label, space, noCalibration });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_pulse',
  'Trigger a one-shot expanding ring animation at the ghost cursor\'s current (or specified) position. Useful for "look here NOW" emphasis. Requires the pointer to already be shown.',
  {
    x: z.number().optional().describe('Optional: move + pulse in one call.'),
    y: z.number().optional(),
  },
  async ({ x, y }) => {
    const result = await bridgeCommand({ type: 'desktop_pointer_pulse', x, y });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_hide',
  'Hide the ghost cursor overlay if it is currently shown.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_pointer_hide' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_status',
  'Report whether the ghost cursor is currently shown, its position and label, and whether the overlay PS process is alive.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_pointer_status' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_calibrate_pointer',
  'Run interactive multi-point click calibration. Shows 5 target crosshairs (corners + center) — the user clicks each one. Bridge fits a per-axis affine transform (scale + offset) from (target → actual_click) and persists it per monitor in bridge-settings.json. Every subsequent desktop_click (and desktop_pointer_show) auto-applies the transform. Run when clicks land off-target. WHEN AN AGENT-FOCUS REGION IS ACTIVE, this defaults to calibrating WITHIN the focus region — smaller overlay, tighter fit for the area the user actually cares about, fewer interruptions. Override with area:"monitor" to calibrate the whole monitor.',
  {
    monitor: z.string().optional().describe('Which monitor to calibrate: "primary" (default), "all", or a specific id like "DISPLAY4". Ignored when area="focus".'),
    area: z.enum(['focus', 'monitor', 'all']).optional().describe('"focus" (default when desktop_select_region is active) calibrates inside the focus region. "monitor" calibrates the whole monitor selected by `monitor`. "all" calibrates every monitor.'),
    persist: z.boolean().optional().describe('Save to bridge-settings.json. Default true.'),
  },
  async ({ monitor, area, persist }) => {
    const result = await bridgeCommand({ type: 'desktop_calibrate_pointer', monitor, area, persist });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_calibration_status',
  'Return the persisted desktop click calibration (per-monitor affine transforms in v2, uniform offset in v1) or null if uncalibrated. Use this to check which monitors are calibrated and inspect the residual pixel error.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'desktop_calibration_status' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pick_point',
  'Ask the user to designate a point inside the agent-focus region. A semi-transparent capture overlay appears over the focus area with a banner prompt; user clicks anywhere inside; bridge returns the click position as focus-relative pixel, absolute pixel, AND chess-board cell coords (col/row/subX/subY matching the desktop_focus_grid overlay). Eliminates "click HERE → I have to guess where HERE is" round-trips when the user can show you. Blocks until click or Esc (max 60s default).',
  {
    prompt: z.string().optional().describe('Custom banner text shown to the user. Default: "Click the spot you want the agent to target".'),
    timeoutMs: z.number().optional().describe('Max wait. Default 60000, clamped to [5000, 120000].'),
  },
  async ({ prompt, timeoutMs }) => {
    const result = await bridgeCommand({ type: 'desktop_pick_point', prompt, timeoutMs });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_toolbar',
  'Open, close, or check the movable desktop toolbar widget. The toolbar exposes focus region, release focus, overlay chat injection, recording, playback, saved recording selection, and quick calibration on the monitor where the toolbar sits.',
  {
    action: z.enum(['show', 'hide', 'status']).optional().describe('show opens the toolbar, hide closes it, status reports whether it is running. Default: show.'),
  },
  async ({ action }) => {
    const result = await bridgeCommand({ type: 'desktop_toolbar', action: action || 'show' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_focus_grid',
  'Toggle an on-screen click-through grid overlay covering the active agent-focus region. Same chess-board grid (~16 cells, integer pill labels on top + left edges) that goes into the focus screenshot — but drawn live ON the user\'s screen, so human and agent share the exact same coord system. User can say "click cell 8,7" reading off the on-screen labels and you call desktop_click_cell with those numbers, no screenshot round-trip. Overlay survives focus repositioning and auto-disappears when desktop_release_focus is called.',
  {
    action: z.enum(['show', 'hide', 'toggle', 'status']).optional().describe('Default: toggle.'),
  },
  async ({ action }) => {
    const result = await bridgeCommand({ type: 'desktop_focus_grid', action: action || 'toggle' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_click_cell',
  'Click a cell of the agent-focus grid. The focus screenshot is overlaid with a chess-board grid (~16 cells across the larger dimension); pass the col/row you read off the pill labels and bridge translates to the cell center, then clicks. Requires an active desktop_select_region. Optional subX/subY (each in [-0.5, 0.5]) shifts within the cell — useful for sub-cell precision without taking a zoom screenshot.',
  {
    col: z.number().int().describe('Column index (1-indexed, matches the top-edge pill labels).'),
    row: z.number().int().describe('Row index (1-indexed, matches the left-edge pill labels).'),
    subX: z.number().optional().describe('Fractional X offset within the cell, -0.5 (left edge) to +0.5 (right edge). Default 0 (center).'),
    subY: z.number().optional().describe('Fractional Y offset within the cell, -0.5 (top) to +0.5 (bottom). Default 0 (center).'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
  },
  async ({ col, row, subX, subY, button, double }) => {
    const result = await bridgeCommand({ type: 'desktop_click_cell', col, row, subX, subY, button, double });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_pointer_cell',
  'Show the ghost cursor at the center of a focus-grid cell. Same addressing as desktop_click_cell — col/row (1-indexed) match the on-screen pill labels.',
  {
    col: z.number().int(),
    row: z.number().int(),
    subX: z.number().optional(),
    subY: z.number().optional(),
    label: z.string().optional(),
  },
  async ({ col, row, subX, subY, label }) => {
    const result = await bridgeCommand({ type: 'desktop_pointer_cell', col, row, subX, subY, label });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_screenshot_zoom',
  'Take a tight crop of the desktop centered on (x, y) at native resolution — no downscaling. Use this when you need pixel-accurate visual inspection of a small area before clicking or pointing at a specific element. Pass radius for the half-width of the crop (default 100 → 200×200 px square). A small green marker is drawn at the exact center of the returned image so you can verify your coord estimate. Set noMarker:true to omit it. Pass space:"focus" to interpret x/y as focus-relative coords.',
  {
    x: z.number().describe('X of the crop center (absolute by default, focus-relative when space:"focus").'),
    y: z.number().describe('Y of the crop center.'),
    radius: z.number().optional().describe('Half-width of the square crop in pixels. Default 100 (200×200 px). Clamped to [20, 800].'),
    space: z.enum(['desktop', 'focus']).optional(),
    noMarker: z.boolean().optional().describe('Skip the center marker. Default false.'),
  },
  async ({ x, y, radius, space, noMarker }) => {
    const result = await bridgeCommand({ type: 'desktop_screenshot_zoom', x, y, radius, space, noMarker });
    const path = result.stitchedPath || result.captures?.[0]?.path;
    if (!path) return jsonResult(result);
    const buf = readFileSync(path);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        { type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' },
      ],
    };
  }
);

server.tool(
  'desktop_overlay',
  'Toggle a click-through overlay that draws labeled rectangles over the elements from the most recent desktop_snapshot. The overlay is fully transparent to clicks/keys so it never blocks the user. Useful when an agent is driving the desktop and the human wants to see what is being targeted. The overlay auto-refreshes whenever a new snapshot is taken.',
  {
    action: z.enum(['show', 'hide', 'toggle', 'status']).optional().describe('"show" opens the overlay, "hide" closes it, "toggle" flips state, "status" returns the running state without changing it. Default: toggle.'),
  },
  async ({ action }) => {
    const result = await bridgeCommand({ type: 'desktop_overlay', action: action || 'toggle' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_snapshot',
  'Get interactive element refs from the accessibility tree. Use these refs with browser_click_ref and browser_type_ref. Much cheaper than screenshots.',
  {
    filter: z.enum(['interactive', 'all']).optional().describe('Filter: "interactive" (buttons, inputs) or "all" (everything). Default: interactive'),
  },
  async ({ filter }) => {
    const result = await bridgeCommand({ type: 'snapshot', filter: filter || 'interactive', format: 'compact' });
    const snapshot = result.snapshot;
    if (typeof snapshot === 'string') {
      return textResult(snapshot);
    }
    return jsonResult(snapshot);
  }
);

// ── Text ─────────────────────────────────────────────────────

server.tool(
  'browser_text',
  'Extract readable text content from the current page',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'text' });
    return textResult(result.text || '(no text)');
  }
);

// ── Evaluate ─────────────────────────────────────────────────

server.tool(
  'browser_evaluate',
  'Run JavaScript on the current page and return the result',
  { script: z.string().describe('JavaScript expression to evaluate') },
  async ({ script }) => {
    const result = await bridgeCommand({ type: 'evaluate', script });
    return jsonResult(result);
  }
);

// ── Highlight ────────────────────────────────────────────────

server.tool(
  'browser_highlight',
  'Highlight an element on the page with a blue glow (for showing the user)',
  { selector: z.string().describe('CSS selector to highlight') },
  async ({ selector }) => {
    await bridgeCommand({ type: 'highlight', selector });
    return textResult(`Highlighted: ${selector}`);
  }
);

// ── Chat ─────────────────────────────────────────────────────

server.tool(
  'browser_chat',
  'Send a message to the user via the browser overlay chat panel',
  { message: z.string().describe('Message to display in the browser chat panel') },
  async ({ message }) => {
    await bridgeCommand({ type: 'chat', message });
    return textResult(`Sent to browser: ${message}`);
  }
);

server.tool(
  'browser_read_chat',
  'Read recent messages from the browser overlay chat',
  { limit: z.number().optional().describe('Number of messages to read (default: 20)') },
  async ({ limit }) => {
    const messages = await bridgeApi('/api/chat');
    const recent = messages.slice(-(limit || 20));
    if (recent.length === 0) return textResult('No messages yet.');
    const formatted = recent.map((m: any) => {
      const time = new Date(m.timestamp).toLocaleTimeString();
      const from = m.from === 'user' ? 'User' : 'Claude';
      let line = `[${time}] ${from}: ${m.text}`;
      if (m.screenshot) line += ` [screenshot: ${m.screenshot}]`;
      if (m.selector) line += ` [element: ${m.selector}]`;
      return line;
    }).join('\n');
    return textResult(formatted);
  }
);

// ── Recording ────────────────────────────────────────────────

server.tool(
  'browser_record_start',
  'Start recording user interactions in the browser. The user clicks/types/scrolls and actions are captured with element refs.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'record_start' });
    return textResult(`Recording started at ${result.startUrl}`);
  }
);

server.tool(
  'browser_record_stop',
  'Stop recording and save. Returns the recording file name and action count.',
  { name: z.string().optional().describe('Name for the recording (default: auto-generated)') },
  async ({ name }) => {
    const result = await bridgeCommand({ type: 'record_stop', text: name });
    const refCount = result.refCount || 0;
    // Agent-driven actions (browser_click/type from this MCP) replay reliably
    // via their selector/evaluate steps, so a 0 here is not a problem — only
    // overlay-captured user clicks carry accessibility refs. Word it so it
    // doesn't read as a failure.
    const refNote = refCount > 0
      ? `${refCount} with accessibility refs`
      : 'replays via selector/coordinate steps (no accessibility refs captured)';
    return textResult(`Saved: ${result.saved} (${result.actionCount} actions, ${(result.duration / 1000).toFixed(1)}s, ${refNote})`);
  }
);

server.tool(
  'browser_play',
  'Play a saved recording. Uses element refs for reliable replay with coordinate fallback.',
  {
    recording: z.string().describe('Recording name to play'),
    speed: z.number().optional().describe('Playback speed multiplier (default: 1, range: 0.1-10)'),
    variables: z.record(z.string()).optional().describe('Variable substitutions (e.g., {"EMAIL": "test@test.com"})'),
  },
  async ({ recording, speed, variables }) => {
    const result = await bridgeCommand({ type: 'play', recording, speed: speed || 1, variables: variables || {} });
    const lines = result.results.map((r: any) => {
      const icon = r.ok ? '\u2713' : '\u2717';
      const method = r.method ? ` [${r.method}]` : '';
      return `  ${icon} Step ${r.step}: ${r.action}${method}${r.error ? ' — ' + r.error : ''}`;
    });
    return textResult(`Playback "${result.name}": ${result.passed}/${result.total} passed, ${result.failed} failed.\n${lines.join('\n')}`);
  }
);

server.tool(
  'browser_recordings',
  'List all saved recordings',
  {},
  async () => {
    const recordings = await bridgeApi('/api/recordings');
    if (recordings.length === 0) return textResult('No recordings yet.');
    const lines = recordings.map((r: any) => {
      const engine = r.engine === 'empir3' ? '[empir3]' : '[legacy]';
      // Truncate data: URIs and other long URLs so the listing stays readable.
      let url = String(r.startUrl || '');
      if (url.startsWith('data:')) {
        url = `data:… (${url.length}b)`;
      } else if (url.length > 100) {
        url = url.slice(0, 97) + '…';
      }
      return `  ${r.name} (${r.actionCount} actions, ${(r.duration / 1000).toFixed(1)}s) ${engine} — ${url}`;
    });
    return textResult(lines.join('\n'));
  }
);

// ── Refresh ──────────────────────────────────────────────────

server.tool(
  'browser_refresh',
  'Refresh the current browser page',
  {},
  async () => {
    await bridgeCommand({ type: 'refresh' });
    return textResult('Page refreshed');
  }
);

// ─── Higgsfield CLI (handler-gated) ─────────────────────────
//
// Registered only when settings.handlers.higgsfield.enabled is true so the
// tools never appear in a client's tool inventory unless the user has
// flipped the tray toggle. The bridge dispatcher enforces the same gate
// at command time (defense in depth) — see enforceHandlerFamilyGate() in
// src/server.ts.
if (isHandlerFamilyEnabled('higgsfield')) {
  server.tool(
    'higgsfield_status',
    'Check whether the higgsfield CLI is installed, authenticated, and ready.',
    {},
    async () => {
      const result = await bridgeCommand({ type: 'higgsfield_status' });
      return jsonResult(result);
    }
  );

  server.tool(
    'higgsfield_list',
    'List the user\'s recent Higgsfield generations.',
    { limit: z.number().int().positive().max(200).optional().describe('Optional cap on results returned by the CLI.') },
    async ({ limit }) => {
      const result = await bridgeCommand({ type: 'higgsfield_list', params: { limit } });
      return jsonResult(result);
    }
  );

  server.tool(
    'higgsfield_models',
    'List the available Higgsfield models so you can pick a valid `model` (job_set_type) for higgsfield_generate. Returns [{job_set_type, name, type}] where type is "image", "video", or "text". The catalog changes over time — ALWAYS call this to discover valid ids rather than guessing. Examples of current ids: z_image / flux_2 / seedream_v4_5 (text→image), nano_banana_2 / flux_kontext (image edit, need an --image), veo3_1 / kling3_0 / seedance_2_0 (video).',
    { type: z.enum(['image', 'video', 'text']).optional().describe('Optional filter to only image, video, or text models.') },
    async ({ type }) => {
      const result = await bridgeCommand({ type: 'higgsfield_models', params: { type } });
      return jsonResult(result);
    }
  );

  server.tool(
    'higgsfield_generate',
    'Generate a Higgsfield image or video from a text prompt (and optional reference image). Returns the result URL plus a local artifact path under ~/.empir3-bridge/artifacts/higgsfield/. Costs money/quota on the user\'s Higgsfield account. HOW TO USE: (1) call higgsfield_models to get a valid `model` (job_set_type) and its type; (2) for text→image use an image model with just a prompt (e.g. z_image); (3) for image editing use an edit model AND pass `image` (e.g. nano_banana_2); (4) video models (e.g. veo3_1) take a prompt and run longer. Per-model knobs (aspect_ratio, resolution, duration, etc.) go in `extra`.',
    {
      model: z.string().describe('A Higgsfield job_set_type from higgsfield_models (e.g. "z_image", "nano_banana_2", "veo3_1"). NOT a free-form name — call higgsfield_models first if unsure.'),
      prompt: z.string().describe('Text prompt for the generation.'),
      image: z.string().optional().describe('Reference/input image for edit or image-conditioned models — an absolute path on disk or base64 bytes (optionally a data: URI). Required by edit models like nano_banana_2; ignored by pure text→image models.'),
      extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Per-model params forwarded verbatim as --key value (e.g. {aspect_ratio:"16:9", resolution:"2048", duration:5}). See higgsfield model params for what each model accepts.'),
      waitTimeoutMs: z.number().int().positive().optional().describe('Max wait in milliseconds before the bridge gives up. Hard-capped at 20 minutes (videos can be slow).'),
    },
    async (params) => {
      const result = await bridgeCommand({ type: 'higgsfield_generate', params });
      return jsonResult(result);
    }
  );
}

// ─── Lent CLIs — run another model's CLI one-shot ────────────
// codex / grok / gemini / claude / agy. Each run is gated by that CLI's lend
// toggle (the bridge refuses a model that isn't lent). The driving agent
// orchestrates — this is just the primitive that lends the seat.
server.tool(
  'cli_run',
  'Run another model\'s lent CLI with a prompt and get its text response back — so you (the driving agent) can pull a second LLM into a task: have Codex build something, Grok draft a spec, Gemini review, etc. The bridge handles each CLI\'s invocation quirks. Each model must be lent (toggle on the bridge\'s API & CLIs pane) or the run is refused. Spends the user\'s CLI subscription/quota. For a long run pass background:true and poll cli_run_status.',
  {
    model: z.enum(['codex', 'grok', 'gemini', 'claude', 'agy']).describe('Which lent CLI to run.'),
    prompt: z.string().optional().describe('The prompt to send. Provide this OR promptFile.'),
    promptFile: z.string().optional().describe('Path to a file whose contents are the prompt (use for very large prompts).'),
    cwd: z.string().optional().describe('Working directory to run the CLI in (relevant for agentic/file-writing work).'),
    mode: z.enum(['text', 'agentic']).optional().describe('"text" (default): read-only, just return the answer. "agentic": allow the CLI to write files in cwd (best supported on codex via its workspace-write sandbox).'),
    modelId: z.string().optional().describe('Optional underlying model id passed to the CLI (e.g. a specific Codex model). Omit for the CLI\'s default.'),
    background: z.boolean().optional().describe('Run without blocking; returns a run id immediately. Poll cli_run_status(id) / cli_runs for completion.'),
    timeoutMs: z.number().int().positive().optional().describe('Max wait in ms. Default 4 min, hard cap 20 min.'),
  },
  async (params) => {
    const result = await bridgeCommand({ type: 'cli_run', params });
    return jsonResult(result);
  }
);

server.tool(
  'cli_runs',
  'List recent cli_run invocations — id, model, status, duration, and transcript path. Use to see what lent-CLI runs are in flight or finished.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'cli_runs' });
    return jsonResult(result);
  }
);

server.tool(
  'cli_run_status',
  'Get the status and output of a cli_run by id. Use to poll a background run to completion (status goes running → done/error/timeout) and read its text + transcript.',
  { id: z.string().describe('The run id returned by cli_run.') },
  async ({ id }) => {
    const result = await bridgeCommand({ type: 'cli_run_status', params: { id } });
    return jsonResult(result);
  }
);

server.tool(
  'cli_status',
  'Discover which lent CLIs you can drive via cli_run RIGHT NOW. Returns one row per model (codex / grok / gemini / claude / agy) with available (installed), lent (owner toggled it on), authenticated (signed in), ready (all three), and blocker (cli_not_installed / not_lent / not_signed_in / null). Call this FIRST to route a task to a model that will actually run, instead of calling cli_run and getting a "not lent" refusal. For image/video use higgsfield_* instead.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'cli_status' });
    return jsonResult(result);
  }
);

// ─── Custom LLMs (provider-count-gated) ──────────────────────
// One generic tool that fans out to any custom LLM the user configured
// on the API & CLIs pane (Ollama, LM Studio, OpenRouter, vLLM, etc).
// Registered only when at least one custom provider exists, so the
// permission toggle never appears as a phantom "blocked" tool with
// nothing to dispatch to. The bridge dispatcher enforces the same gate
// at command time.
if (hasAnyCustomProvider()) {
  server.tool(
    'custom_llm',
    'Send a chat-completion request to any custom LLM the user configured on the bridge\'s API & CLIs pane (Ollama, LM Studio, OpenRouter, Groq Cloud, vLLM, etc — any OpenAI-compatible endpoint). Use this to route a prompt through a local LLM or a cloud aggregator the user has set up.',
    {
      provider: z.string().describe('Provider slug from the bridge\'s configured custom providers (e.g. "ollama-local", "openrouter").'),
      model: z.string().describe('Model id to use (must match a model the provider exposes — see provider.models).'),
      prompt: z.string().describe('User prompt for the chat completion.'),
      system: z.string().optional().describe('Optional system message.'),
    },
    async ({ provider, model, prompt, system }) => {
      const result = await bridgeCommand({ type: 'custom_llm', params: { provider, model, prompt, system } });
      return textResult(result?.text || result?.result?.text || JSON.stringify(result, null, 2));
    }
  );
}

// ─── Auto-launch ────────────────────────────────────────────

async function checkBridgeHealth(timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${BRIDGE_URL}/api/status`, { signal: controller.signal, headers: bridgeHeaders(false) });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !!body?.running || !!body?.ok;
  } catch {
    return false;
  }
}

async function waitForBridgeHealth(maxWait = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (await checkBridgeHealth()) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Bridge did not become healthy at ${BRIDGE_URL} within ${maxWait / 1000}s`);
}

async function ensureBridgeRunning(): Promise<void> {
  if (await checkBridgeHealth()) {
    console.error('[MCP] Bridge already running');
    return;
  }

  console.error('[MCP] Bridge not running — auto-launching...');

  // Prod: launch the resolved bootstrap exe with --daemon (it brings up the
  // tray → daemon). The old `node <SRC>/launch.js` form is dev-only — launch.js
  // is not shipped in the payload — so use it only when no bootstrap exe
  // resolves. All logging here is stderr (MCP stdout must stay clean).
  const bootExe = resolveBootstrapExe();
  const [launchCmd, launchArgs] = bootExe
    ? [bootExe, ['--daemon']]
    : [process.execPath, [LAUNCHER]];
  console.error(`[MCP] launching: ${launchCmd} ${launchArgs.join(' ')}`);
  spawn(launchCmd, launchArgs, {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  }).unref();
  console.error(`[MCP] Waiting for bridge at ${BRIDGE_URL}...`);
  await waitForBridgeHealth(60000);
  console.error('[MCP] Bridge launched successfully');
}

// ─── Start ───────────────────────────────────────────────────

async function main() {
  await ensureBridgeRunning();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Empir3 Browser Bridge MCP server running');
}

main().catch((e) => {
  console.error('[MCP] Fatal:', e);
  process.exit(1);
});
