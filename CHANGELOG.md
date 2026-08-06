# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.70] - 2026-08-06

### Added

- **One Empir3 agent can now draw different abilities from different Bridge
  computers.** Custom providers may identify themselves as Brain (chat), Ears
  (speech-to-text), Mouth (text-to-speech), or Imagination (image), advertise
  only safe model and device metadata, and execute on the machine where the
  private endpoint actually lives.
- Added native adapters for OpenAI-compatible and native Whisper STT,
  OpenAI-compatible and Kokoro TTS, AUTOMATIC1111, ComfyUI, and
  OpenAI-compatible image APIs. ComfyUI workflows are parsed and size-bounded,
  require an explicit prompt placeholder, and substitute prompt, seed, size,
  model, and optional reference-image values without string-splicing JSON.
- Added exact run correlation, per-kind FIFO queues, targeted cancellation, and
  explicit per-device dispatch for local voice and image work.
- Added two-tier media delivery: assets that fit the existing WebSocket frame
  remain inline; larger assets use a short-lived server upload grant with a
  bounded HTTPS PUT and one safe retry for network/server failures.

### Fixed

- Higgsfield video and Agy image results larger than the inline frame ceiling
  now use the shared upload tier instead of risking a dropped completion and a
  long generic timeout.
- Native Whisper probes now use its health endpoint and send the multipart
  field name expected by the private Whisper service, while the
  OpenAI-compatible adapter retains the standard `file` field.
- Pinned devices fail explicitly when unavailable; the Bridge never silently
  substitutes another local machine or a hosted provider for typed local
  capabilities.

## [0.3.69] - 2026-08-06

### Fixed

- **Project folders now open as visible Windows Explorer windows.** The native
  launcher no longer applies Node's `windowsHide` process flag to
  `explorer.exe`; that flag let the Bridge report a successful spawn while the
  requested folder window remained invisible.

## [0.3.68] - 2026-08-06

### Added

- **Projects can now open their synced local workspace directly from Empir3.**
  A user-owned click targets the selected Bridge computer, resolves the
  project's canonical directory inside the configured Projects root, creates
  it when needed, and opens the native file manager on Windows, macOS, or a
  Linux desktop. Browser-supplied paths, agent-initiated opens, symlink escapes,
  and headless machines are refused.
- **The Bridge Console now has a first-class calibration workflow.** An orange
  Calibrate control beside Launch browser walks every current monitor through
  pointer calibration, opens the 103-target Accuracy Lab, and becomes a green
  Calibrated state only after a clean pass. Monitor bounds, orientation, DPI,
  calibration-version, or lab failures invalidate the pass.
- **Bridge desktop identity is now consistent across every package.** One
  high-contrast Bridge glyph supplies connected/disconnected tray states,
  Electron window and taskbar identity, Windows ICO/Squirrel and native setup
  resources, macOS ICNS/DMG, Linux package metadata, and the legacy tray.
- **Obsidian vaults can now be connected as read-only Connected Knowledge.**
  The shared Bridge engine discovers or accepts a local vault, keeps its
  bounded Markdown index and absolute paths on the user's computer, and only
  relays cited search/read excerpts after the user explicitly makes the vault
  available to their Empir3 agents. The console can limit included folders,
  test searches locally, rescan, open cited notes in Obsidian, or disconnect
  and purge the Bridge index without changing vault files.
- **The cross-platform Electron shell has an initial provider-first scaffold.**
  It supervises the existing Bridge engine instead of copying provider logic,
  opens the existing API & CLIs console, keeps the automation Chrome dormant,
  uses isolated ports during development, and attaches to an already-healthy
  Bridge rather than launching a duplicate. The current Windows payload and
  Linux headless service remain unchanged while platform packaging is built.
- Windows, macOS, and Linux CI now run the desktop shell's pure lifecycle,
  port, provider-startup, and navigation checks under Electron's supported
  Node 24 toolchain.
- Native unsigned package lanes now build a Windows x64 Setup/ZIP, macOS
  universal DMG/ZIP, and Linux x64/ARM64 DEB/ZIP from the same staged Bridge
  engine.
  Each lane smokes the packaged app with isolated state, exercises real custom
  provider discovery plus an authenticated local completion, inventories
  SHA-256 hashes, and uploads short-lived test artifacts without publishing
  them.
- Native CI now installs, launches, removes, reinstalls, and cleans the actual
  Windows Squirrel, macOS DMG, and Linux x64/ARM64 DEB delivery formats.
- Linux x64 and ARM64 additionally prove signed-manifest update, explicit
  signed rollback, relaunch, retained local state, and final package purge.
- A manual held macOS candidate workflow is ready to import ephemeral Apple
  credentials, Developer ID-sign, notarize, staple, verify, run the DMG
  lifecycle, build a separately signed next version, prove signed update and
  rollback, upload both 14-day candidates, and delete the credentials without
  publishing.
- A schema 3 release index now inventories and verifies the exact Windows x64,
  macOS universal, Linux x64, and Linux ARM64 installer/archive/update files,
  gives them stable public names, and selects a package without architecture
  guessing. CI validates the combined staging operation and uploads one held,
  short-lived universal index without duplicating the large native packages.
- The signed Windows release manifest can now absorb that index while keeping
  the four legacy Windows bootstrap fields verbatim. The flat all-string
  extension carries per-artifact hashes, sizes, formats, signing state,
  per-platform health, deterministic staged-rollout policy, and rollback
  metadata under the existing Ed25519 trust root. The publisher stages every
  referenced artifact before the index and manifest and refuses unsigned
  desktop packages outside an explicit dry run.
- Packaged desktop apps now consume the schema 3 policy themselves. A stable
  per-install identity makes staged selection deterministic; hold and unhealthy
  targets remain silent; signed rollbacks only apply to the explicitly named
  bad version. The app selects its exact installer, streams it to a temporary
  file, verifies the signed byte count and SHA-256, and only then offers to
  open it. Each healthy Bridge startup records a local update-health receipt.
- Desktop rollout uses `bridge-desktop-version.json`, separate from the legacy
  Windows `bridge-version.json`. Non-live schema 3 builds actively withhold the
  legacy file; only a 100% live release can promote identical signed bytes to
  both channels. This keeps hold/staged/rollback policy effective for Electron
  without older Windows bootstrappers bypassing it.
- The package runtime stages only the native terminal files needed by its
  platform (both architectures for macOS universal), reducing the embedded
  Bridge runtime from roughly 64 MB to roughly 6 MB on Windows.
- **The API-provider section now matches Empir3's key-backed text catalog.**
  Anthropic, DeepSeek, Google AI, Groq, Mistral AI, Moonshot AI, OpenAI,
  OpenRouter, Perplexity, xAI, and z.ai keys are verified before save, their
  available chat models are detected, and an explicit sharing switch makes
  them selectable by Empir3 agents. Calls execute on the user's Bridge with
  native Anthropic/Gemini or OpenAI-compatible wire formats; keys never cross
  the relay.
- **Custom providers can now power Empir3 agents through the user's own
  Bridge.** A provider must be explicitly shared before its safe name/model
  metadata is advertised. Model requests are pinned to that exact device;
  endpoint URLs and API keys remain local and are never sent to Empir3.
- The custom-provider dialog is now a regular setup form for name, API address,
  optional key, optional models, and the Empir3 sharing choice. JSON is no
  longer required for normal setup.
- A lightweight Linux headless release now ships for x64 and ARM64 with an
  immutable root-owned runtime, non-root systemd service, bounded health gate,
  signed updater, explicit rollback, retained-data uninstall, and separate
  purge operation.
- Packaged acceptance can now exercise a real local OpenAI-compatible model, a
  protected built-in provider key, and authenticated Codex, Claude, Grok, and
  Antigravity subscriptions without copying credentials into disposable state.
- Cross-platform release signing now has a native preflight, Azure Trusted
  Signing hooks for the Electron/Squirrel Windows package, Developer ID plus
  notarization/stapling hooks for macOS, and post-build signature receipts that
  fail closed.
- Native package lanes now exercise their real installer formats: Windows
  Squirrel install/remove/reinstall, macOS DMG mount/copy/remove/reinstall, and
  Linux DEB install/remove/reinstall/purge on x64 and ARM64.

### Fixed

- Accuracy Lab now keeps one immutable 103-target registry through visibility
  and resize changes, re-reads targets after instant scroll settlement, places
  the orbit target on visible geometry, reports `local test` instead of a false
  hardcoded offline state, and publishes strict pass evidence back to Bridge.
  SVG visual centers now use the browser's full screen transform, so
  letterboxed canvases score the visible geometry rather than an offset point.
- Long multi-monitor calibration no longer loses its Accuracy Lab launch to
  browser popup blocking; both calibration and bundled-test navigation use
  narrow user-owned local endpoints without weakening agent Execute policy.
- **Bridge updates can no longer silently replace provider or key settings
  with defaults after an interrupted write.** Provider definitions, endpoints,
  API keys, model choices, sharing switches, and permissions now use atomic
  same-directory writes with a secure last-known-good backup. The first launch
  after upgrading captures existing settings automatically; a missing or
  damaged primary is restored from that backup, and damaged bytes are retained
  for support rather than discarded.
- **The local Launch browser controls no longer depend on agent Execute
  permission.** The console, Electron tray, and legacy tray use a dedicated
  user-owned endpoint, while MCP and relay browser commands remain gated. The
  console also reports a rejected launch instead of displaying false success.
- **`bridge_scale up` now works from the installed Electron payload.** Scaled
  instances launch through the staged headless entry, derive their ports from
  the active Bridge, open an isolated browser, and are stopped by their exact
  tracked process tree. Packaged acceptance now proves scale up, health, and
  down; scale status also distinguishes a healthy service from an idle browser.
- **A supervised development Bridge can no longer reap a different installed
  Bridge on Windows.** Electron probes its exact wrapper port and disables the
  standalone host's broad stale-predecessor fallback. If another process owns
  one of its isolated ports, startup fails closed instead of killing an
  unrelated Bridge; standalone and systemd stale-process recovery is retained.
- The cross-platform test runner now enumerates test files explicitly instead
  of relying on shell glob behavior, and its failed-spawn regression no longer
  signals an invalid POSIX child handle. This removes Windows glob failures and
  macOS/Linux runner cancellations from the Node 18/20 matrix.
- Stable Forge packaging is constrained to Node 22.17 because its Packager 18
  extraction exits early on Node 24; a wrapper selects the pinned host runtime
  automatically. Patched `tar` and `tmp` overrides clear the build toolchain's
  dependency audit without changing the shipped runtime.
- Native maker contracts now preserve the `empir3-bridge` Linux executable
  name, merge both `node-pty` helpers into a macOS universal app, and wait for
  the managed engine to stop before the desktop shell exits.
- Codex JSONL `turn.failed` events are now reported as errors even when the CLI
  exits with code zero, preventing an error transcript from becoming a false
  successful agent answer.
- Linux headless repair and rollback no longer attempt writes inside immutable
  `/opt` runtime trees. Same-version repair, signed rollback, and broken-update
  recovery share the bounded installer health gate; a bad release is capped at
  five starts in 60 seconds before the last healthy release is restored.
- Windows Squirrel maintenance events no longer fall through into normal
  Electron startup during uninstall. The installer harness also preserves
  native Windows known-folder resolution instead of allowing a fake profile to
  redirect Squirrel to the current drive root.
- The Windows signing-tool bootstrap now extracts NuGet packages through a
  temporary ZIP name, avoiding PowerShell's `.nupkg` extraction rejection.
- Packaged executable discovery is scoped to the exact Forge target directory,
  so recoverable test quarantine cannot be mistaken for a live package.

### Security

- Custom-provider relay calls make one upstream model attempt with no hidden
  retry loop. Requests and responses are size-capped, active relay turns are
  capped at four, and a Bridge stores at most 25 custom providers.
- Production artifact authentication is explicit per platform. Windows must
  carry verified Azure Authenticode, macOS must be Developer ID-signed,
  notarized, and stapled, and Linux bytes must be hash-bound by the production
  Ed25519 schema 3 manifest. Test channels cannot claim Linux manifest
  authentication, and the publisher re-verifies the production trust root.
- Headless services run as a dedicated non-root account with root-owned code,
  writable state outside the runtime tree, memory limits, one update attempt,
  and no hidden retry loop. Purging provider data remains a separate explicit
  action.

## [0.3.54] - 2026-08-03

### Fixed

- VPS SSH now removes inherited Windows permissions from its ephemeral private
  key and grants read access only to the signed-in account. Windows OpenSSH no
  longer rejects Bridge-routed VPS commands as an unprotected key file.

## [0.3.53] - 2026-08-03

### Fixed

- VPS SSH now authenticates and runs the requested command through one sudo
  process. This preserves command stdin and works on Ubuntu configurations
  that scope sudo validation tickets to the validating process.

## [0.3.52] - 2026-08-03

### Added

- **An explicitly selected Bridge can now run VPS commands over SSH from the
  user's computer.** The private key exists only in a permission-restricted
  temporary file for the connection, the sudo password is supplied on stdin,
  output and time are bounded, and background jobs use opaque one-shot IDs.
  The Bridge never silently retries a VPS mutation through another route.

## [0.3.49] - 2026-07-31

### Fixed

- **agy turns now honor the selected model.** `AGY_PTY_CLI_SPEC` gains
  `modelFlag: { flag: '--model' }` — agy ≥1.0.10 has a real `--model` flag
  (the spec omitted it when agy ≤1.0.3 errored on the flag), so server-routed
  agy turns and `:see` vision calls silently ran Antigravity's default model
  no matter what the route selected. Model ids must match `agy models`
  output exactly (effort tier baked in, e.g. `gemini-3.6-flash-high`);
  unknown ids now surface as turn errors instead of silently downgrading.
  Verified against agy 1.1.9.

## [0.3.48] - 2026-07-31

### Security

- Raised `@modelcontextprotocol/sdk` to 1.30.0. Its Windows HTTP adapter now
  resolves to `@hono/node-server` 2.0.5 or newer, closing the encoded-backslash
  static-file path traversal advisory (GHSA-frvp-7c67-39w9). The public release
  lockfile is regenerated so clean installs cannot retain the vulnerable
  1.19.x adapter.

## [0.3.47] - 2026-07-29

### Added

