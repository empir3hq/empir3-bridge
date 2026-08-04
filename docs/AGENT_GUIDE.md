# Bridge agent guide — decision tree for picking the right tool

> Audience: AI agents driving the bridge (Claude in the overlay, Vincent on
> app.empir3.com, MCP clients in Claude Code / Codex / Cursor). Not the
> human user.

The bridge currently exposes **57 tools** across browser, desktop, overlay
+ recording, reliability + safety, and API & CLIs (`custom_llm` +
`higgsfield_*`). Most tasks need 2-3 of them; the rest are specialised
fallbacks. Read this guide top-to-bottom once per session and you'll skip
the trial-and-error.

When asked to "test the bridge", use the standard smoke plan at
`/api/bridge-smoke-test-plan` and open `/desktop-test` first. That page is the
shared harness for browser actions, desktop actions, recording/playback,
overlay reinjection, and calibration checks; do not substitute a random page
unless the user asked for a site-specific test.

---

## The five things you can do

Every bridge action falls into one of these:

1. **See** what's on screen — text, structure, or pixels
2. **Find** a specific element (button, icon, field)
3. **Act** on it (click, type, scroll)
4. **Point** at it for the user (without taking control)
5. **Manage state** (focus region, calibration, permissions)

Pick the lane first, then the tool.

---

## 1 · See what's on screen

| You want… | Tool | Why |
|---|---|---|
| Page text | `browser_text` | Cheapest. Always try first if content is web. |
| Page structure as JSON refs | `browser_snapshot` | Get clickable refs (e0, e1, …) with bounds + names. Use for any web target. |
| Visual confirmation of web page | `browser_screenshot` | After a write, to verify it landed. |
| Desktop pixels | `desktop_screenshot` | Native desktop apps, games, anything outside the bridge browser. |
| Tight zoom around a pixel | `desktop_screenshot_zoom` | Pixel-accurate inspection of a small area. |
| Which monitors exist | `desktop_monitors` | DPI-aware bounds, including negative coords. |

**Rule:** if the target is in the bridge tab, `browser_snapshot` beats every
desktop tool. Web work should never touch desktop_* unless you need pixels
outside the page.

---

## 2 · Find a specific element

The most common failure mode for agents is "I need to click X but I don't
know where it is." Pick the right finder for the surface:

| Surface | Tool | Returns |
|---|---|---|
| Web page in bridge tab | `browser_snapshot` | `e0`, `e1`, … refs with `role`, `name`, `bounds`. |
| Native Win32 / UWP app | `desktop_snapshot` | `d0`, `d1`, … refs with `role`, `name`, `bounds`. |
| **Any visible region, agent reads numbers off image** | `desktop_snapshot_som` | Numbered boxes drawn on a screenshot. You read "click 14" — no pixel math. |
| Pixel-only (no UIA, no DOM) — e.g. games, Photoshop, CEF | _Phase 2 (OmniParser)_ | Not shipped. Today: ask user to select region + use grid (see §5). |

**`desktop_snapshot_som` is the killer tool** when the user has selected
a focus region. It returns an annotated screenshot AND the element list —
you pick the number and call `desktop_click_ref` with the matching `ref`.
Zero pixel arithmetic.

### When `_snapshot_som` returns `empty: true`
That means UIA found no elements. Reasons:
- App is CEF/Electron (Discord, Spotify, Steam, VS Code content area)
- App is a game or custom GPU surface (Photoshop, Illustrator)
- App is web content but in the bridge browser — use `browser_snapshot` instead

Fallback: ask the user to point (`desktop_pick_point`) or use the focus
chess-board grid (`desktop_click_cell`).

---

## 3 · Act on it (click / type / scroll)

