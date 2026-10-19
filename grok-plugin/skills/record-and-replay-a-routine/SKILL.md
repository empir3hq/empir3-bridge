---
name: record-and-replay-a-routine
description: >-
  Capture a browser routine once in the user's own Chrome through the Empir3
  Bridge and replay it later with different values — a login, an export, a
  weekly report download, a form that is filled the same way every time.
  Triggers: "record this", "do it again every week", "replay", "save this
  routine", "automate what I just did".
---

# Record and replay a routine

Recordings are saved locally on the user's computer and replayed in the
Bridge's Chrome. Recording and replay tools are off by default.

## 1. Check the permission

`bridge_safety_status` must show recordings enabled. If not, ask the user to
turn Recording on in the Bridge console (`http://localhost:3006/console`,
Permissions pane) and stop until they have.

## 2. Record

1. `browser_status`, then open the starting page with `browser_tab_open` or
   `browser_navigate`.
2. `browser_record_start`. A failed start is not an active recording; never
   call stop to manufacture a saved result.
3. Perform the routine — the user in the Bridge's Chrome, or you with
   `browser_snapshot`, `browser_click_ref`, `browser_type_ref` and
   `browser_press`. Recorded steps keep persistent selectors and verified
   Bridge selections.
4. `browser_record_stop` with a clear `name`. It returns the file name and the
   number of actions. Confirm both with the user.

## 3. Replay

1. `browser_recordings` lists what is saved and which engine made each entry.
2. `browser_play` with the `recording` name. Pass `variables` for values that
   change, for example `{"EMAIL": "name@example.com"}`; the recording must have
   been made with those placeholders.
3. Verified recordings run as the page becomes ready, stop at the first
   failure and return a receipt per step. Read the receipts of the completed
   steps before deciding anything. Legacy recordings accept a `speed`
   multiplier.

## 4. When a replay stops

Observe the current page with `browser_snapshot` or `browser_screenshot`
before touching anything. Fix the one failed step by hand if the user wants,
then re-record if the site changed. Never replay the whole routine again to
repair one step; a login or a purchase would run twice.

Recordings stay on this computer. Mention where the Bridge keeps them (the
Bridge data folder under the user's home directory) when the user wants to
back them up or delete one.
