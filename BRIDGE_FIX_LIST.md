# Empir3 Bridge Fix List

This is the persistent pre-release batching ledger for Bridge product issues.
Items are gathered here before implementation so runtime, Accuracy Lab, icon,
installer, and package changes can ship in one deliberately verified release.

**Current release rule:** Bridge 0.3.68 is published and accepted. New findings
belong to a later batch unless they are a regression in the live release.

## Surface Matrix

| Surface | Viewport / environment | Evidence | State |
| --- | --- | --- | --- |
| Bridge Console overview | Windows desktop Electron shell | Installed 0.3.66 screenshot + calibration API, 2026-08-05 | Verified installed: green `Calibrated` only after the strict gate passed |
| Windows taskbar and tray identity | Windows 11 desktop | Installed 0.3.66 taskbar/tray screenshots, 2026-08-05 | Verified: new Bridge glyph replaces Zara/default Electron on current app surfaces |
| Accuracy Lab | Bridge Chrome, 1344 x 749 CSS viewport, three calibrated monitors | Packaged 0.3.66, 103-click real OS sweep, 2026-08-05 | Verified: 103/103 hits, 0 misses, 1.05 px mean, 1.96 px worst |
| Windows/macOS/Linux download packages | Electron Forge and native release outputs | Signed receipts + public manifest/download verification, 2026-08-05 | Verified published: production/live 100%, 12 authenticated artifacts across 6 targets |
| Website Providers + Agent Builder / production desktop | Zippy account, live Vincent Bridge 0.3.66 | Production UI + guarded recovery tests, 2026-08-05 | Verified live: Bridge recognized; LM Studio 25 models and Spark 1 model online |
| Project Chat local workspace | Production Admin project + selected Windows Bridge | Exact user click and success receipt, 2026-08-06 | Verified live: canonical project folder opened through the selected Bridge |

## Hitlist

