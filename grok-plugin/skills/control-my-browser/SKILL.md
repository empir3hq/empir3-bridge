---
name: control-my-browser
description: >-
  Drive the user's own Chrome through the Empir3 Bridge: open a page, read it,
  click, type, and verify. Use whenever a task involves a website or web app the
  user is signed into, or any browsing, form filling, screenshot or page check.
  Triggers: "open my", "log in to", "fill the form", "check the page", "take a
  screenshot", "use my browser".
---

# Control my browser

The Bridge runs on the user's computer and owns a dedicated Chrome profile with
the user's logins. Every `browser_*` tool acts on that Chrome. Work in short
loops: observe, act once, observe again.

## 1. Check before you act

1. `browser_status` — the Bridge and its Chrome must report running. The MCP
   server starts the Bridge on the first call if it is installed but stopped;
   if the result still says it is not running, tell the user to start Empir3
   Bridge and stop.
2. `bridge_safety_status` — read-only is the default. Clicking and typing need
   the browser interact permission; JavaScript needs eval; recordings need the
   recording permission. If something you need is off, say which switch to turn
   on in the Bridge console at `http://localhost:3006/console` (Permissions
   pane). Never look for another way around a disabled tool: the refusal is the
   correct result.
3. Loopback, private-network and `file:` URLs are refused unless the user has
   approved that exact origin under Local & private origins. Say so instead of
   retrying.

## 2. The loop

1. `browser_tab_state` — see which tab is agent-controlled and which the user
   is looking at. Prefer `browser_tab_open` with the URL for independent work;
   it returns the exact tab target and leaves the user's tabs alone.
   `browser_navigate` moves the current agent tab instead.
2. `browser_snapshot` — returns refs such as `e3_0` for interactive elements.
   Refs belong to that snapshot only.
3. Act once: `browser_click_ref`, `browser_type_ref` (ref + text),
   `browser_press` (`Enter`, `Tab`, `Control+a`), `browser_scroll`.
4. Verify: a fresh `browser_snapshot`, `browser_text` for the readable page, or
   `browser_screenshot` when layout matters. Then repeat from step 2 — refs from
   before the action are stale.

A tab id proves the tab exists, not that the page has loaded. If an observation
comes back empty during navigation, wait briefly and observe again. Do not
repeat a click, submission or typed text after an uncertain result; read
`bridge_action_log` to see what actually happened.

## 3. When the snapshot cannot see a control

Frames and shadow roots can hide controls from `browser_snapshot`. Take a
`browser_screenshot`, click the field with `browser_click_xy` using viewport
CSS pixels, then `browser_type` without a selector to append text to the
focused field. Both guarded tools need an explicit `target`
(`{surface:"browser", tabId}`) copied from `browser_tab_state`; without it the
Bridge refuses focused typing. Verify with another screenshot.
`browser_dialog` takes the same `target` and reads or answers an alert,
confirm or prompt by its dialog id.

## 4. Finish cleanly

- `browser_tab_close` only the tab you opened; never close the user's tabs.
- Report what you verified, not what you dispatched.
- If the user takes the mouse, stop and wait; never fight a takeover.
- `bridge_tool_advisor` answers "which tool for X" and shows the current
  safety state when you are unsure.