- **Linux headless self-update (`scripts/self-update.sh`).** Windows bridges
  follow the payload manifest and roll within minutes of a release; Linux
  clones under systemd had no update path and drifted until someone ran a
  manual `git checkout`. `self-update.sh install [dir] [unit]` installs
  itself to `/usr/local/bin/empir3-bridge-update` plus a systemd timer
  (every 30 min ± 10 min random stagger, `Persistent=true`); each run checks
  the clone's `origin` for the highest `vX.Y.Z` release tag and, when
  strictly newer than the local `package.json` version, does
  fetch → checkout → `npm ci` → restart. Forward-only, release-tags-only
  (never a branch head), flock-guarded, git/npm run as the clone's owner
  (root git on a user-owned checkout trips `safe.directory`), and a failed
  dependency install or a bridge that doesn't answer `/api/status` within
  60s rolls back to the previous ref — a bad update degrades to "still on
  the old version", never "bridge down".

> Note: 0.3.42–0.3.46 shipped without changelog entries (agent-tab titles,
> phone-viewport tools, server sync skip + encoded-frame caps, enrollment
> device tokens, per-agent browser tabs). See the release tags for details.

## [0.3.41] - 2026-07-28

### Added

- **Fleet health reporting (Phase 7.4, server Phase 1 counterpart).** The
  bridge now sends `device:identity:report` once per connect (bridge version,
  platform profile, deviceClass, declared tags, tool categories — the roster
  row) and periodic `fleet:health:report` beats driven by the server's
  `fleet:health:config` frame. A server that never sends the config frame
  gets exactly the old behavior.
- **`src/system-metrics.js` — shell-free pure-Node collector.** Real CPU%
  (os.cpus() tick deltas — the old sysinfo path hardcoded 0), real disk via
  `fs.statfs` over real mounts (old path: zeros), `/proc/meminfo`
  MemAvailable + swap, `/proc` process count, battery via
  `/sys/class/power_supply`. No PowerShell, no process per beat — this
  improves Windows too (the old rich-scan path shelled `Get-Counter
  -SampleInterval 1`, stalling a second per call; that path is untouched and
  now only used for on-demand pulls).
- **Back-pressure rules baked in:** skip the tick when the socket isn't OPEN
  (never queue — stale metrics are worthless and a queue is a leak on a box
  offline for a day); skip when `bufferedAmount` > 256KB; 5s collection
  budget with `partial:true` + named errors ("alive but disk stat failed" ≠
  silence); 5× backoff after 3 consecutive failures; server-pushed interval
  clamped to [15s, 900s] so a misconfiguration can make neither a DDoS nor
  silence; every tick jittered.
- Fleet tags are device-declared (`fleetTags` in bridge settings or
  `EMPIR3_FLEET_TAGS` env), never synced back from the server.

## [0.3.40] - 2026-07-28

### Added

- **Linux headless support is now real end-to-end (Fleet Phase 7.2 + 7.3).**
  Verified on a real Ubuntu host with no Chromium installed: the bridge boots,
  survives, executes shell commands, and shuts down cleanly under systemd.
- **Lazy Chromium.** `EMPIR3_CHROME_AUTOLAUNCH=0` (the headless-entry default)
  now actually skips the eager Chrome launch — previously the env var existed
  but `bridge.ts` never read it, so a 2GB VPS spent ~300MB on a browser at
  boot and then polled a missing DISPLAY forever. First browser tool call
  launches Chromium on demand. `findChrome()` also picks up
  `/usr/bin/chromium`, `/snap/bin/chromium`, and `google-chrome-stable`.
- **Structured `capability_unsupported` refusals.** Desktop-control tools
  (GUI input, windows, clipboard, notifications, app control, PowerShell
  sysinfo queries) are Windows-only; on Linux/macOS the two dispatchers now
  return `{ success:false, code:'capability_unsupported', capability,
  deviceClass, hint }` instead of 270 call sites ENOENTing on
  `powershell.exe`. New `src/platform-profile.js` reports
  `deviceClass: 'workstation' | 'server'` (surfaced in `/api/status`) so UIs
  can render servers with a server tool palette rather than rows of broken
  desktop buttons.
- **POSIX shell execution.** `desktop:execute` now runs commands through
  `/bin/bash -c` (or `/bin/sh`, or `pwsh` if requested and present) on POSIX
  instead of ENOENTing on a hardcoded `powershell.exe`.
- **POSIX path safety — shipped in the same release as the shell branch, on
  purpose.** File reads on Linux are now guarded by a boundary-matched
  blocklist (`/etc`, `/root`, `/proc`, `/sys`, `/dev`, `/var/lib`, …, plus
  credential fragments like `~/.ssh/`, `/.aws/`, `/proc/*/environ`), while
  `/var/log`, `/srv`, `/opt`, `/home`, `/usr/local` stay readable.
  `EMPIR3_ALLOWED_ROOTS` enables allowlist mode. The shell blocklist gained
  its POSIX twin (`dd of=/dev/`, `mkfs`, curl-pipe-shell, sudoers,
  firewall flush, `systemctl reboot`, …).
- `scripts/smoke-headless.mjs` (`npm run smoke:headless`) — boots the
  headless entrypoint in an isolated state dir and asserts the whole
  contract above; 18/18 on Linux, 9/9 on Windows.

### Fixed

- `withinPath` case-folded on every platform, which on case-sensitive Linux
  filesystems made the write-jail check MORE permissive (`/data/Jail` passed
  as inside `/data/jail`). Folding now only happens on Windows/macOS.
- The `Remove-Item -Recurse -Force` shell block was dead regex (`\b-Recurse`
  can never match after a space — no word boundary between space and `-`).
  Found by the first unit test ever pointed at the blocklist.
- `desktop:sysinfo` PowerShell queries, COM scans, and clipboard/notify/
  window/app handlers no longer produce raw spawn errors off-Windows.

## [0.3.39] - 2026-07-28

### Added

- `Empir3Setup.exe` is now Authenticode-signed via Azure Trusted Signing.
  First signed release — replaces the unsigned bootstrapper that
  SmartScreen/Defender flagged as an unknown publisher. No runtime changes;
  the payload is a rebuild of 0.3.38 under the new version so all channels
  stay in lockstep.

## [0.3.37] - 2026-07-19

### Fixed

- Claude turn attach verification: `mcp_servers` status `"pending"` in the
  CLI's init event no longer counts as a failed attach. The init event can
  fire while the MCP connection is still completing; on a slowed machine that
  race was lost on every turn and the verifier hard-failed healthy attaches
  (E-025 — took the admin-fallback build lane down for a day). Pending now
  streams unverified (fail open), matching the verifier's documented
  "only a positively-reported failure counts" rule.

## [0.3.33] - 2026-07-14