| ID | Severity | Finding | Required outcome | Status |
| --- | --- | --- | --- | --- |
| BR-001 | P2 | The Console has `Launch browser` but no first-class calibration workflow or trustworthy at-a-glance calibration state. | Add an orange `Calibrate` button beside `Launch browser`. Calibrate every connected monitor in sequence, show monitor progress, launch the Accuracy Lab, run its real OS-click verification, and turn green with `Calibrated` only after all current monitors and the lab pass. Monitor topology/DPI changes or stale/failed results must return it to orange with a retry path. | Closed in 0.3.66; installed three-monitor workflow and strict lab gate passed |
| BR-002 | P3 | The Electron tray uses the Zara avatar (`assets/zara-accent.png`), which reads as a persona instead of a desktop utility. | Create one simple, high-contrast Empir3 Bridge glyph that remains legible at Windows tray sizes and has clear connected/disconnected variants without replacing the product identity. | Closed in 0.3.66; installed tray visually verified |
| BR-003 | P3 | The Electron window and Windows taskbar show the default Electron atom because the BrowserWindow/Forge package has no configured product icon. | Apply the Bridge identity to BrowserWindow, Electron packager, Windows AppUserModelID/taskbar grouping, shortcuts, notifications, and installed application metadata. No Electron atom may remain after a clean install and upgrade. | Closed in 0.3.66; installed running taskbar/window identity visually verified |
| BR-004 | P3 | Download/install artifacts do not share a complete product icon set. | Produce and wire a single source asset into multi-resolution Windows `.ico`, macOS `.icns`, Linux PNGs, tray/template assets, Squirrel setup/package metadata, the Go bootstrap resource, and download-package presentation. Verify the icon on the downloaded file, installer, installed shortcut, running taskbar entry, and tray/menu bar. | Closed in 0.3.66; signed/authenticated package matrix published and live |
| BR-005 | P2 | Several SVG shape centers were mapped as if the entire SVG viewBox filled its element; preserved-aspect-ratio letterboxing displaced the real visible geometry. The orbit point also occupied hollow/overlapped geometry. | Score centers through the rendered SVG transform and place every declared point on stable, exposed visible geometry. A center-directed real OS click must register against the intended target. | Closed in 0.3.66; packaged real-click rerun hit every shape |
| BR-006 | P2 | A target can move during smooth/in-flight scrolling between coordinate capture and hardware dispatch. The final `history-filter` attempt became a 55.6 px miss after horizontal movement. | Use instant target reveal or explicitly wait for scroll settlement, then re-read the target rectangle immediately before the hardware click. Add a moving-target regression check. | Closed in 0.3.66; regression-covered and packaged real-click rerun passed |
| BR-007 | P2 | The live Accuracy Lab registry falls from 103 to 80 targets as layer-eye controls hide earlier canvas targets, while the original sweep still contains 103 items. | Freeze a baseline registry for the run or otherwise preserve stable totals, remaining count, and checklist semantics even when test controls mutate visibility. The displayed total must remain coherent from reset through completion. | Closed in 0.3.66; regression-covered and packaged 103-click rerun stayed coherent |
| BR-008 | P1 | The Accuracy Lab header hardcodes `offline` even while the Bridge and relay are connected. | Replace the false operational claim with a real sourced status or neutral wording such as `local test`. Never render a hardcoded live/offline claim. | Closed in 0.3.66; regression-covered and packaged UI verified |
| BR-009 | P1 | The website says `Bridge connected` while Providers says `Bridge offline or no provider shared`, and Agent Builder omits My Bridge. A reinstall left `selectedBridgeDeviceId` pinned to a retired device ID while the sole live Bridge has a newer ID. | Recover a stale selection only to the same account's unambiguous live replacement, keep exact device targeting when multiple/different machines exist, refresh provider availability after recovery, and expose LM Studio/Spark in Providers and Agent Builder. | Closed in production; durable recovery deployed and verified with 0.3.66 |
| BR-010 | P3 | Windows retains one pre-0.3.64 pinned taskbar entry under the retired AppUserModelID beside the correct stable 0.3.66 identity. | Provide a safe one-time shortcut/pin migration or clear repin guidance without silently mutating a user's taskbar. New installs and the running app must continue using `com.empir3.bridge`. | Gathered for a later batch; not a 0.3.66 blocker |
| BR-011 | P1 | Project files sync locally, but Project Chat had no direct way for a user to open that project's local directory on the selected computer. | Add a user-only project-folder action that targets one selected Bridge, derives the canonical directory from trusted project identity, refuses path/symlink escapes and headless hosts, honors Execute gates, and opens the native file manager without a shell. | Closed in 0.3.68; production click accepted end to end |

## Evidence Log

### 2026-08-05 — Real hardware-click Accuracy Lab sweep

- Three connected monitors had fresh calibration with approximately 0.5-1.12 px residuals.
- 103 targets were attempted exactly once using real OS-level mouse clicks.
- Raw result: 101 hits, 2 misses, 98.06% hit rate.
- Successful clicks averaged 2.15 px from the live target center; worst successful offset was 2.84 px.
- Miss 1: hollow orbit-ring target, 2.04 px from its declared but non-clickable center.
- Miss 2: `history-filter` moved during scrolling; the lab attributed the resulting click to nearest target `color-apply`, 55.6 px away.
- Small node handles, layer controls, property controls, and color swatches otherwise passed.

### 2026-08-05 — Icon/source trace

- `desktop-shell/src/main.cjs` explicitly uses `assets/zara-accent.png` for the Electron tray.
- The Electron `BrowserWindow` and `desktop-shell/forge.config.cjs` do not configure a product icon, explaining the default Electron taskbar icon.
- The legacy Python tray draws a generic status-colored `E`, so identity is inconsistent across lifecycle hosts.
- The Go bootstrapper has an existing `empir3.ico` resource, but it is not yet one shared cross-platform icon system.

### 2026-08-05 — Connected/Providers contradiction