### Web
| Intent | Tool |
|---|---|
| Click a ref from `browser_snapshot` | `browser_click_ref` |
| Click by CSS selector | `browser_click` |
| Click at known viewport coords | `browser_click_xy` |
| Type into a ref | `browser_type_ref` |
| Type by selector | `browser_type` |
| Press a key globally | `browser_press` |
| Scroll | `browser_scroll` |
| Visual cue for the user | `browser_highlight` |

### Desktop
| Intent | Tool |
|---|---|
| Click a ref from `desktop_snapshot` / `_som` | `desktop_click_ref` |
| Click at known screen coords | `desktop_click` |
| Hover (no click) | `desktop_hover` / `desktop_hover_ref` |
| Drag | `desktop_drag` |
| Click cell N,M in the focus grid | `desktop_click_cell` |

**Always prefer `_ref` over `_xy` / `_click`.** Refs survive screen movement
and DPI changes. Coords don't.

### Browser eval
| Intent | Tool |
|---|---|
| Run arbitrary JS | `browser_evaluate` |

Default-off because it's effectively root on the page. Use only when no
other tool can get the data (e.g. inspecting `window.someAppState`).

### Test at phone resolution (device emulation + touch)

| Intent | Tool |
|---|---|
| Flip the tab into a phone viewport (metrics + touch + mobile UA) | `browser_emulate_device` (`iphone14`, `pixel7`, `custom`, `off`) |
| Touch-tap at viewport coords | `browser_tap` |
| Swipe / drag gesture (scroll lists, dismiss sheets, drag sliders) | `browser_swipe` |

**Pattern:**
```
browser_emulate_device preset:"iphone14"
browser_refresh                → page boots with mobile UA + touch
browser_snapshot               → refs as usual
browser_tap / browser_click_ref → clicks auto-route through touch while emulated
browser_swipe x1,y1,x2,y2      → gestures (e.g. swipe down on a sheet's grab handle)
browser_emulate_device preset:"off" → restore desktop
```

Notes:
- **Refresh after enabling** — many apps (RN-Web included) pick touch vs
  mouse handlers at boot, so an un-refreshed page still behaves desktop-y.
- While emulation is on, `browser_click_ref` / `browser_click` dispatch
  touch taps automatically — pages ignore mouse events in touch
  environments, so you don't have to switch tools.
- This is still Chrome's engine. For true Safari/WebKit rendering use the
  Playwright mobile-smoke harness in the app repo (`tests/mobile-smoke`).
- **One emulated tab at a time.** The emulation hold is a single global
  session bound to the current tab — with per-agent tabs (0.3.46) that means
  `emulate_device` applies to whichever tab is current when it runs (after
  the per-agent switch, that's the calling agent's tab). Two agents cannot
  hold two emulated viewports simultaneously.

---

## 4 · Point at it (don't take control)

Use these when the user is doing the work and you're guiding them. The
ghost cursor doesn't touch the real mouse.

| Intent | Tool |
|---|---|
| Show a labeled arrow at coords | `desktop_pointer_show` |
| Move the arrow | `desktop_pointer_move` |
| Pulse animation for emphasis | `desktop_pointer_pulse` |
| Hide it | `desktop_pointer_hide` |
| Show pointer at a focus-grid cell | `desktop_pointer_cell` |
| Check whether arrow is up | `desktop_pointer_status` |

**Tutorial pattern:**
```
desktop_snapshot_som → "the brush tool is number 14"
desktop_pointer_show at element 14 bounds, label "click here"
… user clicks …
desktop_pointer_hide
desktop_snapshot_som → confirm next state
```

---

## 5 · Manage focus, grid, and calibration

These are scaffolding — agents rarely call them directly, but should know
they exist.

| Intent | Tool |
|---|---|
| Ask user to select an area to work in | `desktop_select_region` (user-interactive) |
| Check whether a region is active | `desktop_focus_status` |
| Clear the region | `desktop_release_focus` |
| Show on-screen grid matching the agent's view | `desktop_focus_grid` |
| User clicks → bridge reports cell coords | `desktop_pick_point` (user-interactive) |
| Click a cell of the focus grid | `desktop_click_cell` |
| Calibrate clicks (first-time or after monitor change) | `desktop_calibrate_pointer` (user-interactive) |
| Read saved calibration | `desktop_calibration_status` |

