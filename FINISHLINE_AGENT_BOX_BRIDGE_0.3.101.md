# FinishLine: Agent Box Bridge update and browser lifecycle

## Surface Matrix

| Surface | Platform | State | Expected |
| --- | --- | --- | --- |
| Bridge console Version panel | Linux headless Agent Box | update available | Uses signed systemd/headless update path; never asks for a legacy tray |
| Scheduled updater | Linux headless Agent Box | installed 0.3.82, newer release live | Accepts backward-compatible signed health metadata and installs automatically |
| Controlled Chrome | Linux Agent Box | browser open during Bridge restart/update | New process recovers the profile only when prior lock owner is proven dead |
| Browser close | Linux Agent Box | controlled session open | Returns `closed:true` only after exact session/process completion evidence |
| CLI routes | Windows Local/Vault + Linux Agent Box | installed authenticated providers | Installed CLIs remain ready and exact-marker turns pass after release |

## Evidence Log

- 2026-09-02 `my-vps-c45d`: console reported installed 0.3.82 / available 0.3.100, but Apply update returned the tray-only error even though this is a systemd headless install.
- 2026-09-02 `headless-update.cjs check`: signed release rejected as `health-blocked` because production emitted `release-acceptance-passed`, outside the health values understood by 0.3.82.
- 2026-09-02 post-manual signed install: prior Chrome PID 26887 was dead but account-profile Singleton locks remained; page audit recovered only after those exact stale locks were removed.
- 2026-09-02 Bridge 0.3.100: open/text/snapshot/evaluate/screenshot passed on Agent Box; close still returned `success:true, closed:false`.

## P0/P1/P2/P3 Hitlist

- P1: headless updater is blocked by an incompatible release-health label.
- P1: local console routes headless updates through the legacy desktop tray.
- P1: browser close reports success without completing the close.
- P1: Bridge restart may leave dead-owner Chrome profile locks behind.

## Removed/Changed List

- Added a single-purpose systemd path unit for managed Linux update requests;
  the console now selects it automatically and retains the tray queue on
  desktop installs.
- Added an exact-target Chrome close endpoint and agent-tab bookkeeping that
  returns `closed:true` only after the target leaves Chrome's inventory.
- Added Linux-only dead-owner validation for Chromium `SingletonLock`, with
  deletion limited to the three `Singleton*` entries and no action on live,
  malformed, permission-denied, Windows, or macOS states.
- Production/live index construction now rejects health states outside the
  vocabulary already deployed in Bridge updaters.
- Synchronized the canonical welcome-page source with the generated console;
  the drift was discovered when an early regeneration removed newer provider
  controls, and the full suite proved the corrected source preserves them.

## Verification Runs

- Baseline is signed Bridge 0.3.100 on Local, Vault, and Agent Box.
- `node --test` targeted update/browser/lock contracts: 13 passed.
- root `npm test`: 430 passed, 0 failed, 4 POSIX-only skips.
- `npm --prefix desktop-shell run verify`: 51 passed.
- `npm --prefix headless-package run verify`: 2 passed.
- TypeScript `tsc --noEmit`: passed.
- Native release matrix, signed publication, and post-update fleet receipts:
  pending release execution.

## Blockers/Data Contracts

- Do not weaken manifest signatures, byte hashes, target selection, or rollback rules.
- Release health must remain consumable by the oldest supported updater before a new label can be emitted.
- Never delete Chrome profile locks without proving the recorded owner PID is dead.
- Browser close must distinguish request acceptance from completed shutdown.
- Operator-pool CLI billing remains API-equivalent and is out of scope.
