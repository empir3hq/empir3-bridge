# Cross-platform Electron Bridge

**Status:** complete held product candidate; universal packages/update contract, real provider/CLI acceptance, native installer lifecycles, Linux desktop/headless signed update and rollback, Authenticode-signed Windows lifecycle, and Developer ID-signed/notarized/stapled macOS install/update/rollback lifecycle are complete. Rollout remains held at 0% and nothing has been published.
**Primary product goal:** let Windows, macOS, and Linux users connect their own
LLM API providers, local OpenAI-compatible servers, and supported CLI
subscriptions to Empir3 through one maintained Bridge.

## Decision

Empir3 will keep **one Bridge engine** and give it two lifecycle hosts:

1. **Electron desktop shell** — Windows, macOS, and desktop Linux.
2. **Node headless host** — Linux servers and VPSs under systemd.

Electron is not a second Bridge implementation. It owns only the native app
lifecycle: window, tray, launch at login, updater, local diagnostics, and
platform package. It displays the existing local Bridge console and supervises
the same engine that headless Linux runs.

```text
                         Empir3 relay
                              │
                       Shared Bridge engine
        providers · models · CLIs · lending · pairing · MCP
                         │                 │
                Electron host       Headless Node host
             Windows / macOS / Linux    Linux / systemd
```

## Why Electron for this goal

The user-facing priority is provider and subscription setup, not native desktop
automation. The Bridge engine is Node/TypeScript and the existing API & CLIs
console is web UI. Electron therefore gives all three desktop platforms the
same JavaScript host without translating the engine or rebuilding the setup UI.

Electron's extra Chromium footprint is accepted for the desktop product. The
Bridge's separate automation Chrome remains lazy and does not launch in the
provider-first experience. A user who only lends an API or CLI subscription
therefore runs Electron plus the Bridge engine, not two browser windows.

## Non-negotiable invariants

1. **One provider implementation.** Electron must never contain provider
   definitions, model discovery, API request adapters, CLI invocation rules,
   or relay wire logic.
2. **Secrets stay local.** API keys, custom provider URLs, OAuth state, and CLI
   credentials remain on the device. Relay advertisement contains only the
   safe provider name, model IDs, capabilities, and availability.
3. **Explicit lending.** A discovered provider or CLI is not available to
   Empir3 agents until the user enables its lending/share toggle locally.
4. **Exact route pinning.** A selected Bridge provider stays on its exact
   device/provider/model. Failure is returned; it never silently falls back to
   a paid Empir3 model or another account.
5. **Provider-only startup.** Electron starts with
   `EMPIR3_CHROME_AUTOLAUNCH=0`. Browser and desktop capabilities wake only
   after the user asks for and permits them.
6. **Headless remains first-class.** Electron is never required on a VPS. The
   existing foreground entrypoint and systemd hardening remain supported.
7. **One release identity, multiple artifacts.** Every platform artifact in a
   release reports the same Bridge version and protocol version.
8. **No duplicate daemon.** The shell attaches to a healthy local Bridge if one
   already owns the configured port. It launches and later stops only a daemon
   it owns.
9. **No cross-instance reaping.** A supervising shell probes its exact wrapper
   port and disables the standalone host's broad predecessor cleanup. An
   unexpected port owner causes startup to fail closed; Electron never kills a
   different installed or development Bridge.

## Process boundary

The Electron renderer is untrusted display code:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- no arbitrary navigation inside the app window
- no permission grants from the renderer

The Electron main process supervises the Bridge foreground entrypoint. The
Bridge continues to bind to loopback and expose its established local HTTP
contract. This keeps Electron replaceable and lets the same contract drive
headless smoke tests.

The shell opens the existing `/welcome` console and selects the existing
`data-pane="clis"` pane. It does not clone that HTML or its API calls.

## Supported routes

### API and custom providers

The existing engine remains authoritative for:

- Anthropic, DeepSeek, Google AI, Groq, Mistral AI, Moonshot AI, OpenAI,
  OpenRouter, Perplexity, xAI, and z.ai;
- custom OpenAI-compatible endpoints;
- LM Studio, Ollama, vLLM, and private in-house endpoints;
- key testing, model discovery, model filtering, and local execution.

### Subscription-backed CLIs