**Focus region** is the agent's working area inside an arbitrary monitor
layout. When active, `desktop_screenshot` and `desktop_snapshot_som`
auto-scope to it. Pixel coords in the screenshot are then focus-relative,
which simplifies the agent's mental model.

---

## Recordings

| Intent | Tool |
|---|---|
| Start recording user actions | `browser_record_start` |
| Stop and save | `browser_record_stop` |
| List saved recordings | `browser_recordings` |
| Replay one | `browser_play` |
| Push a message into the overlay chat | `browser_chat` |
| Read overlay chat history | `browser_read_chat` |

---

## Common recipes

### Recipe: click a button on a website
```
browser_snapshot → find { role:"button", name:"Continue" } → click_ref
```

### Recipe: click a small icon in a native app the user selected
```
desktop_snapshot_som → read numbered boxes → desktop_click_ref by id
```

### Recipe: guide user through Photoshop tutorial
```
desktop_select_region (one-time)
desktop_calibrate_pointer (one-time)
for each step:
  desktop_pointer_show at the target, with label
  wait for user click
  desktop_pointer_hide
```

### Recipe: confirm an action worked
```
… action …
browser_screenshot OR desktop_screenshot
```

### Recipe: agent doesn't know what app is open
```
desktop_snapshot scope:"all-windows" → returns each window's title + pid
```

---

## Anti-patterns

- ❌ Eyeballing pixel coords from a chat-resized screenshot. Use refs.
- ❌ Calling `desktop_click x:… y:…` when `_snapshot_som` would work.
- ❌ Taking a `desktop_screenshot` to "see" a web page you could `browser_snapshot`.
- ❌ Repeating screenshots after every click — only re-capture when state changes meaningfully.
- ❌ Calling `desktop_calibrate_pointer` without warning the user — it's interactive.

---

## Permissions (won't fire without these)

Tools that *write* (anything in the Act / Point lanes, plus recordings)
need `globalSafety.write` true AND per-tool `enabledTools[name]` true.
Tools that *read* need `globalSafety.read`. The bridge returns
`Permission denied` if either is off.

Surface tools to the user via the bridge control center; never disable
permissions silently from agent code.

---

## Discoverability — when in doubt

Call `bridge_tool_advisor(intent: "I want to …")` — returns the relevant
slice of this guide plus the tool names that fit.

---

## 6 · API & CLIs (talk to other models)

The bridge can dispatch to other model endpoints you've already set up.
Configure them in the welcome console (**API & CLIs** pane) once, then
call from any MCP client.

| Intent | Tool |
|---|---|
| Call a Bridge API/custom LLM | `custom_llm` (route by `provider` slug — supported cloud APIs, Ollama, LM Studio, vLLM, etc.) |
| Check Higgsfield CLI status / auth | `higgsfield_status` |
| List Higgsfield models / generations | `higgsfield_list` |
| Generate an image with Higgsfield | `higgsfield_generate` (writes to `~/.empir3-bridge/artifacts/higgsfield/`) |

**Family gates:**
- `higgsfield_*` is gated by the `higgsfield-cli` handler toggle in bridge settings.
- `custom_llm` appears once the user adds at least one verified API key or custom provider. Adding the first provider auto-enables the tool; removing the last API/custom provider auto-disables it.

**Empir3 routing:** local MCP access and Empir3 sharing are separate choices.
The provider's **Available to my Empir3 agents** toggle must be on
before the paired account can discover or select it. The relay sees safe
name/model/health metadata only; it never receives the provider URL or API key.
Each relayed model call is one upstream attempt and stays pinned to this device.

Toggling any family after the MCP client is already connected requires
reconnecting that client for the tool list to refresh.