- Bridge 0.3.63 was relay-connected as `zip@empir3.com`; LM Studio local and
  Spark Cluster were online and shared.
- The local Bridge identity was `bridge-75eada0b-...-b034fe85fd6e` (`Vincent`).
- Zippy's production `selectedBridgeDeviceId` still pointed at the retired
  `bridge-bc81ddab-...-1ff034e7caba`; two older same-name records remain offline.
- `Connect Bridge` uses any live device presence, while custom-provider probes
  strictly targeted the stale selected ID. This made both screens internally
  consistent but mutually contradictory.
- A guarded one-row production repair moved only Zippy's selection to the live
  Vincent ID. Permanent recovery and regression coverage remain required.

### 2026-08-05 — Repaired provider surfaces

- After the guarded production repair, the Providers page showed LM Studio
  local ONLINE with 25 shared models and Spark Cluster ONLINE with one shared
  model on Vincent.
- Agent Builder reported `Your bridge · online`; its Brain picker exposed all
  25 LM Studio models and the Spark Cluster model as `MY BRIDGE` routes.
- The durable server recovery has five regression cases: same-name sole live
  replacement, unchanged live selection, multiple-live ambiguity, different
  machine name, and missing persisted identity.

### 2026-08-05 — Packaged 0.3.66 calibration and Accuracy Lab proof

- Installed the signed Windows 0.3.66 package over the existing paired Bridge;
  account pairing, relay connection, and shared-provider settings survived.
- Five real pointer samples on each of three monitors produced a worst monitor
  residual of 0.24 px.
- The packaged Accuracy Lab registered 103 of 103 actual OS clicks with zero
  misses. Mean target offset was 1.05 px and the worst was 1.96 px.
- The API recorded `calibrated`, `passed: true`, `topologyCurrent: true`, and
  `All monitors and the Accuracy Lab passed` at 2026-08-05T17:10:28.958Z.
- Lab screenshot: `C:\Users\VK\.empir3-bridge\runtime\feedback\desktop\desktop-1785949845692-DISPLAY2.png`.
- Green Console screenshot: `C:\Users\VK\.empir3-bridge\runtime\feedback\desktop\desktop-1785949872052-DISPLAY5.png`.
- Tray screenshot: `C:\Users\VK\.empir3-bridge\runtime\feedback\desktop\desktop-1785947836368-region-3100x1400-740x688.png`.

### 2026-08-05 — Final production provider rerun

- On the production Providers screen, the paired Vincent Bridge remained
  recognized after the signed 0.3.66 install; no Bridge-offline warning rendered.
- Spark Cluster was ONLINE with one shared model and one assigned agent.
- LM Studio initially reported `fetch failed` because its local server process
  was stopped, not because the Bridge was disconnected. After launching LM
  Studio and pressing the production refresh button with a real mouse click, it
  returned ONLINE with 25 shared models.

### 2026-08-05 — 0.3.66 production publication

- Full cross-platform CI run `31028881987` and signed/notarized macOS run
  `31028883789` completed successfully against exact source commit `f913734`.
- The production index contains 12 authenticated artifacts across six targets:
  desktop Windows x64, universal macOS, Linux x64/ARM64, and headless Linux
  x64/ARM64. Windows uses Azure Authenticode, macOS uses Developer ID plus
  notarization/stapling, and Linux bytes are bound by the signed schema 3 manifest.
- The index SHA-256 is
  `a19f6d30faa5418a830659b43a3cce1dde68f7fbbfa036c224cc53347ce6b4a0`.
  The byte-identical desktop and legacy manifest SHA-256 is
  `cb51d917f3b606ea332b2d965ea4fe653cbe40af3dac59b6f16dd7255f33b272`.
- The publisher verified every public package hash, atomically promoted both
  manifests, passed both fixed-URL cache gates on the first try, and promoted
  `Empir3Setup.exe` last. Its SHA-256 is
  `802b58f3b205053c4f0ba84d1cd096aa341b613743cec0d91dacba5490d2d20a`.
