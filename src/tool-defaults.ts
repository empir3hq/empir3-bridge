/**
 * Per-tool kill-switch defaults — single source of truth for which bridge
 * tools are enabled when Claude is talking through the overlay.
 *
 * Read tools default ON (page inspection is safe). Interact tools default
 * OFF — the user has to opt in before Claude can click/type on pages they
 * have open. Same mental model as Anthropic computer-use, macOS
 * Accessibility, or Chrome extension permissions: explicit user consent,
 * no AI judgment.
 *
 * The chat loop in `chat.ts` filters the tool list it sends to the model
 * based on `enabledTools` in config — disabled tools never appear in the
 * model's tool inventory, so it can't even hallucinate a call to one.
 * Defense-in-depth: dispatcher also short-circuits if a disabled tool
 * somehow lands on the wire.
 *
 * `browser_evaluate` is a special case: unrestricted JS eval is effectively
 * root on the current page. Defaults OFF until the read-only sandbox lands
 * (separate task — AST check that blocks DOM mutation, storage writes,
 * fetch/XHR). Power users opt in via /settings.
 */

export type ToolGroup = 'read' | 'navigate' | 'interact' | 'desktop' | 'recordings' | 'eval' | 'advisor' | 'higgsfield' | 'providers' | 'clis';

export interface ToolMeta {
  name: string;
  group: ToolGroup;
  defaultEnabled: boolean;
  blurb: string;
}