### Fixed
- **The AUTH badge is honest about dead credentials, not just missing ones.** The API & CLIs pane used to mark a CLI `AUTHED` whenever its credentials file merely *existed* — so a token that had been revoked or whose login had lapsed still showed green, and a lent CLI in that state would pop a browser login mid-turn. Each per-CLI auth signal now parses the file, requires the CLI's *own* auth block (`~/.claude/.credentials.json` also holds the Higgsfield MCP login — a file with only that block no longer false-reads as a Claude Code login), and flags a token as dead only when its long-lived **refresh** credential has expired (surfaced as a distinct `EXPIRED · RE-AUTH` badge). Short-lived access-token expiry is deliberately never flagged — every one of these CLIs refreshes silently, so flagging it would be a false "needs auth". The badge auto-refreshes every 15s and on Re-scan, so a genuine logout/expiry now shows within seconds without a click. Live server-side revocation *within* the refresh window still isn't detectable without a token-endpoint call (which can rotate and break the CLI's own refresh token), so that one case is intentionally left alone.

### Added
- **`bridge_scale` — run multiple agents each on their own browser, in parallel.** A single bridge tracks one active tab shared by every client, so two agents driving it fight over one tab. `bridge_scale` spins up extra fully-isolated bridge instances — each with its own wrapper/CDP/Chrome-debug ports and its own Chrome profile, so the active-tab pointer lives per-instance and there is zero cross-talk (one agent per browser). `action: "up"` (count 2–4) ensures that many total instances are running and returns each extra's `BRIDGE_URL`; `"status"` lists every instance; `"down"` stops the extras. Instance 1 is the primary bridge the `browser_*` tools drive and is never launched or killed by scaling. Drive an extra instance from the CLI (`BRIDGE_URL=<url> npx tsx src/cli.ts <cmd>`) or by registering a second MCP server with `env.BRIDGE_URL` set to it. Siblings are spawned from the extracted payload in a real install (so it works for shipped installs, not just dev checkouts) and run **local-only** — they don't open a second Empir3 relay socket, since all instances share one device identity. Capped at 4 total (each instance is a full Chrome). See `MULTI_BRIDGE.md`.

## [0.3.31] - 2026-07-03

### Added
- **`desktop_screenshot` `detail` option — cheaper by default, full resolution on demand.** A desktop capture (especially a multi-monitor stitch) is embedded into the agent's context and re-billed on every subsequent turn, so it now defaults to a downscaled image. `detail: "low"` (default) returns a ~1000px JPEG that is enough to locate things on screen; `detail: "high"` returns a ~1600px JPEG for reading small text or a specific setting; `detail: "max"` returns the untouched native-resolution capture for the rare case where "high" is not enough. `desktop_screenshot_zoom` is unchanged (still native-resolution for pixel-exact work).

### Changed
- **Smaller MCP tool-result payloads to cut context token cost.** Tool results persist in the model's context and are re-billed on every later turn, so oversized results dominate long-session usage. JSON results are no longer pretty-printed (indentation was 15–30% of every result); `browser_status` returns a compact summary instead of the full page-visit history + auth-user object; and `desktop_screenshot`/`desktop_screenshot_zoom` no longer duplicate the image base64 into the accompanying text block (the daemon had been emitting it several times over). No change to what any tool does.

## [0.3.30] - 2026-07-02

### Added
- **One-shot Grok text runs over the Empir3 channel (`grok:cli:run`).** The server's deep-research real-time/X leg can now run a lent Grok Build CLI prompt→text via the same proven invocation the MCP `cli_run` tool uses (`--prompt-file`, plain output, isolated home). Previously this message type didn't exist in the released daemon, so the server waited out its full watchdog on every attempt.

### Fixed
- **Unknown CLI actions answer with an error instead of silence.** When the server sends a `claude/codex/gemini/grok/agy:cli:*` action this daemon version doesn't know (e.g. a newer server talking to an older bridge), the daemon now replies with a `<cli>:cli:error` naming the unsupported action, so the server fails fast with a real reason instead of timing out.

## [0.3.29] - 2026-06-30

### Fixed
- **A lent Grok (`cli_run`) no longer reads your global Claude configuration.** xAI's Grok CLI is a Claude-Code-compatible drop-in: it resolves `~/.claude` (your `settings.json` hooks and global `CLAUDE.md`) from the home/profile environment variables. When the bridge spawned Grok this fired your `PreToolUse` hooks — and on Windows, hook commands that are extension-less scripts are launched via `ShellExecute`, which has no file association for them, so each search popped a "Select an app to open…" dialog. It also pulled your global `CLAUDE.md` into Grok's context on every run. Grok now runs with its home pointed at a private directory that links to its own `~/.grok` (auth, config, and history preserved and shared with interactive Grok) but contains no `.claude`, so it sees only its own configuration — no stray dialogs, nothing extra sent upstream.

## [0.3.28] - 2026-06-29

### Fixed
- **Lent Antigravity (`agy`) `cli_run` turns are no longer empty.** agy's print mode doesn't flush stdout to a non-TTY pipe, so captured turns came back blank; it now runs under a ConPTY (like agy's other turn paths) so its text is captured.

## [0.3.27] - 2026-06-29

### Fixed
- **The Antigravity (`agy`) auth button works, and the false "authenticated" badge is gone.** The button is now wired to the real auth flow, and the status probe no longer reports `authenticated: true` before a login has actually completed.

## [0.3.26] - 2026-06-29

### Fixed
- **The bridge recovers from a half-open connection to the Empir3 server.** A server socket that silently stopped delivering data is now detected via a pong timeout, and the bridge reconnects instead of appearing connected while receiving nothing.

## [0.3.25] - 2026-06-29

### Fixed
- **Higgsfield no longer shows "NEEDS AUTH" with a valid login.** The bridge's auth probe only accepted access tokens with the legacy `hf_` prefix, but the current Higgsfield (Clerk OAuth) CLI issues `oat_`-prefixed tokens — so `higgsfieldStatus` reported `authenticated: false` even with valid, working credentials (and could stop the bridge from routing failover Higgsfield turns). The probe now accepts both `hf_` and `oat_` token formats.

## [0.3.24] - 2026-06-26

### Fixed
- **Codex vision (`:see`) prompt is passed via stdin** instead of a `cmd.exe`-shredded argv, mirroring the earlier Claude `:see` fix.
- **`screenshot_zoom` includes the base64 image payload** in the relay envelope, so the zoomed capture actually reaches the caller.

## [0.3.23] - 2026-06-26

### Fixed
- **Claude vision (`:see`) no longer hallucinates.** Routing an image to a lent Claude for description could come back describing "a Claude Code terminal" instead of the real picture. Cause: the whole prompt — the image `@ref` plus the (~10 KB) Empir3 system/instruction — was passed as a single positional argument to the claude `.cmd` shim through `cmd.exe`, whose command line caps at ~8191 chars. The oversized argument either errored ("The command line is too long.") or, just under the cap, was word-split so the leading `@<image>` ref was dropped — claude then ran with no image and made one up. The full prompt (with the `@<image>` ref on its first line) is now written to a prompt file and passed as a short `@<promptfile>` argument, mirroring the proven `cli_run` / Antigravity file-reference path. The image and prompt files now live under `~/.empir3-bridge` instead of system TEMP.
- **Antigravity (`agy`) vision (`:see`) now returns text.** agy's `-p` print mode doesn't flush stdout in a non-TTY spawn — the same reason agy turns and image generation already run through node-pty — so `:see` came back empty. `:see` now routes through the node-pty turn path like agy `:turn`, carrying the image as an inline `@<path>` ref and streaming the description back.
- **Higgsfield video route survives the capability probe.** The bridge now answers `higgsfield:cli:probe`, so the CLI video-generation route is no longer dropped.
- **agy image generation harvests the produced image** from agy's conversation brain directory, fixing a regression introduced by Antigravity CLI 1.0.10.

### Removed
- **Dead `gemini-cli` entry.** Google retired the individual gemini-cli tier, so it is removed from the `cli_run` / `cli_status` roster and the bridge's API & CLIs pane. Antigravity (`agy`) is a separate CLI and is unaffected.

## [0.3.22] - 2026-06-21

### Added
- **`empir3-bridge-mcp` bin** — run the MCP stdio server straight from the published npm package, no clone required. Wire it into any MCP client's `.mcp.json` with `npx -y -p @empir3/empir3-bridge empir3-bridge-mcp`. Runs `src/mcp-server.ts` through the bundled `tsx`; the companion `empir3-bridge` bin still starts the daemon directly.

### Changed
- Published to npm as `@empir3/empir3-bridge`.

## [0.3.21] - 2026-06-18

### Added
- **Playback transport bar.** Replaying a recording now shows a media-player-style transport at the bottom of the page: a draggable scrubber (drag back to rewind — re-runs from the start to that point since actions can't be undone; drag forward to fast-forward), Restart / Pause-Resume / single-Step / Stop buttons, and live speed pills (0.5×/1×/2×/4×). Previously the only options were Rec and Play, with no way to pause, stop, scrub, or change speed once a recording started. Backed by six new interruptible-playback commands (`playback_pause`/`resume`/`stop`/`step`/`speed`/`seek`) that ride the same WS/CDP-mailbox path as Rec/Stop, so the controls work on both http and https pages.

### Fixed
- The transport bar stays visible across the page navigations a recording performs, and re-syncs its state — including the current action when synced mid-pause — to any overlay that announces mid-playback (so it also shows on https pages, which drive the overlay over the CDP mailbox). (Refines the 0.3.19 transport bar across 0.3.20–0.3.21.)

## [0.3.18] - 2026-06-16

### Fixed
- **Lent CLIs advertise availability even when Execute is off.** The per-device Execute gate was also blocking the read-only capability `:probe` that a lent CLI uses to report it's installed and authenticated, so `cli_status` could show a lent model as unavailable until Execute was turned on. The read-only `:probe` now passes the gate for every CLI prefix; the actual `:turn` and `github:exec` still require Execute.

## [0.3.15] - 2026-06-16

### Fixed
- **Tray no longer falsely shows "Daemon not running."** A periodic local-workspace sync was re-hashing the entire synced workspace every 5 seconds, saturating the daemon's event loop enough that health pings timed out and the tray reported the daemon dead while it was actually alive and serving. The sync now re-walks the workspace every 30 seconds instead of every 5, and the dashboard daemon pills reflect true daemon liveness rather than the CDP/browser link state. (0.3.13, 0.3.15–0.3.17.)

## [0.3.13] - 2026-06-16

### Added
- **Single-call vision for lent CLIs.** Image-bearing turns to Codex, Gemini, Antigravity, and Claude now carry the image into a single CLI turn instead of dropping it or splitting it across a separate caption pass — a lent model can actually see the image you sent, in one call.

### Fixed
- Browser close lifecycle: debounced the "closed by user" latch to stop a post-refresh flap.

## [0.3.9] - 2026-06-15

### Fixed
- **Faster, reliable image vision (`:see`).** Fixed the daemon-only hang when attaching an image (null stdin + the bare `claude -p` invocation that works in-daemon), switched the attachment to an absolute `@<path>`, and re-added `--strict-mcp-config` to skip the ~10s MCP startup tax per call. (0.3.5–0.3.9.)

## [0.3.4] - 2026-06-06

### Fixed
- **Bridge no longer wedges when a second instance launches over a stale one.** The payload daemon binds the bridge + wrapper ports in-process but had no single-instance guard, so a daemon launched while a stale/wedged predecessor still held the ports would collide (EADDRINUSE, zombie Chrome, "CDP direct timeout"). The daemon now reaps a predecessor still holding the bridge/wrapper/CDP ports (only `node.exe`/`chrome.exe` — never an unrelated app) before binding, so a fresh launch reliably replaces a stuck one. The dev launcher (`npm run kill` / `npm start`) had the same gap — its port cleanup skipped the installed payload daemon, leaving two bridges colliding — and now reaps it too.

## [0.3.3] - 2026-06-06

First public open-source release.

### Added
- **`--pair <code>` first-run auto-pairing.** `Empir3Setup.exe --pair <code>` redeems a pre-authorized Empir3 pairing session on first boot, so an install link can pair the bridge to an account with no second login.
- **Light/dark toggle on the in-page chat panel.**

### Fixed
- Stopped the in-page chat panel double-rendering messages on socket-capable pages.

## [0.3.2] - 2026-06-04

### Fixed
- Bootstrapper launcher fixes: supervised no-tray fallback, and the spawned tray is no longer placed in a kill-on-close Job Object (which had been terminating it).

## [0.3.1] - 2026-06-04

### Fixed
- Tray now launches reliably on a clean machine (a kill-on-close Job Object was killing it). Embedded the application icon in the installer exe.

## [0.3.0] - 2026-06-04

### Changed
- **Native Go bootstrapper.** Replaced the ~86 MB Node-SEA installer with a ~6.6 MB native `Empir3Setup.exe` that fetches and Ed25519-verifies a signed payload before running anything (schemaVersion 2 manifest + signed Node runtime artifact).

## [0.2.96] - 2026-06-04

### Fixed
- **Uninstall no longer phones home — it's now a network-free teardown.**
  The bootstrapper ran its full update check (`tryUpdate`, including a payload
  re-download) on `--uninstall` *before* doing anything — i.e. it could fetch
  the very payload it was about to delete, and would stall or misbehave
  offline. `main()` now intercepts `--uninstall` before any network logic and
  tears the install down using only what's already on disk: it delegates to
  the cached payload's canonical uninstall when one is extracted, and falls
  back to a self-contained native cleanup (kill tray + daemon, remove
  autostart, Chrome force-install policy, Start Menu shortcut, and the
  `~/.empir3-bridge` + `%APPDATA%/Empir3` trees) when no usable payload is
  present — so a corrupt or half-installed payload can never leave a user
  unable to uninstall. Native path shows the same completion dialog.

### Changed
- Bootstrapper internal version → **1.1.0** (`Empir3Setup.exe --bootstrap-version`),
  so the new network-free uninstall is identifiable in the field. This release
  rebuilds `Empir3Setup.exe`, so testing the fix requires re-downloading the
  installer (not just a payload auto-update).

## [0.2.95] - 2026-06-04

### Changed
- **Uninstall now reassures the user instead of silently vanishing.** After
  0.2.94 made Uninstall actually work, it gave no feedback — the tray just
  closed, leaving the user unsure whether anything happened. Added a proper
  flow: (1) a native Yes/No confirmation dialog before anything is deleted
  (defaults to No, cannot be undone), (2) an "Uninstalling Empir3…" balloon,
  and (3) a "Empir3 Bridge has been uninstalled" completion dialog shown by
  the bootstrapper once the wipe finishes — necessary because the bootstrapper
  kills the tray as its first step, so the tray can't report completion
  itself. Missing-bootstrapper and spawn failures now raise an error dialog
  instead of failing silently.

## [0.2.94] - 2026-06-04

### Fixed
- **Tray "Uninstall Empir3" now actually uninstalls.** Clicking Uninstall
  appeared to do nothing — the tray window just closed and every install
  artifact stayed on disk. The tray's uninstall handler looked for
  `Empir3Setup.exe` only *next to the tray exe* (`payload/<version>/`), but the
  bootstrapper lives in `%APPDATA%/Empir3/`, so it never found it and logged
  `bootstrapper not found; cleanup partial` before exiting. The daemon-spawn
  path resolved the bootstrapper correctly via a 4-step chain
  (`EMPIR3_BOOTSTRAP_EXE` → `bridge-bootstrap.json` pointer → autostart reg →
  sibling) while uninstall used only the sibling check. Both paths now share a
  single `resolve_bootstrap_exe()` helper so they can't drift, and Uninstall
  spawns the real `Empir3Setup.exe --uninstall` cleanup.

## [0.2.89] - 2026-06-03

### Added
- **Antigravity (AGY) surfaced as a first-class lendable CLI.** Google's
  Antigravity headless CLI (`agy`, has `-p/--print`) was probed in the backend
  but invisible — no pane row, not drivable via `cli_run`, undetected by the
  resolver. Now: the resolver finds it at `%LOCALAPPDATA%\agy\bin` / `~/.local/
  bin`; the API & CLIs pane shows an **Antigravity** row with a lend toggle +
  install link; and `cli_run`/`cli_status` accept `model:"agy"` (driven as
  `agy --dangerously-skip-permissions -p @<promptfile>`, mirroring the relay
  turn path). Lending is off by default like the others. Note: the IDE launcher
  `antigravity-ide` is the GUI opener, not the drivable CLI — the bridge needs
  `agy`. Verified detection + auth surface through the live server.

### Added
- **Detect the Claude Code editor-extension binary.** The Claude Code VS Code /
  Cursor extension bundles a full, headless-capable native `claude` at
  `<ext>/resources/native-binary/claude[.exe]` but never adds it to PATH — so
  `where claude` finds nothing even though Claude works in the editor, and the
  bridge reported NOT INSTALLED. The resolver now finds it (newest extension
  version wins) as a **last resort**, so a user who only has the extension —
  no separate CLI — is auto-detected and can lend Claude without a second
  install. A real standalone install still ranks ahead (PATH / npm). Verified
  the bundled binary runs `--version` → `2.1.161 (Claude Code)`.

### Changed
- **Detect Claude Code's local-installer location.** Added `~/.claude/local`
  (and `~/.claude/local/node_modules/.bin`) to the well-known toolchain dirs —
  the target of `claude migrate-installer`, also off-PATH.

## [0.2.87] - 2026-06-03

### Changed
- **CLI detection rewritten in-process (no more `where.exe` / `which`).** The old
  detection shelled out to `where.exe`/`which`, which run with the *daemon's*
  PATH — a tray/GUI-launched process inherits a stripped, stale PATH (winget edits
  the user PATH after the daemon started; node-version-managers expose bins only
  in the shell), so a CLI that resolved fine from the user's terminal read NOT
  INSTALLED in the bridge. Detection is now centralized in a single
  `executable-resolver` (modeled on open-design's runtimes/executables): it splits
  `process.env.PATH` in-process, walks `PATHEXT`, and **augments** the search with
  a cross-platform list of well-known user-toolchain dirs (npm prefix, `%APPDATA%\
  npm`, winget Links + Packages, pnpm, bun, Volta, Scoop, Yarn, cargo, deno,
  `~/.local/bin`, and per-version nvm/fnm node bins). Every shipped CLI (claude,
  codex, gemini, grok, gh, higgsfield) now routes through it — no more scattered
  per-CLI `find*` functions drifting out of sync. Verified: with PATH stripped to
  System32, all six still detect via the well-known dirs.
- **Per-CLI binary override.** `CLAUDE_BIN`, `CODEX_BIN`, `GEMINI_BIN`, `GROK_BIN`,
  `GH_BIN`, `HIGGSFIELD_BIN` (and `AGY_BIN`) point detection at an exact binary
  when the conventional locations miss — an explicit escape hatch.

## [0.2.86] - 2026-06-03

### Fixed
- **winget-installed CLIs now detected.** A CLI installed via `winget` lives at
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\<id>\(bin\)?<exe>` and is exposed via
  the `WinGet\Links` shim — but the daemon's PATH often lacks both (winget edits
  the *user* PATH after the daemon already started), so `where.exe` missed it while
  the user's own shell found it. `findGhBinary` (GitHub CLI) and the generic
  `findKnownWindowsExecutableCandidates` now scan the winget Links + Packages tree
  directly, independent of PATH. Fixes `gh` (and any winget-installed CLI) showing
  NOT INSTALLED when it's actually present.

## [0.2.85] - 2026-06-03

### Added
- **CLI install help + download links.** Every CLI shown as `NOT INSTALLED` on the
  API & CLIs pane now gets an inline helper row: the exact install command (with a
  Copy button), an "Official page ↗" link, and an **Install** button that runs the
  command in a visible console — plus the nudge *"or just tell your agent to install
  it."* A single `CLI_INSTALL` catalog is the source of truth, also feeding
  `cli_status` (not-installed models now carry `installCommand` + `installUrl`, so a
  user can tell their driving agent "install gemini" and it runs the right command).
  New `POST /api/cli/install` endpoint and a **↻ Re-scan** button so a freshly
  installed CLI is picked up without a full reload.

### Changed
- **Wider CLI detection.** `findKnownWindowsExecutableCandidates` now also probes
  pnpm (`$PNPM_HOME`), bun, Volta, Scoop shims, winget Links, Yarn, and
  `~/.local/bin` (native installers) — fewer false `NOT INSTALLED`. macOS/Linux
  detection no longer relies on `where.exe`; it falls back to `which -a` plus the
  Homebrew / `/usr/local` / `~/.local/bin` roots.

## [0.2.84] - 2026-06-02

### Added
- **Click-to-exit on the focus box.** Selecting a `desktop_select_region` now
  shows a small ✕ close button just outside the box's top-right corner; clicking
  it releases the focus region directly (no agent command needed). The button is
  a normal top-most window (reliable click), sits outside the region bounds so
  it's never captured in a region screenshot, and tears down with the focus.

## [0.2.83] - 2026-06-02

### Added
- **Accuracy Lab** test surface at `/accuracy-lab` — a dense, Photoshop-style UI
  with many small, tightly-packed click targets that scores hit/miss/mean-error,
  a harder click-accuracy stress test than `/desktop-test`. Served from
  `assets/accuracy-lab.html` (staged into the payload for the packaged daemon).

## [0.2.82] - 2026-06-02

### Changed
- **`desktop_select_region` focus lifecycle — idle-revoke replaces the fixed
  30-min TTL.** Previously a selected focus region was hard-killed 30 minutes
  after selection regardless of use: the on-screen chip silently vanished and
  the next focus-scoped call quietly grabbed the whole monitor ("lost connection
  with no explanation"). Now the 30-min timer is an *idle* timer — every real
  scoped use (screenshot, click, hover, drag, snapshot_som, cell/point ops,
  showing the grid) resets it via a new internal `touchDesktopFocus()`, so
  active work never drops the region. A region only auto-clears after a full
  30 minutes with no scoped use. Pure status reads (`desktop_focus_status`) do
  NOT extend the region.

### Added
- **Persistent ("keep until I release") focus mode.** `desktop_select_region`
  accepts `keepOpen: true` (alias `persist: true`) to create a region with NO
  expiry — it lives until `desktop_release_focus` (or a new selection). A global
  default, settings key `desktopFocusKeepOpenDefault`, makes persistence the
  default for all regions; the per-call flag overrides it either way. Useful for
  long-running watches ("watch this page overnight").
- **No silent scope loss.** When a focus-scoped `desktop_screenshot` runs but no
  region is active (expired or released), the result is now annotated with
  `focusExpired: true` + a short `focusNote` instead of silently falling back to
  the whole monitor/desktop with no signal. The fall-back capture still happens
  (non-breaking); it's just observable now. Explicit-monitor and `noFocus:true`
  calls are never flagged.
- **`desktop_focus_status` reports the mode.** Adds `persist` (boolean) and
  `mode` (`"idle-revoke"` | `"persistent"`); `remainingMs` is `null` for
  persistent regions (no expiry) and otherwise the ms until idle auto-clear
  (resets on each scoped use). Adds `ttlMs` for reference.

## [0.2.81] - 2026-06-02

### Added
- **`cli_status`** — a read-only MCP tool that reports the lent-CLI roster so the
  driving agent can discover what it can run *before* calling `cli_run`. Per
  model (codex / grok / gemini / claude): `available` (installed), `lent` (owner
  toggle on), `authenticated` (signed in), `ready` (all three), and `blocker`
  (`cli_not_installed` / `not_lent` / `not_signed_in` / null). Previously the
  agent only learned a model wasn't usable from a `cli_run` refusal.

### Changed
- **`bridge_tool_advisor`** now covers two intents it was missing: "pull in
  another model's CLI" (→ `cli_status` first, then `cli_run`) and "generate /
  edit an image or video" (→ `higgsfield_*`).

## [0.2.80] - 2026-06-02

### Fixed
- **`browser_press` default actions** — pressing Enter (and Space) delivered the
  key event to JS listeners but never fired the browser's default action, so
  "type then Enter to submit/search" silently did nothing and textarea newlines
  didn't insert. CDP only triggers a key's default action when the keyDown
  carries the produced character; `pressKey` (bridge.ts) omitted `text`, unlike
  `typeText` which sets it per char. Now Enter sends `text:'\r'`, Space sends
  `text:' '`, and a bare single-character press (e.g. `"a"`) types that char.
  Verified via a controlled-form CDP A/B test (no-text → 0 submits; `text:'\r'`
  → submit fires).

## [0.2.79] - 2026-06-02

### Fixed
- **`cli_run` agentic file-writing** — three of the four lent CLIs could not
  actually write files headlessly, each missing its auto-approve flag:
  - **grok** now gets `--always-approve`. grok-build is agentic-first; without
    it any tool call (todo/web/file) blocked on an approval prompt that never
    arrives headlessly → empty stdout *and* no file (affected both text-mode
    structured prompts and agentic writes).
  - **gemini** agentic now gets `--yolo` (was reporting `write_file … not
    available` / read-only).
  - **claude** agentic now gets `--permission-mode acceptEdits` — Write was
    auto-denied yet the model still reported success (silent false-write).
  - **codex** unchanged (already correct via `--sandbox workspace-write`).
- **`cli_run` working directory** now defaults to the bridge's configured Home
  Directory (Daemon pane, `~/Documents/Empir3`) when no explicit `cwd` is
  passed — matching the interactive launcher and the relay `:cli:turn` path.
  Previously fell back to the daemon's own process dir.

## [0.2.78] - 2026-06-02

### Added
- **`cli_run` + `cli_runs` + `cli_run_status`** — the
  MCP-facing primitive for lending another model's CLI to the driving agent.
  `cli_run({model: codex|grok|gemini|claude, prompt|promptFile, cwd?, mode?,
  modelId?, background?, timeoutMs?})` runs that CLI one-shot and returns
  `{text, exitCode, durationMs, transcriptPath, status}`. The bridge owns each
  CLI's invocation quirks (Codex `exec --json` on stdin, Grok `--prompt-file`
  to avoid the big-prompt exit-2, Gemini `GEMINI_CLI_TRUST_WORKSPACE` to avoid
  exit-55, stderr-noise stripping) and writes a transcript under
  `~/.empir3-bridge/cli-runs/`. `background:true` returns a run id; poll
  `cli_run_status(id)` / list with `cli_runs`.

  **Governance:** every run is refused unless that CLI's lend toggle is on
  (the per-model opt-in on the API & CLIs pane) — no keys handed out, the agent
  just borrows the lent seat. Orchestration stays with the calling agent; the
  bridge ships only the primitive (no team/DAG engine). This is distinct from
  the existing relay `<model>:cli:turn` path (Empir3-server-driven streaming),
  which is untouched. `gh` stays its own governed tool; image/video gen stays in
  `higgsfield_*`.

## [0.2.77] - 2026-06-02

### Added
- **`higgsfield_models`** — lists the live Higgsfield model catalog
  (`[{job_set_type, name, type}]`, type = image/video/text), with an optional
  `type` filter, cached ~5 min. So a controlling LLM discovers valid `model`
  ids instead of guessing — the catalog has 40+ job-set-types and changes as
  Higgsfield adds models. Default ON (read).

### Changed
- `higgsfield_generate` description + `model`/`image`/`extra` param docs
  rewritten to be self-documenting: `model` is a `job_set_type` from
  `higgsfield_models` (not free-form), text→image vs image-edit (edit models
  need `image`) vs video, and per-model knobs go in `extra`. Any driving LLM
  can now use Higgsfield correctly without trial-and-error.

## [0.2.76] - 2026-06-02

### Changed
- `desktop_click` now returns a `calibrationHint` (and `monitorAtPoint`) when the
  click lands on a monitor that has no saved click calibration while other
  monitors are calibrated — so an agent can prompt the user to calibrate that
  display. Pure annotation; never changes the click. Closes the last
  reliability nit. (The interactive-snapshot styled-`div`
  item was intentionally not changed: click handlers bound via addEventListener
  are undetectable from the DOM, and the only universal signal — computed
  cursor:pointer — is too noisy to add to default snapshots.)

## [0.2.75] - 2026-06-02

### Added
- **Browser-page → physical-screen coordinate mapping** —
  three tools that let an agent drive the real OS mouse onto an element in the
  bridge's own Chrome page, no hand-rolled calibration:
  - `desktop_click_page({selector|ref|cssX/cssY, button?, double?})` — real
    OS-level click on a page element (trusted hardware click, vs. synthetic
    `browser_click`).
  - `desktop_pointer_page({selector|ref|cssX/cssY, label?})` — ghost cursor on a
    page element (visual only).
  - `page_to_screen({selector|ref|cssX/cssY})` — inspect-only: returns the
    element's physical virtual-screen coords, the calibrated click coord,
    content-window origin, devicePixelRatio, and CSS rect.

  The transform is `physical = contentOrigin + css × devicePixelRatio`, then the
  existing per-monitor click calibration. `contentOrigin` is read from the
  Chrome render-widget child window's physical rect (matched by an
  `innerW×DPR / innerH×DPR` size fingerprint among all Chrome windows, with the
  foreground window as tiebreak) — deliberately *not* `window.screenX/Y`, which
  live in a global logical coordinate space that breaks across mixed-DPI
  monitors. Validated to the pixel on a 3-monitor mixed-DPI rig. Windows-only;
  operates on the bridge's own Chrome. `desktop_click_page`/`desktop_pointer_page`
  default OFF (desktop family); `page_to_screen` is read-only and on by default.

## [0.2.74] - 2026-06-02

### Fixed
- `desktop_screenshot` relay path (`desktop:gui screenshot` / companion): an
  active agent-focus region silently overrode an explicit `monitor` argument.
  Precedence now matches the MCP path — explicit `region` > explicit `monitor`
  > active focus region > default — so asking for a specific monitor while a
  focus region is set returns that monitor, not the focus crop.
- `bridge_reliability_smoke` now captures the active tab's URL before its
  trusted-click test (which navigates to a throwaway `data:` page) and restores
  it afterward. Running the smoke no longer leaves the user's tab parked on the
  test page.

### Changed
- `browser_record_stop` returns a `refNote` when an agent-driven recording
  finishes with zero element refs, clarifying that selector/evaluate-fallback
  replay is expected for agent actions (only user/overlay-captured clicks carry
  accessibility-tree refs) — the bare "0 element refs" count read as a failure.

## [0.2.73] - 2026-06-01

### Fixed
- `browser_text` (and the `desktop:browse text` relay action) no longer includes
  the bridge's own injected overlay UI — the chat sidebar, toolbar, and status
  text ("Bridge Disconnected / Snap / Draw / Send / …"). The overlay roots
  (`id="empir3-*"`) are temporarily detached while reading `innerText`, then
  restored in place within the same JS turn (no flicker), so the returned text
  is just the page under test. This was adding noise that broke downstream
  parsing for agents.
- `browser_snapshot` likewise skips the injected overlay subtree, so the
  overlay's chat input / mode / toolbar buttons no longer appear as interactive
  element refs that don't belong to the page.

## [0.2.72] - 2026-06-01

### Fixed
- `bridge_reliability_smoke` overlay-health gate (added in 0.2.71) now snapshots
  overlay health at the *start* of the run instead of the end. The smoke's own
  internal navigation to a `data:` click-test page drops the overlay, so the
  end-of-run reading was always 0 clients and the gate false-failed even when
  the overlay was healthy when the smoke started.

## [0.2.71] - 2026-06-01

### Fixed
- `desktop_screenshot_zoom` now returns the cropped image inline over MCP (it
  previously returned only a saved path, defeating its purpose).
- `higgsfield_list` no longer forwards an unsupported `--limit` flag to the CLI;
  the limit is applied client-side after parsing.
- `bridge_reliability_smoke` now gates on overlay health — it no longer reports
  a passing run when the overlay is injected-but-dead (`overlayHealthy:false` /
  no connected overlay clients).
- `desktop_screenshot` now lets an explicit `monitor` argument win over an
  active agent-focus region (precedence: explicit region > explicit monitor >
  focus region > all).
- `desktop_toolbar status` (read-only) now works while the toolbar group is
  disabled, and the standard smoke plan marks the toolbar step optional and
  skips `show` when the group is off instead of always failing.
- Ghost-cursor (`desktop_pointer_show`) labels now render non-ASCII characters
  correctly (UTF-8); an em dash no longer becomes mojibake.
- Non-ASCII desktop UIA element names (accented text, icon glyphs) no longer
  arrive mangled as `?`/`??` — desktop PowerShell now emits UTF-8 stdout.
- `bridge_setup_status` no longer reports a stale, frozen recordings count in
  its saved snapshot that contradicted the live count.

### Changed
- `desktop_screenshot {grid:true}` now defaults to virtual-screen coordinate
  labels (directly usable with `desktop_click`) instead of axis indices, and the
  `desktop_screenshot_zoom` local grid labels are spaced so they no longer
  overlap on small crops.
- `desktop_select_region` now draws its instruction banner on every monitor via
  a separate fully-opaque, click-through overlay so the banner is no longer
  faded by the dim veil and it's clear the whole desktop is selectable.
- Click-calibration targets are far more visible: darker focusing veil, brighter
  pending markers, and a high-contrast halo behind the active bullseye.
- `desktop_overlay` numbered boxes are now see-through (transparent interiors,
  opaque borders + labels) so the UI behind them stays readable.
- `browser_snapshot {filter:"interactive"}` now also surfaces elements with
  interactive ARIA state attributes and `contenteditable`.
- `bridge_setup_status` now reports which connected monitors still lack a saved
  click calibration (`uncalibratedMonitors`).
- Softened the `browser_record_stop` summary so agent-driven recordings (which
  replay via selector/coordinate steps) no longer read as a failure.

## [0.2.70] - 2026-06-01

### Changed
- Increased the floating desktop toolbar's usable width and height so the
  recording selector, Open, Refresh, monitor label, and status text render
  without clipping.

## [0.2.69] - 2026-06-01

### Changed
- Reworked `/desktop-test` so the form controls stay visible beside the
  click/drag/screenshot harness at normal bridge-window widths, making the
  smoke page a more complete one-screen test surface.

## [0.2.68] - 2026-06-01

### Added
- Added a standard bridge smoke-test plan at `/api/bridge-smoke-test-plan` and
  `npx tsx src/cli.ts smoke-plan` so agents and maintainers use the same quick
  verification flow.
- Expanded `/desktop-test` into a fuller test lab with click, drag/drop, text,
  textarea, radio, checkbox, select, scroll, screenshot marker, event log, and
  form submission targets.

### Changed
- Refined the floating desktop toolbar into a branded Empir3 control deck with
  focus tools, release/chat/calibration actions, current monitor context, and a
  compact recording/playback transport bar.
- Updated bridge testing docs and the agent guide to require `/desktop-test`
  during general bridge verification.

## [0.2.67] - 2026-06-01

### Fixed
- Agent-driven clicks are now suppressed at the overlay event-capture source
  while recording, so the page does not echo the agent's selector click back as
  a second coordinate click.

## [0.2.66] - 2026-06-01

### Fixed
- Strengthened recording dedupe so delayed overlay echoes are also compared
  against the last saved recording action, dropping the `0,0` coordinate copy
  that can follow an agent-driven selector click.

## [0.2.65] - 2026-06-01

### Fixed
- Recording now drops overlay echo events caused by agent-driven browser
  commands, preventing selector clicks from being saved a second time as
  coordinate clicks during replay.

## [0.2.64] - 2026-06-01

### Fixed
- Overlay readiness now verifies the current page has the injected overlay,
  chat bubble, and cursor hooks before treating the overlay as healthy. Stale
  WebSocket clients on port 3006 no longer prevent reinjection.
- The overlay health loop now repairs a missing current-page overlay even when
  another tab still has an open overlay WebSocket.
- Overlay WebSocket connections now declare `role=overlay` and expose their
  open/close state to the bridge DOM health probe for easier diagnostics.

## [0.2.63] - 2026-06-01

### Added
- Added the 1.6.3 tab-presence model with separate agent-controlled and
  user-focused browser tabs, so opening a new tab does not automatically steal
  control from an agent.
- Injected tabs now show either the normal chat bubble when the agent controls
  the tab, or a compact target bubble on other tabs with explicit actions to
  set user focus or hand that tab to the agent.
- Browser tab title and favicon now indicate when a tab is agent-controlled or
  user-focused, and restore when the state moves elsewhere.
- DOM/ref/selector actions now show a slower virtual in-page agent cursor glide
  and pulse before clicks or field focus, without moving the real mouse.
- MCP now exposes `browser_tab_state` and `browser_tab_focus` for shared
  tab-control state across local MCP and Empir3/Vincent.

## [0.2.62] - 2026-06-01

### Added
- The tray now always shows `Release focus`, and it clears the selected focus
  region, agent pointer, focus grid, desktop overlay, and browser annotation
  artifacts even when no region is currently selected from the tray.
- Desktop Tools now includes first-use Testing Tools And Calibration status,
  recording start/stop/list/load/playback controls, and per-monitor or
  all-monitor click calibration controls.
- MCP now exposes `bridge_setup_status`, `bridge_setup_save`, and
  `desktop_toolbar` so agents can confirm calibration readiness and open the
  movable desktop tools widget.
- The tray can open a movable desktop toolbar with focus, release, chat
  injection, record, playback, saved recording selection, and quick monitor
  calibration actions.

### Changed
- Bridge-owned overlay injection now runs by default so the chat bubble and
  recording/playback hooks are present after startup without relying on the
  extension path alone.

## [0.2.61] - 2026-06-01

### Fixed
- The browser overlay is now self-healing: when CDP is connected but no overlay
  client is present, the bridge periodically re-injects the overlay instead of
  waiting for a URL change or manual desktop-tools injection.
- `browser_record_start` now verifies that the overlay client is connected
  before starting capture. If injection fails, recording does not start, so it
  cannot silently save a zero-action recording.
- Playback now clears the `isPlaying` guard in a `finally` block so a failed
  replay cannot leave the bridge stuck in `Already playing a recording`.

### Added
- `bridge_overlay_reinject` repairs and verifies the overlay on demand for MCP,
  chat, and direct `/api/command` callers.

## [0.2.60] - 2026-06-01

### Fixed
- Browser navigation now bypasses the generic CDP fallback chain and confirms
  success from Chrome target metadata after a short direct `Page.navigate`
  attempt. This keeps wrapper/Vincent navigation from timing out after Chrome
  has already moved the tab.

## [0.2.59] - 2026-06-01

### Fixed
- Browser CDP commands now prefer a fresh page-level websocket before any
  stale persistent socket, avoiding minute-long fallback stalls after tab
  navigation.
- Bridge `/health` now uses cheap target discovery instead of active
  `Runtime.evaluate` probes, so passive status checks cannot pile up behind
  browser commands.
- Browser navigation returns from Chrome target metadata and has a wrapper
  timeout, so agents receive a failure instead of hanging indefinitely if
  Chrome does not answer.

## [0.2.58] - 2026-06-01

### Fixed
- Browser navigation now uses shorter CDP cleanup/readiness probes after
  `Page.navigate`, so wrapper-mediated browser commands can return when Chrome
  has already loaded the page instead of hanging on late readiness checks.

## [0.2.57] - 2026-06-01

### Fixed
- The HTTP wrapper now talks to the CDP bridge on `127.0.0.1` instead of
  `localhost`, matching the bridge bind address and avoiding localhost
  resolution/loopback stalls during wrapper-mediated browser commands.

## [0.2.56] - 2026-06-01

### Fixed
- Browser commands now try the already-connected page CDP socket first, then
  fall back to fresh direct/browser-session sockets. This keeps the default
  installed profile responsive while preserving the recovery paths added for
  stale socket states.

## [0.2.55] - 2026-06-01

### Fixed
- The payload daemon now waits for `/health` to report `status:"connected"`
  before loading the HTTP wrapper, preventing wrapper polling from racing a
  half-started Chrome/CDP bridge.
- Browser health and page commands now try the direct page CDP websocket first,
  with browser-level `Target.attachToTarget` kept as a fallback, matching the
  path that stays fast in bundled bridge+wrapper runtime smoke tests.

## [0.2.54] - 2026-06-01

### Fixed
- Browser health and page commands now open a fresh browser-level CDP websocket
  per command before attaching to the active target, matching the live packaged
  runtime where shared in-process websocket requests can stall even while target
  events continue flowing.

## [0.2.53] - 2026-06-01

### Fixed
- Browser health and page commands now prefer Chrome's browser-level
  `Target.attachToTarget` session path, with direct page websockets only as a
  fallback. This matches the live packaged runtime where browser-level CDP
  stays reliable even when page websocket commands intermittently stall.

## [0.2.52] - 2026-06-01

### Fixed
- Browser health and commands now use verified per-command page CDP sockets
  without closing the long-lived target-tracking socket, fixing live Chrome
  profiles where the persistent page socket wedges while fresh CDP sockets
  still answer immediately.

## [0.2.51] - 2026-06-01

### Fixed
- Browser/CDP readiness now requires a real `Runtime.evaluate` round trip
  instead of reporting connected from Chrome target metadata alone, preventing
  false-green status while `text`, `snapshot`, `screenshot`, `navigate`, or
  click commands time out.
- Browser commands invalidate unhealthy CDP state and retry once instead of
  masking command timeouts as healthy state.
- The CDP server now refuses to start when its HTTP port is already owned,
  preventing new wrappers from silently adopting stale bridge instances.
- Direct command aliases for chat history, recordings, bridge reliability, and
  safety tools now match the MCP tool surface and permission checks.
- Desktop focus grid accepts both the current `action` contract and legacy
  boolean `show`, and pointer calibration correctly honors `area:"all"` while
  returning `success:false` on cancelled/failed calibration.

## [0.2.50] - 2026-05-31

### Fixed
- Releasing or expiring the agent-focus region now also hides any visible
  agent pointer so stale click guidance does not linger on screen.

### Added
- The tray menu now shows a direct "Hide agent pointer" action whenever the
  ghost pointer is visible.

## [0.2.49] - 2026-05-31

### Fixed
- Companion GUI screenshots now honor the active agent-focus region and default
  to a region-relative grid when focus is active, so Vincent no longer falls
  back to full-desktop captures after the user selects an area.

### Added
- Companion GUI relay support for focus-grid, grid-cell click/pointer, point
  picking, and set-of-mark desktop snapshots.

## [0.2.48] - 2026-05-31

### Fixed
- Desktop screenshots sent through the Empir3 companion relay now downscale
  oversized PNG captures into bounded JPEG payloads so full-monitor shots do
  not cross the production WebSocket/proxy message-size cliff and time out.

## [0.2.47] - 2026-05-31

### Fixed
- Release manifests now include a timestamp cache buster on payload and
  signature URLs so the updater cannot fetch stale tarball bytes for a newly
  published version.

## [0.2.46] - 2026-05-31

### Changed
- CDP overlay injection is now opt-in via `EMPIR3_BRIDGE_CDP_OVERLAY=1` so
  browser-control commands are not blocked by overlay injection on live
  Chrome profiles.

## [0.2.45] - 2026-05-31

### Fixed
- CDP overlay mailbox polling is now serialized and short-timeout bounded so
  overlay chat cannot starve browser control commands.

## [0.2.44] - 2026-05-31

### Fixed
- Browser open no longer waits on a long post-navigation `document.readyState`
  eval loop; it returns after Chrome target metadata confirms the new URL.

## [0.2.43] - 2026-05-31

### Fixed
- Desktop app kill now verifies that targeted PIDs have actually exited before
  reporting success, preventing false-positive `app:kill` results.

## [0.2.42] - 2026-05-31

### Fixed
- Chrome `/json` helper requests now have a timeout so a stuck local CDP HTTP
  call cannot hang `/health` or downstream browser-control endpoints.

## [0.2.41] - 2026-05-31

### Fixed
- Browser actions close the old long-lived page CDP websocket before opening
  their fresh per-command websocket, avoiding same-process page CDP contention.

## [0.2.40] - 2026-05-31

### Fixed
- Browser readiness now uses Chrome target availability instead of the stale
  long-lived page websocket, and browser-level websocket reconnects are
  de-duplicated to avoid reconnect storms.

## [0.2.39] - 2026-05-31

### Fixed
- Browser navigate now falls back to Chrome target metadata when a page-level
  evaluate times out after the visible navigation has already completed.

## [0.2.38] - 2026-05-31

### Fixed
- Browser actions now send page-level CDP commands through a fresh target
  websocket per command, so stale long-lived page sockets no longer make
  `browse:open`, `browse:text`, or `browse:snapshot` hang.

## [0.2.37] - 2026-05-31

### Fixed
- Browser control disables the Chrome permission-denial sweep by default because
  `Browser.setPermission` can wedge the active page CDP websocket on some
  Chrome builds.

## [0.2.36] - 2026-05-31

### Fixed
- Browser control now proves a newly opened CDP socket with a real round trip
  before using it, and old socket timeouts can no longer reset a newer
  connection.

## [0.2.35] - 2026-05-31

### Fixed
- Browser control no longer waits on Chrome permission-denial setup during CDP
  connect, preventing `Browser.setPermission` stalls from breaking the freshly
  reconnected browser socket.

## [0.2.34] - 2026-05-31

### Fixed
- Browser control now liveness-checks the saved CDP websocket before browser
  actions and reconnects when Chrome is still reachable but the old socket has
  gone stale, fixing repeated `browse:open` / `browse:snapshot` timeouts.
- Browser navigate now rejects a missing URL with a clear error instead of
  throwing an internal `replace` exception.

## [0.2.33] - 2026-05-31

### Fixed
- Spotify/app launches now prefer known per-user executable paths when
  available and verify that a matching process is running before reporting
  success.

## [0.2.32] - 2026-05-30

### Fixed
- Plain CLI bridge prompts now explicitly direct tool-capable turns to use
  Empir3 MCP tools for project files and not the CLI's local filesystem tools.
- Grok Build CLI turns now run from a disposable temp cwd while the MCP shim is
  active, preventing accidental writes into the Bridge install/profile folder.

## [0.2.31] - 2026-05-30

### Fixed
- Gemini bridge MCP turns now provide a per-turn trusted-folders file so the
  temp `.gemini/settings.json` is actually loaded before headless execution.
  This lets Gemini discover and call Empir3 file tools during Koba builds.

## [0.2.30] - 2026-05-30

### Fixed
- Gemini bridge turns now use only `--approval-mode yolo` for tool approvals
  and no longer combine it with `-y`, fixing Gemini 0.44's mutually-exclusive
  flag error during Koba builds.

## [0.2.29] - 2026-05-30

### Fixed
- Gemini bridge turns now append the short `-p` stdin hint after model and MCP
  flags, fixing the CLI help/error path where later flags were parsed as query
  text during Koba builds.

## [0.2.28] - 2026-05-30

### Fixed
- Codex bridge turns now pass the full specialist prompt over stdin (`codex exec -`)
  instead of argv, fixing Windows `spawn ENAMETOOLONG` failures on Koba builds.
- Gemini bridge turns now pass long prompts over stdin, with `-p` carrying only a
  short instruction prefix so later model/MCP flags cannot be consumed as the prompt.
- Grok bridge turns now use the CLI's native `--prompt-file` path and let Grok
  Build use its subscription-backed default model instead of forwarding hosted
  xAI model IDs the local CLI rejects.

## [0.2.26] - 2026-05-30

### Fixed
- Direct app WebSocket handshakes now mark the bridge connected when the
  server sends `connected`, clearing stale tray "reconnecting/sign in needed"
  state after successful auth.

## [0.2.25] - 2026-05-30

### Fixed
- Pairing now normalizes stale Empir3 `/relay` URLs to the current `/ws`
  desktop bridge endpoint so paired daemons appear online in app.empir3.
- Stored bridge auth files with legacy relay URLs are corrected at runtime
  instead of leaving the tray stuck reconnecting.

## [0.2.24] - 2026-05-30

### Fixed
- Tray Sign in and post-sign-out pairing now open the current wrapper welcome
  page on `:3006` instead of the legacy CDP setup page on `:9867`.
- Welcome relay/account status now shows rejected stored Empir3 tokens as
  "SIGN IN NEEDED" instead of paired/connected.

## [0.2.23] - 2026-05-30

### Fixed
- Welcome-page "Apply update" tray commands now use the full update handoff:
  restart the daemon to fetch the payload, then restart the tray binary once
  the new payload is active.

## [0.2.22] - 2026-05-30

### Fixed
- Relay status now waits for the server's relay authorization event before
  reporting the Empir3 relay as connected, avoiding brief false-green states
  when the websocket opens and is then rejected.
- Tray status now surfaces rejected Empir3 auth as "Bridge running · sign in
  needed" instead of a generic reconnecting/down state.

## [0.2.21] - 2026-05-30

### Fixed
- Tray status now shows the local bridge daemon as running when the daemon is
  reachable, instead of showing a generic "Reconnecting..." label while the
  bridge window is already up.
- Added Empir3 relay websocket keepalive pings, app-level ping replies, and
  close-code logging so relay reconnect loops are easier to diagnose.

## [0.2.20] - 2026-05-30

### Fixed
- Tray Reconnect/Quit now runs a conservative bridge-owned process cleanup
  for the wrapper, CDP bridge, controlled Chrome profile, and common dev/test
  bridge sessions on `3006`/`3106`/`3206`/`3306`/`9867`/`9222`, so stale
  agent-launched bridge sessions do not block a clean relaunch.
- Tray update restarts now stop and clean the old daemon before launching the
  new tray binary, reducing port races during payload handoff.

## [0.2.19] - 2026-05-30

### Fixed
- Hardened daemon startup when the CDP bridge port `9867` is already held by
  a stale bridge instance: the CDP bundle now exits cleanly after warning, so
  the wrapper can continue if the existing bridge health check passes.
- Tray-supervised daemon stdout/stderr now appends to `bridge.log`, making
  startup crashes diagnosable from the tray menu instead of disappearing into
  `DEVNULL`.

## [0.2.18] - 2026-05-30

### Added
- Welcome console **Desktop Tools** pane with the local desktop-test harness,
  bridge status, current URL, overlay status, safety state, and safe command
  shortcuts for screenshot, refresh, snapshot, overlay injection, and write
  control revocation.
- `/desktop-test` now reports total click attempts plus hit/miss counts, and
  logs `click HIT` / `click MISS` so agents can tell whether a desktop click
  fired even when it missed the intended target.

### Changed
- Welcome relay status now treats paired-but-waiting as a green paired state
  instead of warning yellow, and the overview relay card uses the same honest
  paired/connected status.
- The top safety shorthand is now clickable `R/W/E`, with each letter toggling
  the matching read/write/execute permission.
- Tray default menu action now opens `/welcome` on the active wrapper port
  instead of the deprecated `/settings` page.
- Removed the tray `Enable Higgsfield CLI` menu item.
- Raised dependency floors and overrides for patched release dependencies
  (`ws`, `fast-uri`, `hono`, `express-rate-limit`, `ip-address`, and `qs`).
- Hardened localhost browser boundaries: cross-origin browser HTTP mutations
  and WebSocket overlay connections now require the per-launch bridge nonce.

## [0.2.17] - 2026-05-29

### Added
- **Route `github:probe` / `github:exec` over the empir3 device channel.**
  Wakes up the lendable GitHub CLI end to end: `handleEmpir3Message` now
  handles `github:probe` → `github:probe:result` (presence / auth / account
  / opt-in / scope matrix) and `github:exec` → `github:exec:result`
  (execute-permission + `lendGitHubCli` gated; `githubExec` enforces the
  scope matrix + hard-blocks), parallel to the existing `*:cli:*` handlers
  and correlated by `payload.id`. `github_status` → `github_status:result`
  is read-permission gated. The server half (Vincent/Koba `github` tool) is
  already live in production and routes to this. The enforcement boundary
  (`handlers/github-cli.ts`) is unchanged.

### Added
- **Lendable GitHub CLI for remote / empir3 team agents.** A new
  `lendGitHubCli` master toggle (default OFF, mirrors the Claude Max lend
  model) lets a remote agent act on GitHub through the user's
  authenticated local `gh` — no token handoff. Surface is empir3-only
  (the `github:exec` relay command); it is deliberately not a local MCP
  tool. A fine-grained scope matrix (`read` / `pr` / `issue` / `repo` /
  `release` / `workflow` / `admin` / `api_write`) gates every command;
  token exfil (`gh auth token`/`logout`), identity swap, aliases, and
  extensions are hard-blocked regardless of scopes, and unrecognized
  commands default-deny. Every gh invocation is recorded in the action
  log. The GitHub CLI is also added to the capability inventory and the
  API & CLIs settings pane (lend toggle + scope checkboxes).
  *(Consumer is dormant until empir3-server routes `github:exec`.)*

### Fixed
- Codex CLI vision now passes the prompt before `--image`, avoiding the
  repeatable image flag swallowing the prompt as another file path.

## [0.2.8] - 2026-05-28

### Fixed
- **The `/welcome` bridge surface now reports effective tool readiness
  instead of raw registered tools.** In read-only mode the welcome page
  now shows the actual available set (`21 / 51`) and marks write/execute
  tools as `NEED SAFETY`; after enabling safety it shows `51 / 51 READY`.
- **Read-safe browser tools stay usable by default.** Navigation,
  scrolling, and refresh now require `read` permission rather than the
  global `execute` toggle, matching the user's expectation that browsing
  and inspecting pages works in the default safe state.
- **Safety state is honest about global blocks.** `/api/safety` now
  reports `globalSafety`, `allowedByGlobal`, and `blockedByGlobal` so
  the welcome page can distinguish local tool state from globally
  blocked write/execute classes.
- **Relay status no longer overstates connectivity.** A paired bridge
  without an active relay now displays `PAIRED` instead of `CONNECTED`.
- **`desktop_snapshot_som` tolerates raw UIA control characters.** The
  JSON sidecar parser now retries after escaping invalid control bytes,
  fixing real desktop snapshots that contain hidden characters in
  accessibility text.
- **Desktop smoke coverage was expanded across the welcome-era desktop
  tools.** The 2026-05-28 smoke pass covered Paint launch/focus,
  screenshots, UIA/SOM, click/hover/drag, overlay, pointer, focus
  region, focus grid, cell targeting, region pick, and cleanup paths.

## [0.2.7] - 2026-05-28

### Fixed
- **`browser_highlight` now actually highlights.** The previous
  implementation depended on `window.__empir3_glowElement`, a function
  the overlay injects on each page. On a freshly-navigated page where
  the overlay's CDP eval timing was just right, the call would return
  `Highlighted: <selector>` but apply zero styles. Replaced with a
  self-contained inline-style apply / restore that doesn't depend on
  the overlay being injected and uses `!important` so site CSS can't
  out-specificity the glow. Also returns a `count` field so the caller
  can tell the selector matched.
- **`browser_record_start` now warns when the overlay isn't connected.**
  Recording is captured browser-side in the injected overlay, which
  sends each event to the wrapper over websocket. If the overlay's
  websocket is disconnected (e.g. right after `browser_navigate`),
  clicks and keystrokes silently vanish — the recording's badge counter
  ticks up because that's client-only state, but the saved file ends up
  with zero actions and the agent has no idea anything went wrong.
  `record_start` now awaits overlay injection, polls for `overlayClients
  > 0` up to 2s, and returns `{overlayConnected, warning}` so the
  caller can surface "tell the user to open the chat bubble" before any
  events are lost.
- **`browser_play` no longer reports `passed` on missed coordinate
  clicks.** When a recorded action lacks a `ref`/`refLabel`/`selector`
  and falls back to raw coordinates, playback now hit-tests the
  resulting element. If the click landed on nothing or on a
  non-interactive container (`DIV`, `BODY`, `SECTION`, etc.), the step
  is reported as `ok: false` with a warning explaining the recording
  is coord-only and the viewport probably changed. Summary includes a
  top-level `warnings` array.
- **`desktop_click` hit-test no longer errors with `Cannot find type
  [System.Windows.Point]`.** The UIA hit-test sidecar uses
  `System.Windows.Point` (WPF) which lives in `WindowsBase.dll`. That
  assembly wasn't being loaded, so every successful click came back
  with a noisy `hit: { error: ... }` payload. Now adds
  `Add-Type -AssemblyName WindowsBase` before constructing the point.
- **`browser_evaluate` errors now include the real exception text.**
  CDP's `Runtime.evaluate` returns `exceptionDetails.text` ("Uncaught")
  and the actual error in `exceptionDetails.exception.description`.
  The bridge was throwing just the former, so top-level `await` and
  `const` re-declarations produced opaque `Uncaught` failures. Now
  surfaces the first line of `exception.description` (trimmed to 500
  chars).
- **`browser_recordings` no longer dumps multi-kilobyte `data:` URIs
  in the listing.** Recordings made from `data:text/html,...` start
  URLs (cert tests, smoke fixtures) printed the entire encoded URI per
  row, making the listing unreadable. `data:` URIs collapse to
  `data:\u2026 (Nb)` and any non-data URL >100 chars truncates to
  `\u2026`.

### Notes
- All fixes are surfaced from the user-perspective smoke test
  conducted 2026-05-28. Findings P1/P1/P1/P2/P3/P3 in that order.

## [0.2.6] - 2026-05-29

### Reverted
- **`desktop_click` rolled back to 0.2.3's `mouse_event` implementation.**
  0.2.4 rewrote the click path to use `SendInput` with
  `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`, and 0.2.5 fixed a
  struct-size bug introduced in 0.2.4. Both changes were based on a
  misread of the `/desktop-test` diagnostic — I interpreted "click
  count: 0" as "no click events reached the page", when in fact the
  page's click count only increments on hits to the green CLICK
  TARGET button specifically. Every click WAS reaching the page — I
  was clicking the wrong viewport pixel because I was estimating
  positions from downsampled screenshots in the agent's chat
  preview. The 0.2.3 click implementation was correct all along.
- 0.2.6 = 0.2.3's `desktop_click` PowerShell body, exactly. No
  SendInput, no INPUT struct, no virtual-desk normalization. The
  `mouse_event(LEFTDOWN, 0, 0, ...)` pattern that has worked on
  native Win32 apps for years is back.

### Notes
- Version bumped to 0.2.6 (not back-versioned to 0.2.3) so the
  auto-updater detects the new release on top of users currently
  running 0.2.4 or 0.2.5.
- No other changes. `.mcp.json` shipped in 0.2.3 stays. All
  documentation / launch-clean work from earlier 0.2.x releases is
  preserved.

## [0.2.5] - 2026-05-29

### Fixed
- **`desktop_click` INPUT struct size bug.** 0.2.4 introduced the
  SendInput path but the INPUT struct definition had three bogus
  padding ints (12 extra bytes), making `Marshal.SizeOf` return 52
  instead of the canonical Win32 size of 40 (64-bit) / 28 (32-bit).
  SendInput silently rejected every call (returned 0). Cursor still
  moved via SetCursorPos so it looked like the click was firing —
  but no actual click event reached the OS. Page-side counter stayed
  at 0 on programmatic clicks; manual mouse clicks worked normally.
- Removed the bogus padding. Sequential layout adds the correct
  IntPtr alignment automatically.
- Added a `sendInput` diagnostic array to the `desktop_click`
  response showing the SendInput return value for each of the three
  events (move / down / up). 1 = success, 0 = failure with extended
  GetLastError. Future regressions in this area will be immediately
  visible instead of silently failing.

## [0.2.4] - 2026-05-29

### Fixed
- **Desktop click accuracy on multi-monitor Windows.** `desktop_click`
  was using `SetCursorPos + mouse_event(BUTTON_DOWN, 0, 0, ...)`. The
  second call's "fire at current cursor position" semantics drift on
  per-monitor DPI setups — the OS-level cursor goes to one physical
  pixel but the click event registers at a different one. Symptom: on
  a window straddling two monitors with mismatched DPI scaling, the
  page-side click counter never incremented despite the bridge
  reporting cursor at the requested coord. Even after a clean
  five-point per-monitor calibration measuring sub-pixel residuals,
  the clicks still missed because the bug is in the click delivery
  itself, not cursor positioning.
- Rewrote `desktop_click` to use `SendInput` with
  `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` flags. Each event
  carries its own absolute target coordinate normalised against the
  virtual desktop bounds — no reliance on "current cursor position"
  at the moment of click. This is the canonical Win32 approach for
  scripted clicks and is DPI-awareness-independent.

### Notes
- `desktop_hover` and `desktop_drag` still use the legacy
  `SetCursorPos` path — those code paths reported accurate cursor
  positioning in smoke tests, so they're left in place. If a
  regression turns up they get the same SendInput treatment.

## [0.2.3] - 2026-05-29

### Fixed
- Welcome console permissions count was still showing `52 / 52` after
  0.2.2 even with no custom providers configured. Server correctly
  hides `custom_llm` from the family-gate, but the frontend was
  starting from a static 52-entry `TOOLS` array and falling back to
  defaults for missing keys (which made `custom_llm` count as
  enabled-by-default). Now: when a tool is absent from the server's
  `enabledTools` response, mark `t.hidden = true` and exclude from
  both the rendered table and all count readouts. Result: `51 / 51 ·
  0 BLOCKED` for users with no providers, `52 / 52` after they add
  their first one.
- Pre-existing TypeScript error in `runClaudeCliTurnInternal` —
  variable declared as `ClaudeCliMcpShim` (undeclared type) instead
  of `CliMcpShim` (the actual return type of
  `startClaudeCliMcpShim`). Surfaced after `tsc --noEmit` came back
  clean post-0.2.2; this error was introduced in a parallel session's
  gemini/grok handler commit. `tsc --noEmit` is now clean again.

## [0.2.2] - 2026-05-29

### Changed
- **Renamed `openai_chat` → `custom_llm`.** The previous name collided
  with the OpenAI Codex CLI shown one row away in the same pane and
  created the wrong mental model — the tool is a generic dispatcher
  for any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter,
  vLLM, self-hosted), not OpenAI's API. New name maps directly to the
  "+ Add custom provider" affordance and is future-proof against
  non-OpenAI-protocol endpoints. Migration is automatic: prior
  `enabledTools.openai_chat` value carries forward into
  `enabledTools.custom_llm` on first config load.
- **`custom_llm` is now family-gated on `customProviders.length`.**
  The MCP tool only registers (and the permission only surfaces in
  the welcome console) when at least one custom provider is
  configured. Fixes the "1 BLOCKED" phantom in the Overview
  permissions card for users with no providers — count cleanly
  reports `N / N` instead of `N / N+1`. Mirrors the existing
  Higgsfield handler-family-gate pattern.
- **Adding the first custom provider auto-enables `custom_llm`** in
  the same HTTP transaction; removing the last provider auto-disables
  it. Default flipped to `true` since the cost-opt-in decision now
  happens at the meaningful moment (when you add a provider).

### Documentation
- Full README launch-clean pass: refreshed tool inventory (57 tools,
  sectioned), added API & CLIs section, hero screenshot of welcome
  console, Troubleshooting section (Higgsfield Windows tar gotcha,
  "Connected but no tools" MCP failure modes), redrawn architecture
  diagram showing MCP shim auto-launch + API & CLIs dispatcher node.
- SECURITY.md: data-locations split (chat config vs bridge settings
  paths), custom-provider key storage documented, supported-versions
  table bumped to 0.2.x.
- AGENT_GUIDE: tool count 47 → 57, new §6 "API & CLIs" with
  `custom_llm` + `higgsfield_*` recipes and family-gate behavior.

### Fixed
- Pre-existing TypeScript narrowing error in `/api/cli/providers` POST
  handler (`validateProviderJson` discriminated-union didn't narrow
  under `strict: false`). Replaced `if (!valid.ok)` with `if ('error'
  in valid)` — `in`-operator narrowing works without strictNullChecks.

## [0.2.1] - 2026-05-28

### Added
- **Custom OpenAI-compatible providers** — paste a JSON definition
  (schema: `slug` / `name` /
  `apiBaseUrl` / optional `models[]` / optional `apiKey`) and the
  bridge will surface it as a row on the API & CLIs pane alongside the
  built-in CLIs. Works with Ollama (`http://localhost:11434/v1`),
  LM Studio (`http://localhost:1234/v1`), llama-server, OpenRouter,
  Groq Cloud, Together AI, vLLM — anything OpenAI-compatible. Model
  list auto-populates from `GET /v1/models`. New routes:
  `POST /api/cli/providers`, `DELETE /api/cli/providers/<slug>`,
  `POST /api/cli/providers/<slug>/lend`.
- **`openai_chat` MCP tool** — `{provider, model, prompt, system?}`
  fans out to any configured custom provider. Lets MCP clients
  (Claude Code, Continue, Cursor) route a prompt through a local LLM
  or cloud aggregator without separate config. Defaults OFF; opt in
  per session under Permissions → JavaScript (Eval) group's neighbor
  "Providers" filter.
- **Higgsfield URL extractor** now recognizes the array-of-jobs shape
  with top-level `result_url` that the CLI actually returns (was
  missing the field, so `url` + `artifactPath` came back null on
  successful generations). Real-world shape probed during a smoke
  test and bumped to top of the priority list.

### Notes
- `lend` toggle on custom-provider rows persists locally but doesn't
  route through empir3 team agents yet — that's v2 and requires
  server-side work in the empir3 repo to consume the bridge's
  capability announcement.

## [0.2.0] - 2026-05-27

### Fixed
- **Auth-launch quoting on Windows** — clicking the Authenticate button
  for any .cmd-shim provider (Gemini, Higgsfield, Claude) opened a
  console window with mangled quoting that failed with "is not
  recognized as an internal or external command". The `start ""`
  title-slot was eating the path's opening quote. Replaced with a
  direct `cmd.exe /d /s /c <cliPath> ...args` invocation in a detached
  console (mirrors `cli-runner.ts`). All five Auth buttons (Claude,
  Codex, Gemini, Grok, Higgsfield) now open clean.
- **Auth-launch cwd** — was inheriting the bridge daemon's install dir,
  causing Gemini's "trust this folder?" gate to ask about the wrong
  directory. Now scoped to `settings.homeDirectory` (the bridge's
  approved project root) so CLIs land inside the empir3 workspace.

### Added
- **Daemon → Identity block** brings back the old `/settings`-page
  Device name + Home directory inputs into the new welcome console.
  Saves through `/api/settings/state`, prefills from `CLI_STATE.bridge`
  on every refresh. These feed empir3-agent labelling + the
  project-sync scope.

## [0.1.99] - 2026-05-27

### Changed
- **Sidebar mobile toggle** — when the rail hides at ≤880px viewport, a
  hamburger button in the topbar pops it back as a floating overlay
  with a scrim. Closes on nav-click, scrim-click, or Escape.
- **Higgsfield two-layer UX** — the family gate (API & CLIs page) and
  the per-tool toggles (Permissions page) used to look like they did
  the same thing. Now the API & CLIs column reads "Lend / Tools" with
  a dynamic label: "3 / 3 tools · configure" when on (link jumps to
  Permissions and pre-filters Higgsfield) or "tools disabled (3/3
  configured)" when off. Permissions Higgsfield group gets a yellow
  banner when the family-gate is off, with a click-through back to
  API & CLIs. Both pages cross-refresh on toggle.

## [0.1.98] - 2026-05-27

### Added
- **Higgsfield CLI handler** (`src/handlers/higgsfield-cli.ts`) wrapping the
  user's local `higgsfield` binary. Three new MCP tools:
  - `higgsfield_status` (read) — returns `{installed, version, authenticated,
    credentialsPath}`. Auth check is the canonical `higgsfield auth token`
    exit-code + `hf_*` prefix; never echoes the token.
  - `higgsfield_list` (read) — proxies `higgsfield generate list --json`
    after a one-shot `--help` probe.
  - `higgsfield_generate` (execute, default OFF) — spawns `higgsfield
    generate create <model> --prompt ... --wait --json`, extracts the
    result URL via a generic path-priority parser, fetches the artifact,
    saves to `~/.empir3-bridge/artifacts/higgsfield/`, returns `{raw, url,
    artifactPath, durationMs}`. Hard-cap on `--wait-timeout` at 20 min,
    single-job FIFO queue at the handler, pass-through `extra: {...}`
    flags. Auth-expired / rate-limit / quota classified from stderr.
- Generic handler-family gate: `settings.handlers.<name>.enabled` in
  `bridge-settings.json` (schema is additive; tray toggles flip it). Both
  the MCP shim (`tools/list` filter at startup) and the bridge dispatcher
  (per-request) enforce. Future handlers drop in via the same schema.
- Tray menu item **"Enable Higgsfield CLI"** (checkbox) — coarse on/off
  for the whole `higgsfield_*` family.
- Welcome console: new **Higgsfield** group/filter under Permissions.
- **API & CLIs pane** in the welcome console (sidebar nav "API & CLIs",
  between MCP Connection and Agent Tools). Replaces the old `/settings`
  lend toggles with a unified surface covering all five CLIs the bridge
  knows about: Claude Code, OpenAI Codex, Google Gemini CLI, xAI Grok
  Build CLI, Higgsfield CLI.
  - **Per-CLI status row**: install (version), auth (creds-file vs env
    detection), lend-to-empir3 toggle for inference CLIs, handler-family
    toggle for Higgsfield.
  - **API key entry**: Anthropic, OpenAI, Google, xAI. Stored in
    `~/.empir3-bridge/config.json` under `apiKeys.{provider}`. Legacy
    `anthropicApiKey` field is mirrored both ways for back-compat.
    Submitting an empty field never clobbers a saved key.
  - **Auth button** per CLI (`POST /api/cli/auth`) — spawns the CLI's
    own login flow in a detached console window so the user can finish
    in their browser. Each provider's command is encoded in
    `authLaunchSpec()` (e.g. `claude /login`, `codex login`,
    `higgsfield auth login`).
- Backend: `probeGeminiCli()` (binary `gemini`), `probeGrokCli()` (binary
  `grok`, fallback to `~/.grok/bin/grok[.exe]` from the xAI installer),
  `probeHiggsfieldCli()` (wraps the handler). Each gets a
  `lend{Provider}` settings key (`lendGoogleGemini`, `lendXaiGrok`).
  Auth signals: file-existence on `~/.claude/.credentials.json`,
  `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, `~/.grok/auth.json`,
  with env-var fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GROK_CODE_XAI_API_KEY`/`XAI_API_KEY`).

### Changed (welcome console polish)
- **Daemon "HEALTHY" tag** in the Process pane now reflects live `s.running`
  state instead of being hardcoded. Flips to "OFFLINE" (red) when daemon
  drops, matching the telemetry-strip LED.
- **Activity Log detail column** shows a meaningful per-row input summary
  (URL, ref, selector, coords, monitor, recording name, text length…)
  instead of the always-`http` source. Same builder feeds the Overview
  tile and the Activity Log pane.
- **Top-bar ⌘K search** is now live — filters the permissions table by
  tool name + blurb substring as you type, auto-switches to the
  Permissions pane on first character, Escape clears.
- **MCP "Copy snippet"** falls back to pre-selecting the `<pre>` with
  `window.getSelection()` when `navigator.clipboard.writeText` rejects
  (headless / unfocused tab), so ⌘C / Ctrl+C completes the copy.
- **MCP Calls tile** relabeled "MCP Calls (last 80)" — was misleading
  because the in-memory action log caps at 80 entries per session.
- **Telemetry cells** pre-render Daemon=RUNNING, MCP=READY, PID from
  `process.pid` so first paint shows the correct state instead of
  flashing `—` until `refreshStatus()` finishes.
- **Focus-grid button label** syncs to the daemon's authoritative state at
  boot via `/api/desktop/focus` (response now includes
  `grid: {enabled, running}`), so opening `/welcome` with the grid
  already showing via another channel no longer mis-labels the button.

## [0.1.97] - 2026-05-25

### Added
- Welcome-page **Command Center**: every system-tray menu item is now also
  reachable from the bridge's web UI at `/welcome`. Four sections — Daemon
  (reconnect / open bridge / settings / live log tail), Agent controls
  (select region, release focus, toggle focus grid, calibrate clicks),
  Updates (check + Apply update + Auto-update toggle), and Tray lifecycle
  (Restart tray / Quit / Uninstall, danger-styled with confirm dialogs).
  Daemon-controllable actions hit the bridge directly; tray-lifecycle
  actions enqueue a command the tray drains on its next status poll.
- `POST /api/shutdown` — graceful daemon exit. The tray supervisor's
  reconnect path now has the fast path it was already trying to use.
- `GET /api/log/tail?lines=N` — bridge.log tail with action-log fallback,
  feeding the new in-page log viewer.
- `GET /api/updates/check` — probes the public manifest, returns
  `{state, local, remote, newer, manifest}` so the welcome page can show
  update status without duplicating the tray's manifest URL.
- `GET /api/desktop/focus` — quick check whether an agent-focus region is
  active; powers the Release-focus / Show-focus-grid button enabling.
- `POST /api/tray/enqueue` + `GET /api/tray/commands` — whitelisted
  command queue the welcome page uses for lifecycle commands. Allowed
  types: `tray_check_updates`, `tray_apply_update`,
  `tray_toggle_auto_update`, `tray_open_log`, `tray_restart_tray`,
  `tray_quit`, `tray_uninstall`. Tray drains every status-poll tick (~4s).

### Changed
- Tray `StatusPoller` now drains `/api/tray/commands` each tick and
  dispatches each command through the existing menu-action handlers.

## [0.1.96] - 2026-05-24

### Added
- `bridge_tool_advisor` MCP tool — pass `intent` as a one-line description
  ("click a small icon in Photoshop", "fill in a web form", "guide a
  tutorial without taking the mouse") and the bridge returns the matching
  tool family, rationale, and example call sequence. Aimed at agents that
  don\'t know which of the 47 tools to reach for.
- `docs/AGENT_GUIDE.md` — intent-driven decision tree for agents driving
  the bridge. Organised as See / Find / Act / Point / Manage.
- `scripts/smoke-all-tools.mjs` — re-runnable smoke driver that exercises
  every tool over HTTP and writes a tier-classified markdown report.

### Changed
- TOOL_META blurbs rewritten for intent-driven discoverability. Key
  primaries (`browser_snapshot`, `browser_click_ref`, `browser_type_ref`,
  `desktop_click_ref`, `desktop_snapshot_som`) now state which tool to
  reach for and what the alternatives are.

## [0.1.95] - 2026-05-23

### Added
- `desktop_snapshot_som` — Set-of-Mark snapshot for the agent-focus region.
  Runs a UIA enumeration, filters to elements inside the focus (or supplied)
  region, takes a focus-scoped screenshot, and draws numbered colored boxes
  (1..N) directly on the image. The agent reads numbers off the image and
  acts via `desktop_click_ref` — removes pixel-coordinate guessing for native
  Win32 apps. Returns `empty:true` on CEF/Electron/games where UIA finds
  nothing (vision-based fallback is Phase 2).

### Added
- Initial extraction from the Empir3 codebase.
- Browser, desktop, reliability, and safety MCP tools for local agent control.
- Chrome CDP bridge with persistent profile.
- HTTP wrapper layer.
- One-command launcher: `empir3-bridge`.
- Browser extension for HTTPS overlay support.
- Standalone CLI: `tsx src/cli.ts <command>`.
- DPI-aware desktop monitor, screenshot, click, hover, and drag tools.
- Reliability receipts, `reliability-smoke`, and action log inspection.
- Safety status and revoke-control path for disabling write-capable tools.
- Local desktop test harness at `/desktop-test`.
- Settings page at `/settings` for API key, CLI path, model, system prompt, loop cap, and per-tool toggles.
- Per-tool kill switch. Read and navigate tools default on; interaction, desktop, eval, recording, and replay tools default off.
- Chat with Claude in the overlay, with BYO API-key and BYO Claude Code CLI modes.
- SSE endpoint `POST /api/chat/stream` for HTTP clients.
- Conversation transcript endpoints.
- OSS docs for safety and testing.
- GitHub issue and PR templates.
- CI workflow for install, type check, MCP build, and smoke placeholder.
- Windows release pipeline for `Empir3Setup.exe`, signed payload manifests, tray app source, and installer UI.
- Download publishing helper for `https://app.empir3.com/downloads/`.
- CLI and MCP clients automatically read the local bridge nonce and send a legacy `action` field for compatibility with `0.1.27` during the `0.1.28` rollout.
- Payload entrypoint startup fix for `0.1.29` so the CommonJS payload parses correctly while still supporting async tray fallback daemon startup.
- Payload daemon startup fix for `0.1.30` so packaged bridge bundles load in-process instead of recursively launching `Empir3Setup.exe`.
- Restored the tray status endpoint in `0.1.31` so the Windows tray reports the daemon as running instead of showing a false "Daemon not running" state.
- Restored packaged daemon nonce creation, the tray's `Open bridge` command, and the wrapper `/welcome` page in `0.1.32`.
- Restored the Empir3 pairing flow in `0.1.33` so "Sign in to Empir3" mints a pairing code, opens Empir3, saves the claimed token locally, and restarts into paired mode.
- Restored the tray `Sign in` menu item in `0.1.34` for standalone Claude Code mode when no Empir3 auth is present.
- Added direct local Empir3 login in `0.1.35` so the bridge can store an explicit user token and override whatever account the browser is currently logged into.
- Added a tray `Switch Empir3 account` action in `0.1.36` so paired bridges can intentionally replace the locally stored Empir3 user.
- Moved the setup choice screen into the bridge Chrome window in `0.1.37`, with clearer MCP mode vs Empir3 user mode flows and restored MCP config instructions.
- Fixed tray `Open bridge` in `0.1.38` so it relaunches and surfaces the controlled bridge Chrome window if Chrome was closed while the daemon stayed running.
- Restored Empir3 desktop companion registration and core remote tool handling in `0.1.39` so the web app can see the bridge and run capabilities, system info, window list, desktop screenshot, and agent-browser commands.
- Added production/local-dev/custom Empir3 account lanes in `0.1.40`, including persisted auth server metadata, visible bridge sign-out, tray duplicate-instance protection, and a repeatable release certification harness.
- Fixed intentional daemon restarts in `0.1.41` so sign-in, sign-out, pairing, and reconnect no longer accumulate tray crash backoff delays during account switching.
- Fixed MCP text results in `0.1.42` so empty or structured browser text responses are always returned as protocol-valid strings, and protected the checked-in extension overlay from runtime source rewrites.
- Hardened Chrome/CDP readiness in `0.1.43` so early browser commands recover the controlled Chrome session before failing with "Not connected."
- Added wrapper-level Chrome wake/retry and consistent `primary` monitor support in `0.1.44`, and made release certification fail MCP tools that return `isError`.
- Fixed the 3006 setup-page mode/login JavaScript in `0.1.45`, and added certification checks that parse the welcome script and click through MCP vs Empir3 mode switching.
- Fixed 3006 setup-page preservation in `0.1.46` so the 9867 splash is only injected into the controlled bridge welcome page, not over the MCP/Empir3 setup UI.
- Restored the legacy Empir3/Vincent companion surface in `0.1.47`: app/process checks, clipboard read/write/clear, shell execute with safety gates, Windows notifications, file push/pull/project/sync writes, full window/GUI dispatch, sysinfo battery/installed, broad capability scans, browser direct action aliases, and MCP `desktop_cursor_position`.
- Added a companion surface smoke script in `0.1.47` with optional live browser checks for selector/ref click/type, screenshot shape, snapshot, and evaluate round trips.
- Added the visible full live bridge smoke runner in `0.1.48`, covering browser, companion, desktop GUI, MCP, safety restore, and release-readiness checks.
- Added updater stale-pointer recovery in `0.1.49` so an already-extracted newer payload is reused instead of falling back when the running tray locks the target directory.
- Restored bridge-owned overlay injection and added updater rollback protection in `0.1.50` so chat, snap, annotate, draw, record, and playback keep working when Chrome ignores command-line extension loading.
- Added browser scroll movement receipts in `0.1.51` with before/after positions, deltas, max scroll range, and `moved` so short pages no longer look like they actually scrolled.
- Added explicit PNG metadata to desktop GUI screenshots in `0.1.51` and legacy companion command aliases such as `execute:run`, `window:active`, and `file:pull`.
- Added `0.1.53` overlay usability polish: branded `empir3 Chat`, chat Home/Settings shortcuts, explicit Play/Rec labels, retained recording badges, and branded test/dashboard wordmarks.
- Added `0.1.53` empir3 chat mirroring so the paired bridge can replace the local overlay log with the active empir3 project chat and forward overlay messages through the current project.
- Removed the stale reduced CDP chat panel so extension and no-extension injection both use the same feature-complete overlay with side switching, annotation, drawing, recording, and saved playback.
- Added `0.1.54` relay-compatible desktop screenshot data so `desktop:gui screenshot` returns both top-level image fields and `data.thumbnail`.
- Fixed `0.1.55` CSS-selector typing for textareas/contenteditable targets so `browser_type` matches the working `browser_type_ref` behavior instead of throwing from the evaluate shim.
- Updated `0.1.56` bridge welcome and launch splash branding to use the empir3 Outfit wordmark, cream/ink palette, lowercase brand copy, and purple `3`.
- Updated `0.1.57` chat overlay layout so the top bar owns the empir3 Bridge status, includes an MCP/empir3 mode switch, routes messages to the selected chat lane, and slides page content away from the expanded panel.
- Updated `0.1.58` chat overlay behavior so the MCP and empir3 lanes render separate visible transcripts, preventing Claude/MCP test messages from bleeding into Vincent/empir3 chat.
- Updated `0.1.59` chat split-pane behavior so the page resizes into the remaining viewport instead of translating off-screen, and the draggable separator live-adjusts both panes.
- Updated `0.1.60` chat header responsiveness so Fresh, Side, Close, and toolbar controls stay visible in narrow browser windows and after max-width separator drags.
- Updated `0.1.61` chat split-pane fitting so fixed headers and viewport-width page layouts stay inside the resized page pane instead of being covered by the chat panel.
- Updated `0.1.62` tray sign-in/sign-out routing so the welcome/login flow opens in the controlled bridge Chrome profile instead of the user's default browser, and welcome errors render in red.
- Added `0.1.63` local Codex CLI bridge capability, probe, turn, abort, and tray opt-in groundwork so future non-Vincent team agents can run through a user-owned OpenAI/Codex account without routing Vincent away from empir3.
- Restored `0.1.64` Claude CLI bridge relay commands, probe, turn, abort, and tray opt-in so a paired bridge can run text-only Claude Max turns through the user's local Claude Code login again.
- Added `0.1.65` bridge control-center settings that combine account status, local Claude/Codex opt-ins, device permissions, chat engine settings, and MCP tool toggles in the bridge-owned browser UI.
- Fixed `0.1.66` controlled-browser lifecycle handling so passive URL/status polling no longer relaunches the bridge Chrome after the user intentionally closes it.
- Fixed `0.1.67` Codex CLI probing on Windows so the bridge checks the OpenAI Codex app install path even when the tray daemon's PATH does not include it.
- Changed `0.1.73` welcome and settings UIs to gate empir3-account content behind sign-in so MCP-only users see a Claude/MCP-focused surface, with the empir3 entry point demoted to a single inline link in the meta footer.
- Renamed `0.1.73` settings copy from "Vincent/team" wording to "empir3 agents" and restructured the lending opt-ins as "Use your subscriptions with empir3" with Claude Max + OpenAI Codex active and Google + xAI as coming-soon placeholders.
- Added `0.1.73` "empir3 website policy" read-only mirror card on the bridge settings page that shows the current website-set R/W/E permissions and links to app.empir3.com/settings.
- Added `0.1.73` enforcement of `empir3Permissions` at the empir3 dispatch entry points (`handleDesktopRelayCommand`, `claude:cli:*`, `codex:cli:*`) so website-driven policy denials surface a distinct error message and the local `globalSafety` continues to act as the final PC veto.
- Changed `0.1.73` welcome page layout to move the local bridge safety card from the left brand column into the right shell column so the page no longer reads as a stub-right / long-left mismatch.
- Fixed `0.1.74` overlay and SSE chat so Claude actually responds: the SSE `/api/chat/stream` handler was aborting the Claude CLI subprocess immediately because `req.on('close')` fires as soon as the POST body is received (not when the client disconnects), killing the process before it could produce output. Removed the AbortController from the SSE path — the generator terminates naturally and failed `res.write()` calls are already swallowed. Fixed Windows CLI spawn so `claude.cmd` is invoked via `cmd.exe /d /s /c` (separate args) rather than `shell: true` with a pre-quoted path, which was silently mangling the `C:\` backslash.

### Changed
- Wrapper and CDP HTTP servers now bind to `127.0.0.1` by default.
- Chrome remote debugging launches with `--remote-debugging-address=127.0.0.1`.
- README rewritten for public OSS launch readiness.
- SECURITY and CONTRIBUTING docs rewritten around the current safety model.
- Package metadata updated for browser, desktop, computer-use, and MCP discovery.
- Single-bridge default. Parallel bridges are still available through env vars.
- Per-bridge chat history avoids collisions for non-default wrapper ports.
- Profile path moved to `~/.empir3-bridge/profile/`.
- Package renamed to `@empir3hq/bridge`.
- Package version bumped to `0.1.63` for local Codex CLI bridge-routing groundwork.
- Package version bumped to `0.1.39` for Empir3 web-app relay compatibility.
- Package version bumped to `0.1.40` for account-mode switching, local-dev login, and certification hardening.
- Package version bumped to `0.1.41` for account-switch restart reliability.
- Package version bumped to `0.1.42` for MCP protocol result hardening.
- Package version bumped to `0.1.43` for bridge launch readiness hardening.
- Package version bumped to `0.1.44` for MCP certification correctness and launch/desktop polish.
- Package version bumped to `0.1.45` for setup-page interactivity certification.
- Package version bumped to `0.1.46` for setup-page visual preservation.
- Package version bumped to `0.1.47` for companion command recovery.
- Package version bumped to `0.1.48` for live-smoke fixes and to force Windows updater payload refresh.
- Package version bumped to `0.1.49` for updater stale-pointer recovery.
- Package version bumped to `0.1.50` for packaged overlay reliability, updater rollback protection, and visible desktop smoke fixes.
- Package version bumped to `0.1.53` for bridge chat usability, active empir3 chat mirroring, replay control discoverability, and removal of the stale reduced CDP overlay.
- Package version bumped to `0.1.54` for relay desktop screenshot certification compatibility.
- Package version bumped to `0.1.55` for selector-mode typing certification.
- Package version bumped to `0.1.56` for welcome page and launch splash brand alignment.
- Package version bumped to `0.1.57` for chat overlay lane switching and page-shift usability.
- Package version bumped to `0.1.58` for chat lane transcript separation.
- Package version bumped to `0.1.59` for real split-pane resizing.
- Package version bumped to `0.1.60` for narrow chat header control visibility.
- Package version bumped to `0.1.61` for transform-based page-pane fitting.
- Package version bumped to `0.1.62` for controlled-browser tray sign-in and clearer welcome-page error styling.
- Package version bumped to `0.1.65` for the bridge settings control center and tray double-click settings launcher.
- Package version bumped to `0.1.66` for user-closed bridge Chrome lifecycle handling.
- Package version bumped to `0.1.67` for Windows Codex CLI probing from the bridge settings page.
- Package version bumped to `0.1.74` for overlay/SSE chat response fix and Windows CLI spawn fix.
- The HTTP and WebSocket command handlers accept both `type` and legacy `action` command shapes.
- Big "Select an area to share with the agent" banner on the region-select overlay in `0.1.82` so the dimmed screen is no longer a silent UI puzzle for users.
- Active-focus frame: while a region is set via `desktop_select_region`, a click-through green rectangle is drawn just outside the region (so screenshots stay clean) plus an "Agent focus active · WxH" chip above/below it, in `0.1.82`.
- Fixed silent focus-chip spawn in `0.1.83`: `detached: true + stdio: 'ignore' + windowsHide: true` combined caused powershell.exe to exit before the WinForms message loop started, so neither the old chip nor the new frame ever rendered. Drop `detached:true` and rely on the tray's Job Object to tear the child down on bridge shutdown.
- Agent ghost cursor in `0.1.84`: click-through pointer overlay with `desktop_pointer_show/move/pulse/hide/status` MCP tools. Agents can point at specific screen coords without taking over the user's real mouse; optional label pill + pulse-ring animation for "look here" emphasis.
- Click calibration in `0.1.84`: tray "Calibrate agent clicks…" menu item runs an interactive capture overlay — user clicks where they see the ghost cursor, bridge stores the (clicked - target) delta in `bridge-settings.json`, and `desktop_click` applies it automatically thereafter. Exposes `desktop_calibrate_pointer` + `desktop_calibration_status` for agent-driven recalibration.
- TOOL_META registration in `0.1.85`: the 7 new pointer + calibration tools now appear in the Bridge control center's "Local tool permissions" panel so users can veto them per-tool. Reads (status) default on, writes (show/move/pulse/hide/calibrate) default off — same pattern as desktop_click.
- Multi-point per-monitor calibration in `0.1.86`: replaces the single-click v1 offset with 5-point capture per monitor (corners + center) and a per-axis affine fit `actual = scale * requested + offset`. Catches DPI/scaling drift at the screen edges, not just uniform shift. Settings shape bumped to `desktopCalibration.version = 2` (legacy v1 still honored as a fallback uniform offset). `desktop_calibrate_pointer` now accepts `monitor: "primary" | "all" | "<id>"`. Bridge `applyCalibration` looks up the monitor containing the requested coord and uses its fit; falls through to identity outside calibrated monitors.
- `desktop_pointer_show/move/pulse` now route through the same calibration in `0.1.86` so "where the agent points" matches "where the agent would click". Pass `noCalibration: true` to render at raw coords.
- New `desktop_screenshot_zoom { x, y, radius? }` tool in `0.1.86`: returns a tight native-resolution crop centered on (x, y) with a green marker at the exact center. Agent-side fix for pixel-accurate character-level pointing — eliminates the visual estimation error from inspecting downscaled full-screen captures.
- Calibration hardening in `0.1.87`: live test exposed that one mis-clicked target (user clicked elsewhere because the first bullseye was hidden BEHIND the instruction banner) ruined the whole affine fit (scale=0.75, residual 475px), making EVERY subsequent click worse than no calibration. Three fixes:
  - Bullseye targets are now 4× bigger (48px vs 28px) with a "Click here N/M" badge directly under each so users can't misidentify them.
  - Target insets bumped to 25% horizontal + banner-aware vertical so top targets never get covered by the title banner.
  - Bridge does MAD-based outlier rejection on captured points and refuses to persist a fit whose scale drifts more than 5% from 1.0 — both backstops against the same class of bug.
- Focus-relative coords in `0.1.88`: `desktop_click`, `desktop_hover`, `desktop_drag`, `desktop_pointer_show/move/pulse`, and `desktop_screenshot_zoom` now accept `space: "focus"`. When set, the bridge adds the active agent-focus region's origin to (x, y) before any downstream work. Agents can read coords directly off a focus-cropped screenshot (where 0,0 = top-left of the user's selection) and pass them straight through, no manual offset math. Eliminates a whole class of "which coord system are we in" bugs that came up while clicking Zara's nose.
- Focus-aware defaults in `0.1.89` (user feedback: "why aren't you just focused on the area I selected"):
  - `desktop_screenshot` now overlays a coord grid by default when an agent-focus region is active. Labels are FOCUS-RELATIVE (top-left = 0,0) so the agent can read a target's coords straight off the gridded image and pass them as `{x, y, space: "focus"}`. Pass `grid: false` to opt out.
  - `desktop_calibrate_pointer` defaults to `area: "focus"` when a focus region is active — the calibration overlay covers just the focus region, with 5 targets placed inside it. Smaller blast radius (no whole-monitor takeover) and a tighter fit for the area the user actually cares about. Override with `area: "monitor"` to calibrate the whole monitor.
- Readable grid + grid-on-zoom in `0.1.90`: grid label font bumped from Consolas 9 → 12 bold so labels survive when full-focus screenshots get downscaled by chat UIs. `desktop_screenshot_zoom` now overlays a grid by default with step ~radius/6 (clamped 10–50px) and crop-local labels — agents can refine a coord from one zoom instead of dart-throwing.
- Chess-board cell addressing in `0.1.91` (user designed the spec): focus screenshots now overlay a sparse axis grid — ~16 cells across the larger dimension with integer pill labels on the top and left edges only (no in-cell label clutter). Labels survive any chat downscale. Pair with new `desktop_click_cell { col, row, subX?, subY? }` and `desktop_pointer_cell { col, row }` tools to address targets by cell instead of pixel. "Nose looks like cell 8,7" → `desktop_click_cell col:8 row:7` lands at the cell center; subX/subY in [-0.5, 0.5] for sub-cell precision. Cell step is `max(focus.width, focus.height) / 16` clamped to [20, 200] — both grid renderer and click_cell read from the same helper so they stay in sync.
- On-screen focus grid overlay in `0.1.92`: tray "Show focus grid" item (visible when a focus region is active) draws the SAME chess-board grid as a click-through overlay directly on the user's screen. Human and agent share one coord system in real time — user reads "nose is at cell 8,7" off their screen and the agent calls `desktop_click_cell col:8 row:7`, no screenshot round-trip, no eyeballing a downscaled image. Also exposed as `desktop_focus_grid { action }` MCP tool. Auto-respawns when the focus region moves; auto-dies when focus is released.
- `desktop_pick_point` in `0.1.93`: agent asks user "click the spot you want me to target", a translucent capture overlay appears over the focus region, user clicks once, bridge returns the click as focus-relative pixel, absolute pixel, AND chess-board cell coords. Eliminates "click HERE → I guess where HERE is" entirely when the human can show the AI. Best paired with desktop_click_cell using the returned col/row/subX/subY.
- Tray status anti-flap in `0.1.94`: user reported the tray icon kept flipping green↔red even though the daemon process was up and the relay was working. Two changes:
  - HTTP status-poll timeout bumped 1.0s → 3.0s and interval 2.0s → 4.0s so transient daemon stalls (PS spawns, brief WS reconnects, GC) don't time out the poll.
  - Stickiness: a failed poll is now ignored if the last successful poll was within 1 cycle — only after 2 consecutive misses does the menu surface "Disconnected." A real daemon crash still shows correctly within ~12s; a flap that resolves in one cycle is invisible to the user. Tray.log still records every state transition for debugging.

### Fixed
- Fixed `desktop:execute` shell safety in `0.1.48` so PowerShell `Remove-Item -Recurse -Force` is blocked before execution.
- Fixed negative wheel deltas for `desktop:gui:scroll` in `0.1.48`.
- Fixed bridge-driven browser recording in `0.1.48` so agent-initiated click/type/press/scroll/navigate actions are captured for playback.
- Fixed updater fallback in `0.1.49` when `.version` says an older payload but the tray is already running from a newer extracted payload directory.

## [0.1.0] - TBD

First public release. Pending standalone smoke test on fresh Windows and macOS machines.