- Both public manifests report 0.3.66, schema 3, production/live at 100% with
  previous version 0.3.64. `https://empir3.com/download` rendered 0.3.66 and
  selected the correct Windows, macOS, Linux x64, Linux ARM64, and headless URLs.
- The zero-history public source snapshot is commit `43e1483` on
  `empir3hq/empir3-bridge`.

### 2026-08-06 — 0.3.68 local project workspace and production publication

- Commit `60f6499` adds the selected-device `desktop:project` handler and the
  canonical project-workspace resolver; `10f0a28` makes its realpath assertion
  portable across macOS `/var` and `/private/var` spellings.
- The resolver accepts only trusted project id/name values, creates the folder
  under the configured Projects root, validates textual and resolved-realpath
  containment, rejects headless machines and symlink/junction escapes, and
  launches Explorer, Finder, or `xdg-open` without a shell.
- Exact-source cross-platform CI `31072579634` passed all Windows, macOS,
  Linux x64/ARM64, Node 18/20, package, installer, MCP, and universal-index jobs.
  The separately signed macOS candidate passed Developer ID signing,
  notarization, stapling, Gatekeeper, installer, update, and rollback gates.
- The production schema-3 index contains 12 authenticated artifacts across six
  targets. Its SHA-256 is
  `26816d7b5117b0f6b7bf75cfc24ad27cfea4246604a53ad3357b6923a02b3124`.
  Desktop and legacy manifests are byte-identical, production/live at 100%,
  and hash to
  `e8ad0dea09e8bdfdcdf825402ce648da5bf24d19c7ba9d0fbb4d843f78a666c4`.
- The publisher uploaded directly to the production download host, verified every remote and public
  package hash, promoted both manifests atomically, and published the signed
  bootstrapper last. The signed bootstrapper SHA-256 is
  `a46e8153ee46542b54430d3541db797e8cd7be21eaed8be0fa22750d72989271`.
- The local Windows installation updated from 0.3.66 to 0.3.68 without losing
  its existing Zippy pairing. A production Project Chat click then returned
  `Opened Empir3 on DESKTOP-DK98E17.`, proving the website, target selection,
  permission gates, Bridge handler, and folder resolution. That acknowledgement
  did not prove the Explorer window was visible; the 0.3.69 follow-up below
  corrects this acceptance gap.

### 2026-08-06 — 0.3.69 visible Windows project folders

- Windows Shell Automation inspection showed that every project folder opened
  by 0.3.68 had `Visible: false`. The Bridge had spawned `explorer.exe` with
  `windowsHide: true`, so the process started successfully and produced a
  success acknowledgement while Explorer honored the hidden-window request.
- Commit `a510159` changes only the project-folder launch to
  `windowsHide: false`, adds a regression assertion for the visible-window
  option, and releases the repair as 0.3.69. Console and helper processes keep
  their existing hidden-window behavior.
- The source suite passed 232 tests with four platform skips, plus TypeScript,
  MCP bundling, release/signing preflight, Authenticode verification of 39
  packaged files, and the packaged-app smoke test. Exact-source cross-platform
  CI `31077225587` and signed/notarized macOS CI `31077227356` completed
  successfully, including Windows/macOS installer lifecycles, the universal
  artifact-index gate, and signed macOS update/rollback.
- The production schema-3 index contains 12 authenticated artifacts across six
  targets and hashes to
  `e80f80682f2c82f28a1d2228bf4321aec4c4a9ffa2dca2979bc1eee11197e8c3`.
  The byte-identical desktop and legacy manifests are production/live at 100%
  and hash to
  `3e3a5efbbcfb0d5c60b57eb0bf6ba3495084cd8d510de5b500492968aced3344`.
  The signed bootstrapper hashes to
  `85131cec0300b318156d51dd3f1726ccecd755393ff9324b8217ed04aaefcfb6`.