The existing CLI catalog remains authoritative for installation detection,
authentication detection, model readiness, lending, invocation, transcripts,
and limits. Electron may open a visible authentication terminal, but it may not
extract or relay a vendor credential.

Availability is capability-based, not aspirational. If a vendor CLI does not
support an OS or architecture, the row must say so instead of showing a broken
install button.

## Platform matrix

| Capability | Windows desktop | macOS desktop | Linux desktop | Linux headless |
|---|---:|---:|---:|---:|
| API/custom providers | shared | shared | shared | shared |
| Model discovery/execution | shared | shared | shared | shared |
| CLI subscription lending | shared adapter | shared adapter | shared adapter | shared adapter |
| Empir3 pairing/relay | shared | shared | shared | shared |
| Provider console | Electron | Electron | Electron | local web/CLI |
| Launch supervision | Electron | Electron | Electron | systemd |
| Desktop automation | current native tools | later adapter | later adapter/portal | unsupported |

Desktop automation parity is deliberately outside the provider-first launch
gate. Capability reporting must keep unavailable tools hidden or return the
existing structured `capability_unsupported` result.

## Release model

There is one logical release and multiple signed platform artifacts. Schema 3
extends the current flat, all-string Windows manifest instead of breaking
existing bootstrappers. The structured artifact index shown here is separately
hash-pinned by the signed flat manifest:

```json
{
  "schemaVersion": "3",
  "version": "0.4.0",
  "artifacts": {
    "win32-x64": { "url": "...exe", "sha256": "...", "signature": "..." },
    "darwin-universal": { "url": "...dmg", "sha256": "...", "signature": "..." },
    "linux-x64-deb": { "url": "...deb", "sha256": "...", "signature": "..." },
    "linux-arm64-deb": { "url": "...deb", "sha256": "...", "signature": "..." },
    "linux-headless-x64": { "url": "...tar.gz", "sha256": "...", "signature": "..." }
  }
}
```

Rules:

- retain current legacy Windows manifest fields until installed Windows
  bootstrappers have aged out;
- build native/native-module artifacts on the target OS and architecture;
- sign every update with the existing Bridge update trust root or a documented
  rotation path;
- Developer ID-sign and notarize macOS packages;
- Authenticode-sign Windows packages;
- publish artifacts first and atomically swap the manifest last;
- retain at least one prior manifest/artifact set for rollback;
- website presents one Download button but selects an artifact by OS/arch.

Current schema 3 implementation keeps the legacy four fields byte-for-byte,
adds each desktop installer/archive/Squirrel file as explicit flat string
fields, and signs those fields with the existing Ed25519 trust root. Its
versioned structured index carries the same hashes plus a held/staged/live/
rollback policy and per-target package-smoke health. A deterministic device
bucket makes staged eligibility stable. Unknown architectures fail closed;
both Intel and Apple Silicon map to the one macOS universal artifact.

The rollout channel is deliberately split. Electron and the website read
`bridge-desktop-version.json`; legacy Windows bootstrappers continue reading
`bridge-version.json`. Held, staged, and desktop rollback manifests are written
only to the desktop channel because old bootstrappers ignore rollout fields.
Only a schema 3 release in `live` state at 100% may also replace the legacy
fixed manifest. The build removes a stale legacy manifest for every non-live
desktop build so the old channel cannot be changed accidentally.

## Delivery workstreams and exit gates

### Workstream 0 — architecture and executable development shell

- [x] Store this decision and support contract in the canonical Bridge repo.
- [x] Add an isolated Electron package without touching the production payload.
- [x] Launch or attach to the existing Bridge foreground runtime.
- [x] Open the existing API & CLIs pane without copying provider UI.
- [x] Default the automation Chrome to lazy/off.
- [x] Pass unit checks and an isolated Electron-to-Bridge health smoke.
- [x] Add Windows, macOS, and Linux CI lanes for pure desktop-shell checks.

### Workstream 1 — provider and subscription parity

- [x] Exercise a real protected key-backed provider through the packaged host;
  keep deterministic provider discovery/call coverage on every native lane.
- [x] Exercise one custom local endpoint on all three desktop OSs.
- [x] Exercise Codex, Claude, Grok, and Antigravity through a packaged host with
  real signed-in subscriptions; keep the exact Codex argv/stdin/JSONL contract
  deterministic on every native lane.
