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

GitHub runs this same fast check on one Ubuntu/Node 20 runner for ordinary
pushes and pull requests. The cross-platform compatibility and native package
jobs are intentionally manual release gates; see `docs/RELEASE.md`.

Before a release or package change:

```bash
npm pack --dry-run
```

## Packaged Provider And Subscription Acceptance

Build the native package on the host operating system first:

```bash
npm run desktop:package
```

Then run one or more live routes through the packaged executable. The runner
uses disposable Bridge/Electron/provider state, random loopback ports, no
relay, and no automation Chrome. It preserves the user's normal credential
home only so the vendor CLIs can use their existing sign-ins.

Local or in-house OpenAI-compatible endpoint:

```bash
EMPIR3_ACCEPT_PROVIDER_URL=http://127.0.0.1:1234/v1 \
EMPIR3_ACCEPT_PROVIDER_MODEL=qwen/qwen3.5-9b \
npm run desktop:accept-live
```

Built-in key-backed provider (inject the key from a protected secret store;
never put a real key in a committed script):

```bash
EMPIR3_ACCEPT_API_PROVIDER=google \
EMPIR3_ACCEPT_API_MODEL=gemini-2.5-flash \
EMPIR3_ACCEPT_API_KEY='protected-test-key' \
npm run desktop:accept-live
```

Supported subscription CLIs:

```bash
EMPIR3_ACCEPT_CLIS=codex,claude,grok,agy npm run desktop:accept-live
```

A pass requires the requested response marker, not merely non-empty stdout.
This matters for JSONL CLIs: a structured `turn.failed` event must be reported
as a failure even if the CLI process exits with code zero. The runner removes
its temporary provider/key and one-shot transcript on exit.

## Native Desktop Installer Lifecycles

The native package matrix exercises the actual delivery formats after the
packaged-provider smoke:

```bash
npm run desktop:installer-smoke:windows
npm run desktop:installer-smoke:macos
npm run desktop:installer-smoke:linux
npm run desktop:update-smoke:linux
npm run desktop:update-smoke:macos
```

- Windows installs the Squirrel Setup into the native per-user location,
  launches the installed app with isolated state, uninstalls while retaining a
  state sentinel, reinstalls, launches again, and performs a final uninstall.
- macOS mounts the DMG read-only, copies the app into a disposable Applications
  directory, launches it, removes/reinstalls it with retained state, and
  detaches the image.
- Linux installs the DEB through the dependency-resolving `apt-get` path,
  launches it under Xvfb, removes it with
  retained user state, reinstalls, launches again, and purges the package on
  both x64 and ARM64 runners.
- Linux then installs the base release, consumes a cryptographically signed
  production-form manifest and exact hash-bound next-version DEB, launches the
  update, consumes an explicit signed rollback naming that current version,
  launches the rollback, verifies retained state, and purges the package.
- The macOS update command is reserved for the manual credentialed candidate
  workflow. It requires separate base and next Developer ID-signed, notarized,
  and stapled DMGs; verifies both operating-system trust and the signed manifest
  bytes; upgrades and launches a disposable app; then rolls back, relaunches,
  and confirms retained state.

Windows and Linux refuse to replace a pre-existing installation. The Windows
test uses the real Squirrel profile only in an ephemeral CI account; a local
run requires `EMPIR3_INSTALLER_TEST_ALLOW_REAL_PROFILE=1`. macOS/Linux local
runs require `EMPIR3_INSTALLER_TEST_ALLOW_NATIVE_HOST=1`. All three use exact
package paths and clean up only the package they proved was absent beforehand.

## Linux Headless Package Acceptance

Use a disposable systemd VM, never a production VPS. Validate the receipt hash
before transfer, then prove: install and health; reboot persistence; normal
uninstall with provider-state retention; reinstall; signed upgrade; explicit
signed rollback; intentionally broken signed update with at most five service
restarts; explicit `--purge-data`; and a clean reinstall with the production
trust root. Stop any loopback fixture server by its exact validated PID and
working directory.

The ephemeral signed fixture generator is:

```bash
node headless-package/scripts/create-update-acceptance-fixture.cjs \
  --base-archive /path/to/real-headless-package.tar.gz \
  --out /new/disposable/fixture-directory \
  --base-url http://127.0.0.1:18080/
```

The output is acceptance-only and must never enter the download channel.

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
2. Trusted control boundary: run `bridge_overlay_reinject`, open
   `http://localhost:3006/`, and verify the command reports the legacy page
   overlay retired. Confirm a WebSocket with `role=overlay` is rejected and the
   dashboard chat treats HTML payloads as visible text.
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