- The publisher verified every public package hash before atomically promoting
  both manifests and publishing the bootstrapper last. The local Windows
  installation updated from 0.3.68 to 0.3.69 without losing its Zippy pairing.
  An installed-package `desktop:project` command then opened
  `Installed Visible Acceptance`; Windows reported the matching Explorer window
  as `Visible: true`. A separate production Project Chat replay preserved the
  selected-device route and displayed its success acknowledgement.

## Removed / Changed List

- Gathering-only release hold removed after the user's explicit 2026-08-05 go-ahead.
- Generated signed release evidence is now narrowly ignored by Git while remaining on disk.

## Verification Runs

| Date | Run | Result |
| --- | --- | --- |
| 2026-08-05 | Initial Accuracy Lab diagnosis, 103 real OS clicks | 101/103 exposed SVG mapping and moving-target defects; drove BR-005/006 corrections |
| 2026-08-05 | Packaged 0.3.66 Accuracy Lab rerun, 103 real OS clicks | 103/103, zero misses, 1.05 px mean and 1.96 px worst offset |
| 2026-08-05 | Zippy Providers + Agent Builder after durable production recovery | LM Studio 25 models and Spark 1 model online in Providers; both route families present in Agent Builder |
| 2026-08-05 | Source regression suite | 226 Bridge tests (223 pass, 3 platform skips), Go bootstrap tests, desktop shell 43/43, release preflight, and 3-monitor calibration API smoke passed |
| 2026-08-05 | Hosted full CI `31028881987` | Windows/Linux package, installer, MCP, compatibility, update, rollback, and held-index gates passed on exact commit `f913734` |
| 2026-08-05 | Hosted signed macOS candidate `31028883789` | Developer ID signing, notarization, stapling, packaged app, installer, update, and rollback gates passed on exact commit `f913734` |
| 2026-08-05 | Production publisher + independent public rerun | 0.3.66 live/100; all 12 package URLs hash-verified; website platform links selected 0.3.66 |
| 2026-08-06 | Source regression suite | 236 Bridge tests: 232 pass, 4 platform skips; TypeScript, MCP bundle, release/signing preflight, and Windows package smoke passed |
| 2026-08-06 | Hosted full CI `31072579634` | Every Windows, macOS, Linux x64/ARM64, Node 18/20, package, installer, MCP, and universal-index job passed on exact commit `10f0a28` |
| 2026-08-06 | Production publisher + Project Chat acknowledgement | 0.3.68 schema 3 live/100; all 12 public package hashes verified; installed Windows Bridge updated; UI acknowledgement passed, but window visibility was not yet verified |
| 2026-08-06 | Visible Explorer repair + production acceptance | 0.3.69 schema 3 live/100; exact-source cross-platform and signed macOS pipelines passed; all 12 public package hashes verified; installed Windows Bridge retained pairing; project command produced a Windows Explorer window with `Visible: true` |

## Resolved Data Contracts

- Persisted calibration-pass record: monitor identity, bounds, DPI,
  calibration version, residual, lab result, and completion timestamp.
- Invalidation rules: monitor add/remove, resolution/orientation/DPI
  change, stale calibration version, and failed/cancelled Accuracy Lab run.
- Final Bridge identity artwork is a purple suspension-bridge glyph with an
  orange product node and green/orange connected-state badges. It is
  designed for 16-24 px system surfaces first, then expanded to installer and
  download sizes.
- Final Accuracy Lab gate: every current monitor has a fresh residual no worse than 3 px,
  the corrected lab completes all 103 attempts, and no successful target offset
  exceeds 5 px.

## Release Batch

Release batch approved and completed 2026-08-05:

1. Resolve every P1/P2 item and the unified icon set together.
2. Run focused tests without building distributables.
3. Run the corrected Accuracy Lab with real clicks and record evidence here.
4. Build the complete Windows/macOS/Linux package matrix once.
5. Verify clean install, upgrade, taskbar/tray identity, downloaded artifact
   icons, calibration invalidation, and rollback before publishing once.