- [ ] Repeat protected vendor-account turns on macOS/Linux when those signing
  hosts have test identities; no production credential may be placed in CI.
- [x] Normalize executable discovery and auth-launch behavior behind explicit
  platform adapters.
- [x] Add a user-visible compatibility/blocker reason for every CLI row.

### Workstream 2 — installable desktop packages

- [x] Add Electron Forge packaging and target-specific native runtime staging.
- [x] Produce Windows x64, macOS universal, Linux x64, and Linux ARM64 packages.
- [x] Add tray/menu-bar, single-instance, launch-at-login, and bounded local
  log collection through shared shell actions.
- [x] Add the explicit clean-uninstall/data-retention contract.
- [x] Prove Linux headless install, reboot, normal uninstall/retention,
  reinstall, signed update, explicit signed rollback, bounded bad-update
  recovery, purge, and clean production-trust reinstall on a real disposable
  systemd VM.
- [x] Prove the Authenticode-signed Windows install, launch, retained-state
  uninstall, reinstall, second launch, and final uninstall cycle.
- [x] Prove macOS DMG and Linux x64/ARM64 DEB native installer lifecycles in
  the expanded CI matrix.
- [x] Repeat the macOS lifecycle against the final Developer ID-signed,
  notarized, and stapled package.
- [x] Prove signed-manifest desktop update/rollback behavior on Linux x64 and
  ARM64 native hosts.
- [x] Prove signed desktop update/rollback behavior on a native macOS host.

The held macOS candidate workflow contains that final gate: it builds
two separately Developer ID-signed/notarized/stapled universal DMGs, verifies
the signed manifest and exact download bytes, replaces a disposable installed
app with the next version, launches it, consumes only the explicit rollback,
relaunches the base version, and checks retained state. Apple accepted the real
credentialed 0.3.55/0.3.56 run on 2026-08-04; every signature, notarization,
stapling, installer, retained-state, update, and rollback gate passed.

The unsigned package lab runs natively in CI on Windows x64, macOS universal,
Linux x64, and Linux ARM64. Each lane stages only the correct native runtime
(both macOS architectures for a universal app), builds installer/archive
makers, launches
the packaged executable with isolated home/ports and no relay, verifies the API
& CLIs pane, adds a temporary OpenAI-compatible provider, discovers its model,
makes an authenticated completion through the shared `custom_llm` route,
confirms Chrome stayed dormant, discovers a deterministic Codex-compatible
executable, enables its actual lend setting, executes the production
`cli_run` stdin/JSONL contract, records SHA-256 receipts, and uploads the test
artifacts for 14 days. The deterministic CLI proves packaging and invocation;
it does not replace the real vendor-account acceptance gate above.

Every package smoke is state-isolated, not merely port-isolated. It redirects
home, Windows roaming/local app data, XDG config/data, Electron user data, and
the Chrome profile, then refuses to proceed unless the Bridge reports a data
directory inside that temporary root. This prevents provider/lending/safety
test mutations from touching an installed Bridge profile.

Uninstall has an explicit retention contract: application binaries and startup
registration are removed, while local provider definitions, encrypted/saved
API keys, endpoint definitions, and logs are retained by default for a later
reinstall. The tray's **Prepare for Uninstall** action states this before it
disables startup, stops only the managed Bridge child, and quits. Windows also
removes startup registration on the exact Squirrel uninstall event. Linux XDG
cleanup deletes only an Empir3-marked autostart file and refuses to overwrite
or remove an unmanaged file at the same path. Deliberate credential/data reset
is a separate destructive action and is not implied by uninstall.

### Workstream 3 — universal release manifest and staged updater

- [x] Implement backward-compatible manifest schema 3.
- [x] Select artifacts by exact OS/architecture.
- [x] Add signed staged rollout, hold, rollback, and per-platform health signal.
- [x] Implement the website's automatic platform choice and explicit Other
  platforms menu; production links remain dormant until signed artifacts are
  published.