export const TOOL_META: ToolMeta[] = [
  // ── Advisor (discoverability — always on) ────────────────────
  { name: 'bridge_tool_advisor', group: 'advisor', defaultEnabled: true,
    blurb: 'Discoverability helper. Pass `intent` as a one-line description of what you are trying to do (e.g. "click a small icon in Photoshop", "fill in a web form", "guide the user through a tutorial") and the bridge returns the matching tool family, rationale, and example sequence. Call this FIRST when unsure which of the 47 tools fits.' },
  { name: 'bridge_setup_status', group: 'advisor', defaultEnabled: true,
    blurb: 'Report the first-use desktop setup checklist: overlay injection, monitor detection, saved click calibration, and recording/playback readiness.' },
  { name: 'bridge_setup_save', group: 'advisor', defaultEnabled: true,
    blurb: 'Save the first-use desktop setup checklist result to bridge-settings.json so MCP and empir3 agents can confirm the device was calibrated.' },
  { name: 'bridge_overlay_reinject', group: 'advisor', defaultEnabled: true,
    blurb: 'Repair command for the browser overlay. Re-injects the chat/recording overlay into current and future bridge browser tabs, then verifies that an overlay client connected.' },
  { name: 'bridge_reliability_status', group: 'advisor', defaultEnabled: true,
    blurb: 'Show bridge health, enabled tools, and recent action receipts for debugging failed or uncertain tool calls.' },
  { name: 'bridge_reliability_smoke', group: 'advisor', defaultEnabled: true,
    blurb: 'Run the built-in bridge reliability smoke checks.' },
  { name: 'bridge_action_log', group: 'advisor', defaultEnabled: true,
    blurb: 'Read recent bridge action receipts for debugging failed or uncertain tool calls.' },
  { name: 'bridge_safety_status', group: 'advisor', defaultEnabled: true,
    blurb: 'Show whether browser write controls, desktop controls, eval, or recordings are currently enabled.' },
  { name: 'bridge_revoke_control', group: 'advisor', defaultEnabled: true,
    blurb: 'Immediately disable browser interact, desktop, eval, and recording tools in bridge settings.' },

  // ── Read (page inspection, no side effects) ──────────────────
  { name: 'browser_status',     group: 'read', defaultEnabled: true,
    blurb: 'Check whether the browser bridge is connected and what URL is open.' },
  { name: 'browser_text',       group: 'read', defaultEnabled: true,
    blurb: 'Read the page as plain text. Cheapest way to see what is on the page — use before screenshotting when you only need the words.' },
  { name: 'browser_snapshot',   group: 'read', defaultEnabled: true,
    blurb: 'PRIMARY tool for web work. Returns the page accessibility tree with element refs (e0, e1, …) including role, name, bounds. Call before browser_click_ref / browser_type_ref. Refs are invalidated when the page changes.' },
  { name: 'browser_screenshot', group: 'read', defaultEnabled: true,
    blurb: 'Visual confirmation of the current viewport (JPEG). Use after a write to verify state. Prefer browser_snapshot when you actually need to act on something — refs are far more reliable than pixels.' },
  { name: 'browser_tab_state', group: 'read', defaultEnabled: true,
    blurb: 'List bridge browser tabs and report which one is agent-controlled versus user-focused.' },
  { name: 'desktop_monitors', group: 'read', defaultEnabled: true,
    blurb: 'List DPI-aware physical desktop monitor bounds, including negative coordinates.' },
  { name: 'desktop_screenshot', group: 'read', defaultEnabled: true,
    blurb: 'Capture desktop pixels. Pass `monitor` for a whole display, `region:{x,y,width,height}` for a tight crop at native resolution, or `grid:true` to overlay a coordinate grid. When an agent-focus region is active, defaults to the focus crop with a focus-relative coord grid (top-left = 0,0) — read targets straight off the image and pass to click/pointer with space:"focus". Pass `grid:false` to opt out.' },
  { name: 'desktop_screenshot_zoom', group: 'read', defaultEnabled: true,
    blurb: 'Take a tight native-resolution crop centered on (x, y) with a small marker — pixel-accurate inspection of a small area before clicking or pointing.' },
  { name: 'desktop_cursor_position', group: 'read', defaultEnabled: true,
    blurb: 'Read the current physical cursor position.' },
  { name: 'desktop_snapshot', group: 'read', defaultEnabled: true,
    blurb: 'Enumerate visible interactive elements (buttons, menus, inputs) on the desktop via UI Automation. Returns refs d0..dN for use with desktop_click_ref. Best on native Win32/UWP apps; CEF/Electron apps fall back to vision-coord targeting.' },
  { name: 'desktop_snapshot_som', group: 'read', defaultEnabled: true,
    blurb: 'Set-of-Mark snapshot: enumerate elements inside the agent-focus region (or explicit region) and draw numbered colored boxes on a screenshot. Agent picks the number off the image and calls desktop_click_ref. Removes pixel-coordinate guessing for native Win32 apps.' },
  { name: 'desktop_focus_status', group: 'read', defaultEnabled: true,
    blurb: 'Report whether the user has set an agent-focus region (via desktop_select_region) and how much TTL remains.' },
  { name: 'desktop_pointer_status', group: 'read', defaultEnabled: true,
    blurb: 'Report whether the agent ghost cursor is currently shown, its position and label.' },
  { name: 'desktop_calibration_status', group: 'read', defaultEnabled: true,
    blurb: 'Return the persisted desktop click calibration offset (or null if uncalibrated).' },

  // ── Navigate (visible side effect, browser-scoped) ───────────
  { name: 'browser_navigate', group: 'navigate', defaultEnabled: true,
    blurb: 'Open a URL in the bridge browser tab.' },
  { name: 'browser_scroll',   group: 'navigate', defaultEnabled: true,
    blurb: 'Scroll the page by a number of pixels.' },
  { name: 'browser_refresh',  group: 'navigate', defaultEnabled: true,
    blurb: 'Reload the current page.' },

  // ── Interact (writes input to pages you have open) ───────────
  { name: 'browser_tab_focus', group: 'navigate', defaultEnabled: true,
    blurb: 'Explicitly mark a tab as user focus or hand a tab to the agent by target id. Does not auto-switch when the user merely opens a tab.' },
  { name: 'browser_click',      group: 'interact', defaultEnabled: false,
    blurb: 'Click an element by CSS selector. Use only when you already have a stable selector (e.g. from your own page). For everything else, prefer browser_click_ref after browser_snapshot.' },
  { name: 'browser_click_ref',  group: 'interact', defaultEnabled: false,
    blurb: 'PREFERRED way to click on a webpage. Pass a ref (e.g. "e5") from the most recent browser_snapshot. Resolves to the element\'s bounds center.' },
  { name: 'browser_click_xy',   group: 'interact', defaultEnabled: false,
    blurb: 'Click viewport coordinates with native browser mouse events. Last resort for canvas / SVG / iframe content the DOM can\'t describe.' },
  { name: 'browser_type',       group: 'interact', defaultEnabled: false,
    blurb: 'Type text into a form field by CSS selector. Prefer browser_type_ref unless you have a stable selector.' },
  { name: 'browser_type_ref',   group: 'interact', defaultEnabled: false,
    blurb: 'PREFERRED way to type on a webpage. Pass a ref from browser_snapshot (input/textbox role). Uses the native value setter + input/change events — works with React, Vue, plain HTML.' },
  { name: 'browser_press',      group: 'interact', defaultEnabled: false,
    blurb: 'Press a keyboard key in the active page (Enter, Tab, Escape, Ctrl+A, etc). Use after typing to submit, after focus to navigate, or to dismiss modals.' },
  { name: 'browser_highlight',  group: 'interact', defaultEnabled: false,
    blurb: 'Briefly outline an element on the page. Use to signal to the user where you are looking ("the email field is here") without taking action.' },
  { name: 'desktop_click',      group: 'desktop', defaultEnabled: false,
    blurb: 'Click physical desktop coordinates. Prefer desktop_click_ref (via desktop_snapshot_som) or desktop_click_cell — they survive screen movement and DPI changes. Use raw coords only when you have a reliable pixel target.' },
  { name: 'desktop_hover',      group: 'desktop', defaultEnabled: false,
    blurb: 'Move the cursor to physical desktop coordinates without clicking. Used for hover-revealed tooltips/menus when no UIA ref exists.' },
  { name: 'desktop_drag',       group: 'desktop', defaultEnabled: false,
    blurb: 'Drag between two physical desktop coordinates. For moving sliders, resizing windows, or dragging files in native apps.' },
  { name: 'desktop_click_ref',  group: 'desktop', defaultEnabled: false,
    blurb: 'PREFERRED way to click in a native desktop app. Pass a ref ("d3") from desktop_snapshot or desktop_snapshot_som. Resolves to the element bounds center and performs a real Win32 click. Refs invalidated by the next snapshot.' },
  { name: 'desktop_hover_ref',  group: 'desktop', defaultEnabled: false,
    blurb: 'Hover over a desktop element by ref from the last desktop_snapshot. Use for hover-revealed tooltips and dropdown menus.' },
  { name: 'desktop_overlay',    group: 'desktop', defaultEnabled: false,
    blurb: 'Toggle a click-through labeled-box overlay on top of the screen showing the elements from the most recent desktop_snapshot. Keys and clicks pass through. Useful for showing the user what the agent sees without blocking them.' },
  { name: 'desktop_select_region', group: 'desktop', defaultEnabled: false,
    blurb: 'Open a fullscreen overlay so the user can drag a rectangle around the area they want help with. Sets an "agent focus" — subsequent desktop_screenshot/desktop_snapshot calls auto-scope to it. 30-minute TTL.' },
  { name: 'desktop_release_focus', group: 'desktop', defaultEnabled: false,
    blurb: 'Clear the current agent-focus region. The on-screen chip disappears and tools revert to whole-monitor/foreground defaults.' },
  { name: 'desktop_pointer_show', group: 'desktop', defaultEnabled: false,
    blurb: 'Show a click-through "ghost cursor" overlay at absolute screen coords. Visual only — the user\'s real mouse is unaffected. Use to draw attention to a spot ("look here") without taking control.' },
  { name: 'desktop_pointer_move', group: 'desktop', defaultEnabled: false,
    blurb: 'Reposition the ghost cursor (or show it if not already visible). Updates at ~25fps.' },
  { name: 'desktop_pointer_pulse', group: 'desktop', defaultEnabled: false,
    blurb: 'Trigger a one-shot expanding ring animation at the ghost cursor — "look HERE now" emphasis.' },
  { name: 'desktop_pointer_hide', group: 'desktop', defaultEnabled: false,
    blurb: 'Hide the ghost cursor overlay.' },
  { name: 'desktop_calibrate_pointer', group: 'desktop', defaultEnabled: false,
    blurb: 'Run an interactive click calibration: shows the ghost cursor at primary-screen center and asks the user to click it. The delta is saved and applied to every desktop_click afterwards.' },
  { name: 'desktop_click_cell', group: 'desktop', defaultEnabled: false,
    blurb: 'Click a cell of the focus chess-board grid (1-indexed col/row matching the on-screen pill labels). Optional subX/subY for sub-cell offset.' },
  { name: 'desktop_pointer_cell', group: 'desktop', defaultEnabled: false,
    blurb: 'Show the ghost cursor at the center of a focus-grid cell (col, row).' },
  { name: 'desktop_focus_grid', group: 'desktop', defaultEnabled: false,
    blurb: 'Show/hide a click-through on-screen grid overlay on the focus region. Lets the user read the same chess-board labels the agent sees in screenshots — "click cell 8,7" works without screenshot round-trip.' },
  { name: 'desktop_pick_point', group: 'desktop', defaultEnabled: false,
    blurb: 'User clicks inside the focus area to designate a point. Bridge returns the click as focus-relative pixel, absolute pixel, and chess-board cell coords. Best tool for "click HERE" when the user can show you.' },
  { name: 'desktop_click_page', group: 'desktop', defaultEnabled: false,
    blurb: 'Perform a REAL OS click on an element in the bridge\'s own Chrome page, given a CSS selector, snapshot ref, or cssX/cssY. Maps page coords to physical screen pixels automatically (content-window origin + devicePixelRatio + calibration) — use when a page needs a trusted hardware click rather than a synthetic browser_click. Bridge\'s Chrome only.' },
  { name: 'desktop_pointer_page', group: 'desktop', defaultEnabled: false,
    blurb: 'Show the click-through ghost cursor on top of an element in the bridge\'s Chrome page (selector/ref/cssX-cssY). Same page→screen mapping as desktop_click_page but visual-only — "I\'m looking at this button" without clicking.' },
  { name: 'page_to_screen', group: 'read', defaultEnabled: true,
    blurb: 'Inspect-only: resolve a page element (selector/ref/cssX-cssY) in the bridge\'s Chrome to its physical virtual-screen coordinates, plus the content-window origin, devicePixelRatio, and calibrated click coord. Use to verify where a real click would land before committing.' },
  { name: 'desktop_toolbar', group: 'desktop', defaultEnabled: false,
    blurb: 'Open or close the movable desktop toolbar widget with focus, release, overlay chat injection, recording, playback, and monitor-local quick calibration controls.' },

  // ── Eval (full JS — root on the page) ────────────────────────
  { name: 'browser_evaluate', group: 'eval', defaultEnabled: false,
    blurb: 'Run arbitrary JavaScript on the page. Equivalent to opening DevTools and pasting code — leave OFF unless you trust the prompt source.' },

  // ── Recordings (replay tooling — niche; off by default) ──────
  { name: 'browser_record_start', group: 'recordings', defaultEnabled: false,
    blurb: 'Start capturing user actions (clicks, types, navigation) to a named JSON file. Stop with browser_record_stop, replay with browser_play. Useful for building reusable demo flows or automating repetitive tasks.' },
  { name: 'browser_record_stop',  group: 'recordings', defaultEnabled: false,
    blurb: 'Stop the active recording and save it under the name passed to browser_record_start.' },
  { name: 'browser_play',         group: 'recordings', defaultEnabled: false,
    blurb: 'Replay a saved recording by name. Optional `speed` (e.g. 2 = 2x) and `variables` for substituting values into recorded inputs.' },
  { name: 'browser_recordings',   group: 'recordings', defaultEnabled: false,
    blurb: 'List saved recordings (name, startUrl, recorded timestamp, action count).' },
  { name: 'browser_chat',         group: 'recordings', defaultEnabled: false,
    blurb: 'Push a message into the bridge overlay chat panel — appears as if the user typed it. Use to surface progress / questions in the same place the user reads agent output.' },
  { name: 'browser_read_chat',    group: 'recordings', defaultEnabled: false,
    blurb: 'Read recent messages from the overlay chat panel (both user and agent). Useful for picking up where a previous conversation left off.' },

  // ── Higgsfield CLI (handler-gated; off in tray by default) ────
  // Read-only tools default ON, mutating defaults OFF — same pattern as
  // the desktop interact / browser_evaluate split. Family is additionally
  // gated by the tray "Enable Higgsfield CLI" checkbox so a user who has
  // never enabled the handler never sees these in any MCP client.
  { name: 'higgsfield_status', group: 'higgsfield', defaultEnabled: true,
    blurb: 'Check whether the higgsfield CLI is installed, authenticated, and ready.' },
  { name: 'higgsfield_list',   group: 'higgsfield', defaultEnabled: true,
    blurb: 'List the user\'s recent Higgsfield generations.' },
  { name: 'higgsfield_models', group: 'higgsfield', defaultEnabled: true,
    blurb: 'List the available Higgsfield models (job_set_types) with their media type — image, video, or text. Call this BEFORE higgsfield_generate to pick a valid model id. Optional type filter. The catalog changes as Higgsfield adds models, so always read it live rather than guessing.' },
  { name: 'higgsfield_generate', group: 'higgsfield', defaultEnabled: false,
    blurb: 'Generate a Higgsfield video/image from a text prompt. Returns the result URL plus a local artifact path. Costs money/quota on the user\'s Higgsfield account — defaults OFF, opt in per session.' },

  // ── Lent CLIs (run another model's CLI: codex / grok / gemini / claude) ──
  { name: 'cli_run', group: 'clis', defaultEnabled: true,
    blurb: 'Run another model\'s lent CLI (codex / grok / gemini / claude) with a prompt and get the text back — so the driving agent can pull a second LLM into a task. Governed by each CLI\'s lend toggle (a model that isn\'t lent is refused). Spends the user\'s CLI subscription/quota. Supports cwd, agentic mode (file-writing where the CLI allows), and background runs.' },
  { name: 'cli_runs', group: 'clis', defaultEnabled: true,
    blurb: 'List recent cli_run invocations (id, model, status, duration, transcript path).' },
  { name: 'cli_run_status', group: 'clis', defaultEnabled: true,
    blurb: 'Get the status + output of a cli_run by id — used to poll a background run to completion.' },
  { name: 'cli_status', group: 'clis', defaultEnabled: true,
    blurb: 'Discover which lent CLIs (codex / grok / gemini / claude) are usable right now — per model: available, lent, authenticated, ready, and the blocker if not. Call before cli_run to route work without trial-and-error refusals.' },

  // ── Custom LLMs (Ollama / LM Studio / OpenRouter / vLLM / etc) ──
  // Single MCP tool that fans out to any custom LLM the user has added on
  // the API & CLIs pane. The endpoint protocol is OpenAI-compatible, but
  // the tool is NOT scoped to OpenAI — the name reflects "custom LLM
  // dispatcher", not the brand of any one provider. Defaults ON; the
  // family is hidden entirely when no providers are configured, so the
  // toggle never appears as a phantom permission.
  { name: 'custom_llm', group: 'providers', defaultEnabled: true,
    blurb: 'Send a chat-completion request to any custom LLM the user configured on the API & CLIs pane (Ollama, LM Studio, OpenRouter, Groq Cloud, vLLM, etc — any OpenAI-compatible endpoint). Pass `provider` (slug), `model`, `prompt`, optional `system`. Returns the assistant text.' },
];

// Maps a tool name to the handler-family key checked in
// settings.handlers[<family>].enabled. Family-gated tools are skipped at
// both the MCP tools/list layer and the bridge dispatcher when the family
// is disabled, regardless of per-tool enabledTools. Future families
// (Replicate, Runway, Suno) drop in here.
export const TOOL_FAMILY: Record<string, string> = {
  higgsfield_status: 'higgsfield',
  higgsfield_list: 'higgsfield',
  higgsfield_models: 'higgsfield',
  higgsfield_generate: 'higgsfield',
};

export const ALL_TOOL_NAMES: string[] = TOOL_META.map(t => t.name);

export function defaultEnabledTools(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of TOOL_META) out[t.name] = t.defaultEnabled;
  return out;
}

export function groupOf(name: string): ToolGroup | undefined {
  return TOOL_META.find(t => t.name === name)?.group;
}

export function describe(name: string): string {
  return TOOL_META.find(t => t.name === name)?.blurb || '';
}
