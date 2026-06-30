# Testing The Bridge

This guide is for maintainers, contributors, and agents making bridge changes.

## Static Checks

Run these before committing:

```bash
npx tsc --noEmit
npm run build:mcp
npm test
git diff --check
```

Before a release or package change:

```bash
npm pack --dry-run
```

## Standard Smoke Test Plan

Agents and maintainers should use the same quick smoke every time someone says
"test the bridge." Do not skip `/desktop-test`; it is the shared harness for
browser tools, desktop tools, calibration checks, recording, and playback.

Open the live plan:

```text
http://localhost:3006/api/bridge-smoke-test-plan
```

Or print it from the CLI:

```bash
npx tsx src/cli.ts smoke-plan
```

Or open the visual harness:

```text
http://localhost:3006/desktop-test
```

Run the smoke in this order and stop after the first reproducible failure:

1. Health: `status`, `reliability_status`, and `safety_status`.
2. Overlay: navigate to `/desktop-test`, then run `bridge_overlay_reinject`.
   Verify the chat bubble, cursor hook, and overlay transport are present.
3. Browser tools: use `text`, `snapshot`, `screenshot`, `click #clickTarget`,
   `type #nameInput`, `press Tab`, and scroll to `#scrollTarget`.
4. Recording loop: `record_start`, click `#clickTarget`, `record_stop`,
   list recordings, then play the saved recording once.
5. Desktop tools: run `desktop_monitors`, `desktop_calibration_status`,
   `desktop_cursor_position`, `desktop_screenshot_zoom`,
   `desktop_focus_status`, and `desktop_release_focus`.
6. Tray toolbar: run `desktop_toolbar status`, then `desktop_toolbar show`.

Required selectors on the harness:

```text
#clickTarget
#dragSource
#dropTarget
#nameInput
#emailInput
#notesInput
#modeKeyboard
#modeMouse
#agreeBox
#prioritySelect
#submitForm
#scrollTarget
```

## Basic Smoke

Start the bridge:

```bash
npm start
```

In another shell:

```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts reliability-smoke
npx tsx src/cli.ts safety-status
```

Expected:

- status reports the bridge is running
- reliability smoke passes
- safety status reports either `read_only` or lists enabled write tools

## Browser Smoke

```bash
npx tsx src/cli.ts desktop-test
npx tsx src/cli.ts snapshot
npx tsx src/cli.ts screenshot
npx tsx src/cli.ts text
```

For write-capable browser tests, enable the relevant tool in settings first:

```text
http://localhost:3006/settings
```

Then use a harmless page before trying a real app.

## Desktop Smoke

Open the safe desktop test harness:

```bash
npx tsx src/cli.ts desktop-test
```

Or visit:

```text
http://localhost:3006/desktop-test
```

Useful checks:

```bash
npx tsx src/cli.ts desktop-monitors
npx tsx src/cli.ts desktop-screenshot all
npx tsx src/cli.ts desktop-hover 960 540 DISPLAY1
```

Only run `desktop-click` or `desktop-drag` when the test harness window is visible and positioned where the target coordinates are known. Blind drag tests can move windows or select real UI.

## Parallel Bridge Smoke

Use a separate profile and ports so you do not disturb the normal bridge:

```bash
EMPIR3_PW_PORT=3106 \
EMPIR3_BRIDGE_HTTP_PORT=9967 \
EMPIR3_CDP_PORT=9322 \
EMPIR3_BRIDGE_PROFILE=$HOME/.empir3-bridge/profile-smoke \
EMPIR3_BRIDGE_LABEL=SMOKE \
npm start -- --fresh
```

Drive it:

```bash
BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts reliability-smoke
BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts desktop-test
```

Stop it:

```bash
EMPIR3_PW_PORT=3106 \
EMPIR3_BRIDGE_HTTP_PORT=9967 \
EMPIR3_CDP_PORT=9322 \
EMPIR3_BRIDGE_PROFILE=$HOME/.empir3-bridge/profile-smoke \
EMPIR3_BRIDGE_LABEL=SMOKE \
npm run kill
```

## What To Include In Bug Reports

- OS and version
- `node -v`
- Chrome version
- exact command run
- `npm run status` output
- `npx tsx src/cli.ts reliability-status` output
- relevant screenshots or `feedback/` paths

Do not paste API keys, site cookies, or private page data into public issues.
