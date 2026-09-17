import { CONTROL_LIMIT_DEFS } from './control-limits.js';
import desktopCoreContract from './desktop-core-contract.json';
const coreDescription = (name: string) => desktopCoreContract.find(action => action.mcp === name)!.description;
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
 *   browser_click_ref      — Click element by Empir3 ref (e.g., e3_0)
 *   browser_click_xy       — Click viewport coordinates without DOM
 *   browser_emulate_device — Phone viewport + touch + mobile UA (iphone14/pixel7/custom/off)
 *   browser_tap            — Real touch tap at viewport coordinates (zoom-calibrated)
 *   browser_swipe          — Touch swipe/drag gesture between two points
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
 *   desktop_snapshot        — Enumerate UI Automation unique refs for native apps
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
import { AsyncLocalStorage } from 'node:async_hooks';
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

// Mirrors buildSettingsState() in server.ts: custom_llm has something to
// dispatch to when a custom chat provider exists OR a built-in API provider
// (OpenRouter, Groq, …) has a key saved in the chat config. The Permissions
// page uses that rule to show the toggle, so tools/list must use it too or
// an "enabled" tool silently never reaches the inventory.
function readChatConfigFile(): any {
  try {
    const file = join(homedir(), '.empir3-bridge', 'config.json');
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function hasAnyCustomProvider(): boolean {
  const settings = readBridgeSettingsFile();
  const custom = Array.isArray(settings?.customProviders) ? settings.customProviders : [];
  if (custom.some((p: any) => !p?.kind || p.kind === 'chat')) return true;
  const apiKeys = readChatConfigFile()?.apiKeys;
  return !!apiKeys && typeof apiKeys === 'object' && Object.values(apiKeys).some((v) => typeof v === 'string' && v.trim());
}

// ─── Helpers ─────────────────────────────────────────────────

async function bridgeApi(path: string, method = 'GET', body?: any): Promise<any> {
  const opts: RequestInit = { method, headers: bridgeHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BRIDGE_URL}${path}`, opts);
  if (!res.ok) throw new Error(`Bridge ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const explicitControlTarget = new AsyncLocalStorage<any>();
async function bridgeCommand(cmd: any): Promise<any> {
  if (explicitControlTarget.getStore()) cmd={...cmd,target:explicitControlTarget.getStore()};
  const result = await bridgeApi('/api/command', 'POST', { action: cmd.type, channel: 'mcp', ...cmd });
  // A stopped workflow still has useful receipts. Preserve them, with isError,
  // so the caller knows which actions ran and does not replay completed input.
  if (['control_run','play'].includes(cmd.type) && result.result?.results) return result.result;
  if (cmd.type==='control_run' && result.result?.receipts) return result.result;
  if (!result.ok || result.result?.success === false || result.result?.ok === false) throw new Error(result.error || result.result?.error || 'Command failed');
  return result.result;
}

async function bridgeScreenshot(): Promise<Buffer> {
  // Cap at 1800px wide to stay under Claude's 2000px multi-image limit
  const res = await fetch(`${BRIDGE_URL}/api/screenshot?maxWidth=1800`, { headers: bridgeHeaders(false) });
  if (!res.ok) throw new Error(`Screenshot failed (${res.status}): ${(await res.text()).slice(0, 1000)}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function textResult(text: unknown) {
  const normalized = typeof text === 'string'
    ? text
    : JSON.stringify(text ?? '');
  return { content: [{ type: 'text' as const, text: normalized }] };
}

// Compact by default: pretty-print indentation is 15-30% of every JSON tool
// result, and each result persists in the model's context and is re-billed on
// every subsequent turn — so the whitespace compounds across a long session.
function jsonResult(data: any) {
  return {...textResult(JSON.stringify(data)),...(data?.success===false || data?.ok===false ? {isError:true} : {})};
}

// Screenshot handlers attach the image as its own content block AND used to
// stringify the whole daemon result — which carries the same base64 up to ~6x
// (thumbnail/screenshot/base64 + a duplicating `data` copy) — as the text
// block beside it. Strip any large string values so the text envelope carries
// metadata only; the image rides in the image block. Shape-agnostic so it
// survives daemon payload changes.
function stripBlobs(obj: any, maxLen = 1500): any {
  if (Array.isArray(obj)) return obj.map((v) => stripBlobs(v, maxLen));
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      out[k] = typeof v === 'string' && v.length > maxLen
        ? `[omitted ${v.length}-char blob]`
        : stripBlobs(v, maxLen);
    }
    return out;
  }
  return obj;
}

// ─── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: 'empir3-browser',
  version: SERVER_VERSION,
});

const controlTargetSchema=z.object({surface:z.enum(['browser','desktop']),tabId:z.string().optional(),windowHandle:z.number().int().positive().optional()}).describe('Exact tabId from browser_tab_state or windowHandle from desktop_snapshot.');
// On input primitives `target` is a GUARD, not a selector: the call fails with
// target_not_current unless that tab is already the current agent-controlled
// tab (or that window is foreground). Switch first with browser_tab_focus
// action:"control" / bridge_control_activate. Saying so in the schema stops
// agents from reading "tabId" as "act on this tab".
const guardTargetSchema=controlTargetSchema.describe('Optional safety guard, NOT a tab selector: the action runs only if this exact tabId (from browser_tab_state) is already the current agent-controlled tab, or this windowHandle is the foreground window; otherwise it fails with target_not_current and nothing is dispatched. To act on a different tab, switch first with browser_tab_focus action:"control" or bridge_control_activate.');
// Add a backward-compatible exact-target guard to input primitives. The daemon
// checks ownership, focus and native foreground identity at the input boundary.
const targetableTools=new Set(['browser_navigate','browser_click','browser_click_ref','browser_click_xy','browser_type','browser_type_ref','browser_press','browser_scroll','browser_evaluate','browser_refresh','browser_tap','browser_swipe','desktop_click','desktop_hover','desktop_drag','desktop_click_ref','desktop_hover_ref','desktop_type','desktop_key','desktop_scroll']);
const registerTool=server.tool.bind(server);
(server as any).tool=(name:string,description:string,schema:any,handler:any)=>{
  if(!targetableTools.has(name))return (registerTool as any)(name,description,schema,handler);
  return (registerTool as any)(name,description,{...schema,target:guardTargetSchema.optional()},(params:any,extra:any)=>explicitControlTarget.run(params.target,()=>handler(params,extra)));
};
const controlLocatorSchema=z.object({ref:z.string().optional(),selector:z.string().optional(),role:z.string().optional(),name:z.string().optional(),automationId:z.string().optional(),runtimeId:z.string().optional()});
const controlConditionSchema=z.object({kind:z.enum(['exists','absent','value','text','checked','expanded','url']),locator:controlLocatorSchema.optional().describe('Defaults to this step\'s locator. Supply a locator for a different control or a standalone wait. URL conditions need no locator.'),equals:z.union([z.string(),z.boolean()]).optional(),contains:z.string().optional()});
server.tool('bridge_control_catalog','Discover core and advanced tools, exact target examples, device support and enabled flags. All models may use either section.',{},async()=>jsonResult(await bridgeCommand({type:'control_catalog'})));
server.tool('bridge_control_activate','Explicitly hand a browser tab to the agent or bring an observed native window forward. success:true means the switch was VERIFIED (the bridge re-read its tab list and the requested tab is current: result.switched + result.tab.bridgeCurrent); an unverified switch returns activation_unverified instead of a hollow success. Observe again before input; never use activation to fight a user takeover.',{target:controlTargetSchema},async params=>jsonResult(await bridgeCommand({type:'control_activate',...params})));
server.tool('browser_tab_open','Open a separate agent-controlled tab. Returns its exact target; preserves existing tabs. Use for tests and independent work.',{url:z.string()},async params=>jsonResult(await bridgeCommand({type:'tab_open',...params})));
server.tool('browser_tab_close','Close the exact current agent-controlled tab. `target` must name the tab that is ALREADY current (it is a guard, not a selector): closing another tab fails with target_not_current — switch to it with browser_tab_focus action:"control" first. Hand a user-owned tab back with explicit activation first. Other tabs stay open.',{target:controlTargetSchema},async params=>jsonResult(await bridgeCommand({type:'tab_close',...params})));
server.tool('bridge_control_status','Read current owner, action, target, waiting/verified state and user pause. Resume is available in the local Bridge panel.',{},async()=>jsonResult(await bridgeCommand({type:'control_status'})));
server.tool('bridge_control_observe','Observe one exact window or browser tab. Native windows return accessible controls plus a focused JPEG by default; image coordinates include explicit origin and scale. Use image:false for fast text-only observation. Browser observations can be large (full controls array + page text, tens of thousands of characters on a settings page): pass compact:true to drop empty fields and cap text at 1000 chars, and maxElements to cap the controls; the result reports controlCount and truncated so you can widen deliberately. For interactive refs only, browser_snapshot is cheaper.',{target:controlTargetSchema,image:z.boolean().optional(),maxWidth:z.number().min(320).max(2560).optional(),maxElements:z.number().min(1).max(500).optional().describe('Cap on controls returned (browser and native). Default: the Control limits browserElements / nativeElements.'),compact:z.boolean().optional().describe('Browser targets: omit null/false/empty fields and cap text at 1000 characters. Recommended for complex pages.')},async params=>{
  const result=await bridgeCommand({type:'control_observe',...params});
  const content:any[]=[{type:'text',text:JSON.stringify(result)}];
  if(result.image?.path&&existsSync(result.image.path))content.push({type:'image',data:readFileSync(result.image.path).toString('base64'),mimeType:result.image.mimeType});
  return {content};
});
server.tool('bridge_control_run','Run declarative steps against one explicit target within the current Control limits. Read bridge_control_catalog for the active budgets (32 steps by default). Supports core semantic actions and advanced conditional batches. Each step retains its permission gate. expect waits for actual state; when conditionally skips a step. Stops on first failure, never retries input. Native select targets an observed selectable item; browser select uses an option value. Advanced scripting remains available through existing tools.',{
  target:controlTargetSchema,owner:z.string().max(64).optional(),timeoutMs:z.number().min(1).max(CONTROL_LIMIT_DEFS.planTimeoutMs.max).optional(),
  steps:z.array(z.object({action:z.enum(['observe','click','fill','select','check','expand','press','scroll','drag','navigate','wait']),locator:controlLocatorSchema.optional(),value:z.union([z.string(),z.boolean()]).optional(),expect:controlConditionSchema.optional(),when:controlConditionSchema.optional(),timeoutMs:z.number().min(0).max(CONTROL_LIMIT_DEFS.stepTimeoutMs.max).optional(),image:z.boolean().optional(),keys:z.array(z.string()).optional(),key:z.string().optional(),url:z.string().optional(),x:z.number().optional(),y:z.number().optional(),toX:z.number().optional(),toY:z.number().optional(),clicks:z.number().optional(),durationMs:z.number().optional()})).min(1).max(CONTROL_LIMIT_DEFS.planSteps.max),
},async params=>jsonResult(await bridgeCommand({type:'control_run',...params})));
server.tool('bridge_control_diagnostics','Return a compact local diagnostic report with redacted action history and runtime information. Images are opt-in in the local Report a problem panel. Nothing is automatically sent.',{},async()=>jsonResult(await bridgeCommand({type:'control_diagnostics'})));

// ── Status ───────────────────────────────────────────────────

server.tool(
  'browser_status',
  'Check browser bridge and Empir3 connection status. Note: these browser_* tools drive ONE shared Chrome tab. To run multiple agents each on their own browser in parallel, use bridge_scale (up/status/down).',
  {},
  async () => {
    try {
      const status = await bridgeApi('/api/status');
      // Compact summary by default. The raw /api/status blob carries an
      // unbounded page-visit history (`pages`, appended to on every navigation
      // with no cap) plus the full auth-user object — both would persist and
      // re-bill on every later turn. Keep only the fields callers actually use.
      const compact = {
        running: status?.running,
        browserRunning: status?.browserRunning ?? status?.running,
        version: status?.version,
        currentUrl: status?.currentUrl,
        pageCount: status?.pageCount ?? undefined,
        visibilityState: status?.visibilityState,
        hasFocus: status?.hasFocus,
        visible: status?.visible,
        overlayInjected: status?.overlayInjected,
        empir3Connected: status?.empir3Connected,
        empir3Environment: status?.empir3Environment,
        empir3Agent: status?.empir3Agent,
        empir3User: status?.empir3User
          ? { email: status.empir3User.email, role: status.empir3User.role, emailVerified: status.empir3User.emailVerified }
          : null,
      };
      return jsonResult(compact);
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
  'Remove any legacy page-world overlay and return the trusted localhost control URL.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'overlay_reinject', reason: 'mcp' });
    return jsonResult(result);
  }
);

server.tool(
  'bridge_setup_status',
  'Report the first-use desktop setup checklist: trusted control surface, monitor detection, saved click calibration, recording/playback readiness, and saved completion state.',
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
    return jsonResult(result);
  }
);

// ── Click ────────────────────────────────────────────────────

server.tool(
  'browser_tab_state',
  'List bridge browser tabs and report which tab is agent-controlled versus user-focused. `agentTab` is the single agent-controlled tab (null when none); `agentTabs` lists per-agent tabs opened through browser_tab_open and is empty otherwise. Each tab carries agentControlled / userFocused / bridgeCurrent, all derived from the same read. Use this before switching tab control so browsing by the user does not interrupt an agent tab.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'browser_tab_state' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_tab_focus',
  'Explicitly mark a browser tab as the user focus or hand control of that tab to the agent. action:"control" is VERIFIED: success:true only when the bridge re-read its tab list and the tab is current (result.switched, result.tab.bridgeCurrent); otherwise activation_unverified. This never happens automatically just because the user opens a new tab.',
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
    const result = await bridgeCommand({ type: 'click', selector });
    return jsonResult(result);
  }
);

server.tool(
  'browser_click_ref',
  'Click an element by Empir3 ref (e.g., e3_0). Use browser_snapshot first to see available refs; refs are e<snapshot>_<index> and are only valid for the snapshot that produced them.',
  { ref: z.string().describe('Element ref from the most recent browser_snapshot (e.g., "e3_0")') },
  async ({ ref }) => {
    const result = await bridgeCommand({ type: 'click_ref', ref });
    return jsonResult(result);
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
    const result = await bridgeCommand({ type: 'click_xy', x, y });
    return jsonResult(result);
  }
);

// ── Mobile emulation ─────────────────────────────────────────

server.tool(
  'browser_emulate_device',
  'Switch the browser tab into a phone viewport (device metrics + touch + mobile user agent). Presets: "iphone14" (390x844), "pixel7" (412x915), "custom" (pass width/height), "off" to restore desktop. The result reports what the page actually measures (`measured`: innerWidth/innerHeight/maxTouchPoints/ontouchstart) and a `consistency` verdict; Chrome binds touch handlers at document creation, so pass reload:true (or call browser_refresh) before relying on touch feature detection — the note says so when needed. While active, click tools automatically use touch taps — RN-Web ignores mouse events in touch environments. Note: still Chrome\'s engine; for real Safari/WebKit rendering use the Playwright mobile-smoke harness.',
  {
    preset: z.string().describe('Device preset: "iphone14", "pixel7", "custom", or "off"'),
    width: z.number().optional().describe('Viewport width in CSS px (custom preset)'),
    height: z.number().optional().describe('Viewport height in CSS px (custom preset)'),
    reload: z.boolean().optional().describe('Reload the page after applying so the document boots with the emulated viewport and touch events bound (recommended).'),
  },
  async ({ preset, width, height, reload }) => {
    const result = await bridgeCommand({ type: 'emulate_device', preset, width, height, reload: reload === true });
    return jsonResult(result);
  }
);

server.tool(
  'browser_tap',
  'Dispatch a real touch tap at viewport coordinates (CSS px). Use in phone-emulation mode where mouse clicks are ignored; coordinates are auto-calibrated against browser zoom.',
  {
    x: z.number().describe('Viewport x coordinate in CSS pixels'),
    y: z.number().describe('Viewport y coordinate in CSS pixels'),
  },
  async ({ x, y }) => {
    await bridgeCommand({ type: 'tap', x, y });
    return textResult(`Tapped: ${x},${y}`);
  }
);

server.tool(
  'browser_swipe',
  'Dispatch a touch swipe/drag gesture from one viewport point to another (CSS px). Scrolls lists, dismisses bottom sheets, drags sliders in phone-emulation mode.',
  {
    x1: z.number().describe('Start x in CSS pixels'),
    y1: z.number().describe('Start y in CSS pixels'),
    x2: z.number().describe('End x in CSS pixels'),
    y2: z.number().describe('End y in CSS pixels'),
    durationMs: z.number().optional().describe('Gesture duration in ms (default 300)'),
  },
  async ({ x1, y1, x2, y2, durationMs }) => {
    await bridgeCommand({ type: 'swipe', x1, y1, x2, y2, durationMs });
    return textResult(`Swiped: ${x1},${y1} → ${x2},${y2}`);
  }
);

// ── Type ─────────────────────────────────────────────────────

server.tool(
  'browser_type',
  'Fill a field by CSS selector, or omit selector to append text to the already-focused field after a screenshot-based click (works inside frames and shadow roots). Focused typing requires an explicit browser target and returns verified:false; inspect the field or its visible result afterward.',
  {
    selector: z.string().optional().describe('CSS selector for a verified fill. Omit only after focusing the intended field; focused typing appends instead of replacing.'),
    text: z.string().describe('Text to type'),
  },
  async ({ selector, text }) => {
    const target = explicitControlTarget.getStore();
    if (!selector && (target?.surface !== 'browser' || !target.tabId)) return jsonResult({success:false,dispatched:false,inputMayHaveOccurred:false,error:'Focused typing requires an explicit browser target from browser_tab_state. Click the intended field first, then verify the result.'});
    const result = await bridgeCommand({ type: 'type', selector, text });
    return jsonResult(result);
  }
);

server.tool(
  'browser_type_ref',
  'Type text into an element by Empir3 ref. Use browser_snapshot first to see available refs.',
  {
    ref: z.string().describe('Element ref from the most recent browser_snapshot (e.g., "e3_0")'),
    text: z.string().describe('Text to type'),
  },
  async ({ ref, text }) => {
    const result = await bridgeCommand({ type: 'type_ref', ref, text });
    return jsonResult(result);
  }
);

// ── Press ────────────────────────────────────────────────────

server.tool(
  'browser_press',
  'Press a keyboard key (e.g., Enter, Tab, Escape, Control+a)',
  { key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Control+a")') },
  async ({ key }) => {
    const result = await bridgeCommand({ type: 'press', text: key });
    return jsonResult(result);
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
  'Capture desktop screenshots in DPI-aware physical coordinates. Pass `monitor` for a whole display (all/primary/DISPLAY1/...), `region` for a native-res crop, `grid:true` to overlay coordinate gridlines + labels, and/or `marker:{x,y}` to draw a high-visibility crosshair + circle at proposed click coordinates BEFORE clicking. The marker is the "verify before clicking" loop: pick coords from the grid, re-screenshot with marker={x,y} to confirm it lands on the target, then desktop_click. Saves one wrong click per attempt vs. eyeballing. `detail` trades image resolution against token cost — default "low" is a cheap downscaled shot; pass "high" (or "max") when you need to read small text or a specific setting.',
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
    detail: z.enum(['low', 'high', 'max']).optional().describe('Image detail vs token cost. The returned screenshot persists in context and is re-billed on every later turn, so default to the cheapest that works. "low" (default) — downscaled ~1000px JPEG, good for locating things on screen. "high" — ~1600px JPEG, readable small text / settings labels. "max" — untouched native-resolution capture, largest; use only when "high" is not enough. For pixel-exact inspection of a tiny area, prefer desktop_screenshot_zoom.'),
  },
  async ({ monitor, region, grid, marker, detail }) => {
    // Pass `monitor` through verbatim (undefined when the caller omitted it) so
    // the daemon can distinguish an explicit monitor from the default and let
    // an explicit monitor win over an active focus region. The daemon defaults
    // to 'all' when neither monitor, region, nor a focus scope applies.
    const result = await bridgeCommand({ type: 'desktop_screenshot', monitor, region, grid, marker, detail });
    // Prefer the daemon's detail-adjusted image (displayPath/displayMime); fall
    // back to the native path for older daemons that don't set them.
    const path = result.displayPath || result.stitchedPath || result.captures?.[0]?.path;
    if (!path) return jsonResult(stripBlobs(result));
    const buf = readFileSync(path);
    const mime = result.displayMime || (/\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png');
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(stripBlobs(result)) },
        { type: 'image' as const, data: buf.toString('base64'), mimeType: mime },
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
  coreDescription('desktop_drag'),
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
  coreDescription('desktop_snapshot'),
  {
    scope: z.enum(['foreground', 'all-windows']).optional().describe('"foreground" (default) walks only the active window; "all-windows" enumerates every visible top-level window.'),
    maxElements: z.number().optional().describe('Cap on returned elements. Default 200, max 500.'),
    windowHandle: z.number().int().positive().optional().describe('Observe this exact window handle instead of the foreground window.'),
  },
  async ({ scope, maxElements, windowHandle }) => {
    const result = await bridgeCommand({ type: 'desktop_snapshot', scope: scope || 'foreground', maxElements: maxElements ?? 200, windowHandle });
    return jsonResult(result);
  }
);

server.tool('desktop_type', coreDescription('desktop_type'),
  { text: z.string().min(1).max(CONTROL_LIMIT_DEFS.textCharacters.max), ref: z.string().optional() },
  async (params) => jsonResult(await bridgeCommand({ type: 'desktop_type', ...params })));
server.tool('desktop_key', coreDescription('desktop_key'),
  { keys: z.array(z.string()).min(1).max(8) },
  async (params) => jsonResult(await bridgeCommand({ type: 'desktop_key', ...params })));
server.tool('desktop_scroll', coreDescription('desktop_scroll'),
  { clicks: z.number().min(-100).max(100), x: z.number().optional(), y: z.number().optional() },
  async (params) => jsonResult(await bridgeCommand({ type: 'desktop_scroll', ...params })));

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
  coreDescription('desktop_click_ref'),
  {
    ref: z.string().describe('Exact ref copied from the latest desktop_snapshot; do not invent one.'),
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
    ref: z.string().describe('Exact ref copied from the latest desktop_snapshot; do not invent one.'),
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
    ref: z.string().optional().describe('A browser_snapshot element ref (e.g. "e3_0") — resolved via [data-empir3-ref].'),
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
  'browser_accuracy_lab_sweep',
  'Run the bundled Accuracy Lab with Bridge-owned Windows desktop clicks. Returns one trusted receipt per target and fails honestly when physical input or calibration is unavailable. This tool only runs on the local /accuracy-lab page.',
  {
    reset: z.boolean().optional().describe('Reset the lab before the sweep. Default: true.'),
  },
  async ({ reset }) => {
    const result = await bridgeCommand({ type: 'accuracy_lab_sweep', reset });
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
  'Open, close, or check the movable desktop toolbar widget. The toolbar exposes focus region, release focus, trusted local chat, recording, playback, saved recording selection, and quick calibration on the monitor where the toolbar sits.',
  {
    action: z.enum(['show', 'hide', 'status']).optional().describe('show opens the toolbar, hide closes it, status reports whether it is running. Default: show.'),
  },
  async ({ action }) => {
    const result = await bridgeCommand({ type: 'desktop_toolbar', action: action || 'show' });
    return jsonResult(result);
  }
);

server.tool(
  'desktop_window',
  'List native Windows windows, then manage one observed unique title. list/active are read-only. Restore a minimized or maximized window before resize; resize reports actual verified bounds. Focus is verified, while minimize/maximize/restore/close are requests: observe the resulting window state. Close may show an unsaved-work prompt. Other platforms return an explicit capability refusal.',
  {
    action: z.enum(['list','active','focus','minimize','maximize','restore','resize','close']),
    title: z.string().optional().describe('Observed unique window title required for changes; optional title filter for list. Ambiguous matches are refused.'),
    x: z.number().optional().describe('Physical virtual-screen left coordinate for resize; negative monitor coordinates are valid.'),
    y: z.number().optional().describe('Physical virtual-screen top coordinate for resize.'),
    width: z.number().positive().optional().describe('Requested width in physical pixels; inspect actual bounds afterward.'),
    height: z.number().positive().optional().describe('Requested height in physical pixels.'),
  },
  async ({ action, ...params }) => jsonResult(await bridgeCommand({ type:'desktop:window', action, params }))
);

server.tool(
  'desktop_app',
  'Manage Windows applications through the Bridge. list summarizes up to 30 application names with one representative process each; use is_running with a name to inspect matching processes. launch opens the named app. kill requests termination and can lose unsaved work: prefer an exact observed pid, read success/verifiedExited and any failed entries, and verify a fresh observation. Windows can deny privileged processes such as Magnifier; follow the returned recovery. This tool never requests elevation.',
  {
    action: z.enum(['list','is_running','launch','kill']),
    name: z.string().optional().describe('Executable/app name, such as notepad.exe; required for launch/is_running. A kill by name can affect every matching process; prefer pid.'),
    pid: z.number().int().positive().optional().describe('Exact process id from a fresh list, for kill only. Protected processes are refused.'),
  },
  async ({ action, ...params }) => jsonResult(await bridgeCommand({ type:'desktop:app', action:action==='list'?'list_running':action, params }))
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
        { type: 'text' as const, text: JSON.stringify(stripBlobs(result)) },
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
  'Get main-document element refs. Refs look like e3_0 (e<snapshot>_<index>) and are valid for this snapshot only; use browser_click_ref and browser_type_ref. Frames and shadow-root controls can be missing: use browser_screenshot, coordinate clicks and focused browser_type for those. Much cheaper than screenshots.',
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

// ── Page audit / verified check batches ─────────────────────
// Both tools have Permissions-page rows (browser_audit_page read, on by
// default; browser_run_checks interact, off by default). They were reachable
// only through the Empir3 relay, so an MCP client saw them "enabled" on the
// page yet absent from tools/list. Registered here; the daemon applies the
// same call-time gating as every other tool.

server.tool(
  'browser_audit_page',
  'Wait for the current page to settle, then return a compact audit: readyState, document size, text length, network resource count, console errors and other page facts. Read-only; use it to confirm a page finished loading before acting.',
  {
    maxWaitMs: z.number().int().min(0).max(10_000).optional().describe('Max time to wait for the page to settle (default 4000).'),
    stableForMs: z.number().int().min(250).max(2_000).optional().describe('How long the page facts must stay unchanged to count as settled (default 750).'),
    maxTextChars: z.number().int().positive().optional().describe('Cap on page text characters included (default 8000).'),
  },
  async (params) => jsonResult(await bridgeCommand({ type: 'audit_page', ...params })),
);

server.tool(
  'browser_run_checks',
  'Run a small batch of verified browser steps (snapshot, text, click, type, press, wait, …) in order and return per-step receipts; stops on the first failure unless stopOnFailure:false. Each step retains its own permission gate. Use bridge_control_run for expect/when conditions.',
  {
    steps: z.array(z.object({
      action: z.string().describe('Step action, e.g. "snapshot", "text", "click", "click_ref", "type_ref", "press", "wait".'),
      params: z.record(z.any()).optional().describe('Parameters for that action (selector, ref, text, key, ms, …).'),
      label: z.string().max(120).optional(),
    })).min(1).describe('Ordered steps.'),
    stopOnFailure: z.boolean().optional().describe('Default true.'),
  },
  async (params) => jsonResult(await bridgeCommand({ type: 'run_checks', ...params })),
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
  'Send a message to the user through the trusted localhost Bridge chat',
  { message: z.string().describe('Message to display in the trusted Bridge chat') },
  async ({ message }) => {
    await bridgeCommand({ type: 'chat', message });
    return textResult(`Sent to browser: ${message}`);
  }
);

server.tool(
  'browser_read_chat',
  'Read recent messages from the trusted localhost Bridge chat',
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
  'Start recording trusted main-page browser actions and verified Bridge selections with persistent selectors. No page overlay is needed. Review limitations and stop/save before replay.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'record_start' });
    return jsonResult(result);
  }
);

server.tool(
  'browser_record_stop',
  'Stop recording and save. Returns the recording file name and action count.',
  { name: z.string().optional().describe('Name for the recording (default: auto-generated)') },
  async ({ name }) => {
    const result = await bridgeCommand({ type: 'record_stop', text: name });
    return jsonResult(result);
  }
);

server.tool(
  'browser_play',
    'Replay a reviewed saved recording. Verified v2 procedures use selectors and state checks, stop on failure and return per-step receipts. Inspect completed receipts before retrying. Legacy recordings retain ref/coordinate fallback.',
  {
    recording: z.string().describe('Recording name to play'),
      speed: z.number().min(0.1).max(10).optional().describe('Legacy recording speed multiplier (default 1). Verified v2 procedures run as state becomes ready; this multiplier does not add or remove waits.'),
    variables: z.record(z.string()).optional().describe('Variable substitutions (e.g., {"EMAIL": "test@test.com"})'),
  },
  async ({ recording, speed, variables }) => {
    const result = await bridgeCommand({ type: 'play', recording, speed: speed || 1, variables: variables || {} });
      if (result.mode === 'verified-control-recording') return jsonResult(result);
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

server.tool('browser_dialog', 'Read or answer a website alert, confirmation or prompt on one exact tab. Read status, review the message, then pass its dialog id to accept/dismiss. Never repeats the triggering input. Verify the page afterward.', {
  target: z.object({ surface: z.literal('browser'), tabId: z.string().min(1) }),
  action: z.enum(['status','accept','dismiss']).default('status'),
  dialogId: z.string().optional().describe('The id returned by status; required for accept/dismiss.'),
  promptText: z.string().optional().describe('Text when accepting a prompt.')
}, async ({target,action,dialogId,promptText}) => jsonResult(await bridgeCommand({type:'dialog',target,dialogAction:action,dialogId,promptText})));

server.tool(
  'browser_refresh',
  'Refresh the current browser page',
  {},
  async () => {
    return jsonResult(await bridgeCommand({ type: 'refresh' }));
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
// codex / grok / claude / agy. Each run is gated by that CLI's lend
// toggle (the bridge refuses a model that isn't lent). The driving agent
// orchestrates — this is just the primitive that lends the seat.
server.tool(
  'cli_run',
  'Run another model\'s lent CLI with a prompt and get its text response back — so you (the driving agent) can pull a second LLM into a task: have Codex build something, Grok draft a spec, Claude review, etc. The bridge handles each CLI\'s invocation quirks. Each model must be lent (toggle on the bridge\'s API & CLIs pane) or the run is refused. Spends the user\'s CLI subscription/quota. For a long run pass background:true and poll cli_run_status.',
  {
    model: z.enum(['codex', 'grok', 'claude', 'agy']).describe('Which lent CLI to run.'),
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
  'Discover which lent CLIs you can drive via cli_run RIGHT NOW. Returns one row per model (codex / grok / claude / agy) with available (installed), lent (owner toggled it on), authenticated (signed in), ready (all three), and blocker (cli_not_installed / not_lent / not_signed_in / null). Call this FIRST to route a task to a model that will actually run, instead of calling cli_run and getting a "not lent" refusal. For image/video use higgsfield_* instead.',
  {},
  async () => {
    const result = await bridgeCommand({ type: 'cli_status' });
    return jsonResult(result);
  }
);

// ─── Multi-bridge scaling ────────────────────────────────────

server.tool(
  'bridge_scale',
  'Run EXTRA isolated bridge instances so multiple agents can each drive their OWN browser in parallel — one agent per Chrome, zero cross-talk. A single bridge tracks ONE active tab shared by all clients, so two agents on it fight over one tab; scaling gives each its own instance (own ports + Chrome profile + active-tab pointer). Instance 1 is the primary bridge THESE browser_* tools drive; it is never launched or killed here. Actions: "up" (count 2-4) ensures that many total instances run and returns each extra\'s BRIDGE_URL; "status" lists all instances; "down" stops extras. Drive an extra instance from the CLI (`BRIDGE_URL=<url> npx tsx src/cli.ts <cmd>`) or register a 2nd MCP server with env.BRIDGE_URL set to that URL. Extras run local-only (no Empir3 relay). Capped at 4 total (each is a full Chrome).',
  {
    action: z.enum(['up', 'status', 'down']).optional().describe('up = start extras up to `count` total instances; status = list every instance; down = stop extras. Default: status.'),
    count: z.number().optional().describe('For "up": total instances to run (2-4, capped at 4). For "down": highest extra index to stop (omit to stop instance 2). Ignored for status.'),
  },
  async ({ action, count }) => {
    const result = await bridgeCommand({ type: 'bridge_scale', action: action || 'status', params: { action: action || 'status', count } });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let res = await fetch(`${BRIDGE_URL}/api/health`, { signal: controller.signal, headers: bridgeHeaders(false) });
    if (res.status === 404) res = await fetch(`${BRIDGE_URL}/api/status`, { signal: controller.signal, headers: bridgeHeaders(false) });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    // `/api/status.running` describes the dedicated Bridge browser, not the
    // Bridge service itself. A healthy signed-in console may intentionally be
    // idle with `running: false` until the user launches its browser. Treat the
    // service identity (or an explicit ok response) as the health signal so
    // MCP does not try to start a competing desktop instance.
    return body?.engine === 'empir3-bridge' || body?.ok === true;
  } catch {
    return false;
  } finally { clearTimeout(timer); }
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

  // An alternate endpoint identifies an already configured isolated instance.
  // Starting the default launcher here can silently attach its browser/profile
  // to a different instance. Never replace an explicit destination with that.
  if (process.env.BRIDGE_URL) {
    const endpoint = new URL(BRIDGE_URL);
    const isPrimary = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      && endpoint.protocol === 'http:' && endpoint.port === '3006'
      && !endpoint.username && !endpoint.password && ['/', ''].includes(endpoint.pathname);
    if (!isPrimary) throw new Error(`The configured Bridge is unavailable at ${BRIDGE_URL}. Start that Bridge instance and reconnect this MCP client. The primary Bridge was left unchanged.`);
  }

  console.error('[MCP] Bridge not running — auto-launching...');

  // Prod: launch the resolved bootstrap exe with --daemon (it brings up the
  // tray → daemon). The old `node <SRC>/launch.js` form is dev-only — launch.js
  // is not shipped in the payload — so use it only when no bootstrap exe
  // resolves. All logging here is stderr (MCP stdout must stay clean).
  const bootExe = resolveBootstrapExe();
  const desktopLaunchArgs = ['--daemon'];
  // The packaged Linux CI smoke explicitly opts out of Chromium sandboxing.
  // Carry that opt-in to the detached tray process; real launches stay sandboxed.
  if (process.platform === 'linux' && process.argv.includes('--no-sandbox')) desktopLaunchArgs.push('--no-sandbox');
  const [launchCmd, launchArgs] = bootExe
    ? [bootExe, desktopLaunchArgs]
    : [process.execPath, [LAUNCHER]];
  const launchEnv = { ...process.env };
  // The packaged MCP shim itself runs Electron as Node. Never leak that mode
  // into the desktop/tray child or Electron will treat --daemon as a Node
  // invocation and exit before the managed Bridge can start.
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  console.error(`[MCP] launching: ${launchCmd} ${launchArgs.join(' ')}`);
  spawn(launchCmd, launchArgs, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: launchEnv,
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
