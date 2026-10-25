---
name: use-my-desktop
description: >-
  Operate native Windows applications on the user's PC through the Empir3
  Bridge: list and focus windows, read their controls, click, type, press keys,
  take DPI-aware screenshots, and work inside a region the user selects. Use
  when a task needs a desktop app rather than a web page. Full support is
  Windows; Linux with X11 has screenshot, pointer and keyboard only; macOS has
  no native desktop control.
---

# Use my desktop

Desktop tools are off by default and are the most powerful thing the Bridge
can do. One observed action, one verification, every time.

## 1. Confirm support and permission

1. `bridge_control_catalog` — read `surfaces.desktop` and each tool's
   `supported` / `localMcpAvailable` flags. Promise only what the catalog
   reports for this device. On macOS, say that native desktop control is not
   available and offer the browser instead.
2. `bridge_safety_status` — desktop controls must be enabled. If they are not,
   ask the user to turn them on in the Bridge console
   (`http://localhost:3006/console`, Permissions pane). Do not substitute a
   shell command or any other route for a refused desktop action.
3. First time on a machine, rehearse on `http://localhost:3006/desktop-test`
   before touching real windows.

## 2. The loop (Windows)

1. Find the app: `desktop_app` with `action:"list"` or `action:"is_running"`
   plus a name; `action:"launch"` opens it. `desktop_window` with
   `action:"list"` returns window titles; use `action:"focus"` with the exact
   unique title that was returned. Ambiguous titles are refused.
2. Observe: `desktop_snapshot` (foreground window by default,
   `scope:"all-windows"` for everything). It returns refs with roles, names and
   physical bounds. Refs expire after 30 seconds or on the next snapshot.
3. Act once: `desktop_click_ref` with a fresh ref; `desktop_type` with the
   text and the field's ref; `desktop_key` with keys such as
   `["CTRL","A"]` for shortcuts. Text goes through `desktop_type`, never
   through key chords.
4. Verify with a new `desktop_snapshot` and read the field value back. A
   `dispatched` result is not proof the app changed.

Screenshots: `desktop_monitors` first, then `desktop_screenshot` with
`monitor`, a `region`, or `grid:true` for coordinate labels. Coordinates are
physical virtual-screen pixels and may be negative on monitors left of or
above the primary. Never mix them with browser CSS pixels.

## 3. Work inside what the user points at

`desktop_select_region` opens an overlay; the user drags a rectangle and
later screenshots and snapshots scope to it. For pixel-only apps where no
controls are returned, `desktop_snapshot_som` draws numbered boxes on the
image and `desktop_screenshot_zoom` magnifies a slice. Release the region with
`desktop_release_focus` when the task is done.

## 4. Recover once, then report

| Result | Next action |
| --- | --- |
| `stale_observation` | Snapshot again and find the control again |
| `desktop_locked` | The user must unlock Windows; input cannot cross the lock screen |
| `input_cancelled` / `input_busy` | The user is using the mouse or keyboard; wait, then observe again |
| `activation_refused` | Ask the user to click the window once; do not loop focus requests |
| Empty snapshot | Web content: use the browser tools. Otherwise use a screenshot and a user-selected point |
| Permission or tool disabled | Name the switch; the device owner controls it |

Never automate the lock screen, a password prompt, or a window the user is
actively working in. `bridge_revoke_control` turns every write-capable tool
off at once if the user asks you to stop.