The signed data contract, deterministic rollout decision, publisher ordering,
and per-platform package-smoke health are implemented. The packaged desktop
host consumes the policy, refuses unsigned/unhealthy/wrong-target artifacts,
allows a downgrade only for an explicitly signed rollback from the named bad
version, streams and verifies the installer before opening it, and writes a
local startup-health receipt. Real clean update and rollback runs on each target
remain part of the Phase 2 acceptance gate rather than this contract gate.

Windows and macOS are accepted only with recognized platform authentication
schemes. Linux is deliberately different: a production-only aggregation flag
marks exact DEB/ZIP/headless bytes authenticated by the Ed25519-signed schema 3
manifest. Test channels cannot set that state, and the publisher independently
verifies the production trust root before upload.

### Workstream 4 — optional desktop capability adapters

- [ ] macOS Accessibility/Screen Recording onboarding and native adapter.
- [ ] Linux Wayland portal adapter and explicit user-consent UX.
- [ ] Decide whether the stable Windows Python tray is retired after Electron
  reaches feature and recovery parity.

## Test matrix

Every shared-engine change continues to run the Bridge unit suite. Every shell
change adds:

- pure lifecycle/config/navigation unit tests on Windows, macOS, and Linux;
- isolated-port launch → `/health` + `/api/status` → clean-stop smoke;
- provider-console render and API contract smoke;
- one real provider test using CI-injected test credentials only in protected
  release jobs;
- native package install/update/uninstall smoke per target;
- assertion that provider-only startup did not launch Chrome;
- assertion that package settings/logs remain under the temporary test root;
- deterministic lent-CLI discovery, opt-in, exact argv/stdin contract, and
  answer parsing on every native package lane;
- assertion that an attached existing daemon is never stopped by the shell;
- assertion that an isolated smoke does not restart the installed Bridge.

## Change routing

| Change | Where it belongs |
|---|---|
| Provider/model/CLI behavior | shared Bridge engine |
| API & CLIs screen | shared local console in `src/server.ts` |
| Relay metadata/wire shape | shared Bridge engine + Empir3 server contract |
| Window/tray/startup/update | `desktop-shell/` |
| macOS/Linux process or credential integration | named platform adapter |
| VPS/service lifecycle | existing headless/systemd path |

If a pull request adds provider logic under `desktop-shell/`, it violates this
decision and should be redesigned before merge.

## Current implementation boundary

The current 0.3.55 candidates are test-only and have not replaced the installed
0.3.54 Windows Bridge or either production update channel. The native matrix
builds and smokes Windows x64, macOS universal, Linux x64, and Linux ARM64
desktop packages plus Linux x64/ARM64 headless archives. Its universal held
index contains 12 target-specific files and refuses any missing, duplicate,
mixed-version, wrong-architecture, or hash-mismatched input.

Protected Windows acceptance on 2026-08-04 launched the packaged executable
with isolated state and no relay, then proved:

- LM Studio discovery and a real `qwen/qwen3.5-9b` completion;
- a locally stored Google AI key, 33 discovered chat models, and a real
  `gemini-2.5-flash` completion;
- real signed-in Codex, Claude, Grok, and Antigravity subscription turns;
- Chrome remained dormant and the installed Bridge was not touched.

That run also caught a real Codex error-reporting defect: a zero-exit JSONL
`turn.failed` event was being returned as successful raw output. The shared
engine now parses structured failures and the acceptance runner requires its
exact response marker, so non-empty error transcripts cannot pass.

Linux headless acceptance used a disposable Ubuntu 22.04 systemd VM. It proved
root-owned immutable runtime releases, non-root service execution, reboot
persistence, provider-state retention, same-version repair, signed upgrade,
signed rollback, a deliberately broken signed update capped at five restarts
in 60 seconds, automatic restoration of the prior healthy release, explicit
purge, and clean reinstall with the production trust root.

Production publication is now gated on explicit rollout approval, not missing
native-package evidence. Windows Authenticode plus install/remove/reinstall is
proven. The macOS 0.3.55 base and 0.3.56 next-version universal packages are
Developer ID-signed, notarized, stapled, and proven through native install,
update, rollback, relaunch, and retained-state cycles. Linux x64/ARM64 desktop
and headless install/update/rollback/remove lifecycles use signed-manifest
authentication until an apt repository is introduced. The publisher remains
fail-closed, rollout stays held at 0%, and no unauthenticated package may enter
the production download channel.
