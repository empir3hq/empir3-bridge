# SPEC — 0.3.46: per-agent tabs + "who's driving" title badge

**Status: ready to implement.** Authored 2026-07-29 on the MSI session (the one that
shipped the vault fixes `619957f` and the app-side attribution `empir3-release@60b34a4d`).
This release is cut on the signing machine; it must include `619957f` (already on main)
plus this feature.

## Goal (the user's ask, verbatim intent)

Specialists (Koba/Zara/Park) can now drive the bridge browser from DMs — approved and
live on prod. Two agents would currently fight over the single agent tab. The user:
*"This bridge is supposed to have the ability to launch multiple tabs. And if it was
going to launch multiple tabs, it should show the agent who is controlling it in the
title bar somewhere."*

So: **each driving agent gets its own tab, and the Chrome tab strip shows who's
driving it** — e.g. `[Koba] Empir3 — AI Team`.

## What already exists (verified against source, 2026-07-29)

**App side (shipped, prod):** every `agent-browser`/`browse` command's `params` now
carries `agentId` (role slug: `ceo`, `developer`, `designer`, `analyst`, or a custom
agent id) and `agentName` (display name: `Vincent`, `Koba`, …). See
`empir3-release/server/src/runtime/router/invocables/browserControl.ts` (stamped just
before `executeToolOnCompanion`). Older bridges ignore the keys — this feature is the
consumer. MCP + CLI commands do NOT carry them (local Claude Code has no agent
identity) — absence of `agentId` MUST mean "legacy shared-tab behavior, unchanged".

**Bridge tab model today:**
- `knownTargets: Map<targetId, url>` — `src/bridge.ts:80`, maintained by
  `handleNewTarget` (:1308) / url-change (:1319) / target-destroyed delete (:1273).
- `currentTargetId` + `switchToTarget(targetId)` — `src/bridge.ts:569`. The whole CDP
  action layer operates on "the current tab".
- `evaluateOnTarget(targetId, expr)` — `src/bridge.ts:968` — can run JS on a
  NON-current tab (via /json or browser-session attach). Use this for title stamps so
  you never have to switch tabs just to badge one.
- `autoInjectIntoTarget(targetId, url)` — `src/bridge.ts:1330` — fires on new targets
  AND on url changes. This is the re-stamp hook (titles reset on navigation).
- ONE `agentControlTarget` + ONE `userFocusTarget` — `src/server.ts:449` and the
  `browser_tab_state`/`browser_tab_focus` handlers (~:12199–12259). The user-focus
  handoff semantics must keep working: an agent must never drive a tab whose
  `userFocusTarget` marks it as the user's.
- Empir3-channel flow: relay msg → `handleAgentBrowser(action, params)`
  (`src/server.ts:7170`) → `executeCommand({type…})` → wrapper switch → `cdpPost('/action', …)`.
  `handleAgentBrowser` is the ONE chokepoint that sees `params.agentId` — do the tab
  resolution there, not deeper.

## Requirements (v1)

1. **Agent tab pool.** `agentTabs: Map<string /*agentId*/, { targetId: string; agentName: string }>`.
   On an agent-attributed command (`params.agentId` present):
   - If the agent has a live tab (`knownTargets.has(targetId)`), `switchToTarget` to it
     before executing. Leave it current afterwards (visible hand-off IS the feature).
   - If not, and the action is `open`/`navigate`/`show`: create a NEW tab for that url
     (CDP `Target.createTarget` via the browser WS — see `browserSend` usage at
     `src/bridge.ts:691`) and record it.
   - If not, and the action is anything else (snapshot/click/text/…): fall back to the
     current shared behavior (drive `currentTargetId`) — do NOT create blank tabs for
     read/act commands. Record the tab as that agent's ONLY if no other agent owns it.
   - No `params.agentId` → exactly today's behavior. MCP/CLI paths untouched.
2. **Title badge.** After each successful agent-attributed command, stamp the agent's
   tab title: `document.title = '[<agentName>] ' + title` unless it already starts
   with `[<agentName>] `. Implement as one idempotent helper (strip any existing
   `^\[[^\]]{1,24}\] ` prefix, then prepend) via `evaluateOnTarget`. Keep a
   `targetId → agentName` map and re-stamp from `autoInjectIntoTarget` so navigations
   keep the badge. Best-effort — a page rewriting its own title later is acceptable;
   never throw a command failure because a stamp failed.
3. **User-focus safety.** If the resolved agent tab IS `userFocusTarget`'s tab, do not
   drive it — return the existing "hand back"/denial shape the tab_focus model uses.
   `agentControlTarget` should continue to reflect the tab of the most recent driving
   agent (or be extended to a per-agent list in `browser_tab_state` output — additive
   field, don't break existing consumers).
4. **Serialization.** `switchToTarget` + execute is not atomic; two agents' commands
   interleaving would race `currentTargetId`. Wrap agent-browser command execution in
   a simple promise-chain queue (module-level `let queue = Promise.resolve()`), so
   switch+execute pairs run one at a time. Cheap and sufficient — per-call approval
   below L5 already spaces commands out.
5. **Tab lifecycle.** When a target is destroyed (`src/bridge.ts:1273` handler),
   drop any `agentTabs` entry pointing at it (next command re-creates).
6. **Emulation limitation (document, don't solve).** The device-emulation hold is a
   single global `emulationSession` bound to the current page target
   (`src/bridge.ts:1513`, `openPageCdpSession` attaches to `currentPageTarget()`).
   With per-agent tabs this means: ONE emulated tab at a time, and `emulate_device`
   applies to whichever tab is current when it runs. v1: after the per-agent switch
   this is naturally "the calling agent's tab" — fine. Scoping emulation per-target is
   a stretch goal, NOT required for 0.3.46. Add one line to `docs/AGENT_GUIDE.md`'s
   phone-resolution section noting the one-emulated-tab-at-a-time constraint.
7. **No permission/gating changes.** enabledTools, R/W/E, empir3 policy, family gates
   all stay exactly as they are.

## Verify plan (live, on any workstation bridge)

1. Two DMs as the same user (Koba + Zara), both told to open a site through the
   bridge → two distinct tabs appear, titles `[Koba] …` and `[Zara] …`; commands
   land on the right tabs.
2. Navigate one of them → badge survives the navigation (auto-inject re-stamp).
3. MCP path (Claude Code `browser_navigate`) still drives the classic shared tab, no
   badge, no behavior change.
4. `browser_tab_state` still parses for existing callers; user tab-focus handoff
   still refuses agent writes on the user's tab.
5. Close an agent's tab by hand → agent's next `open` recreates it cleanly.
6. `npx tsc --noEmit` + `npm test` green; `python -m py_compile tray/tray.py`
   (tray untouched by this feature but 619957f changed it — keep it compiling).

## Release checklist (0.3.46)

1. Confirm main includes `619957f` (vault tray mutex-handoff + gh-auth TTY fixes) —
   it's pushed; do NOT rebase it away.
2. Implement this spec; bump `package.json` to 0.3.46.
3. `EMPIR3_REQUIRE_SIGNED=1 npm run build:windows` → `npm run release:check` →
   `npm run publish:downloads -- --dry-run` → publish → HQ export (CHANNELS.md step 4)
   → verify manifest 0.3.46.
4. **The vault (DESKTOP-DK98E17, VM 142) auto-updating 0.3.45→0.3.46 is the live test
   of the mutex fix**: the incoming 0.3.46 tray waits out the old tray's slow death.
   After its update window, check its tray.log tail for
   "single-instance mutex acquired after handoff" (or a clean start) and NO
   "another Empir3Tray instance is already running". Headless check path (no QGA on
   the vault): fleet rollout REST as admin —
   `POST /api/fleet/rollouts` selector `{"kind":"devices","deviceIds":["bridge-67bf9355-8365-461a-b1c2-81364ea03026"]}`,
   command `Get-Content "$env:APPDATA/Empir3/tray.log" -Tail 60`, shell `powershell`,
   dry-run first then `confirm:true`.
5. Also worth a 30-second check post-update on the vault: the GitHub "Authenticate"
   button now opens a REAL console that stays open (gh's interactive prompts) — gh
   itself may still be NOT INSTALLED there; install via the control-center button
   first if you want the full flow.

## Explicit non-goals for 0.3.46

- Per-target emulation sessions (documented limitation instead).
- Skills-path attribution (`SkillExecutorContext` has no agentId — app-side plumbing,
  different repo, not needed for the invocable path agents actually use).
- Any change to MCP tool behavior or the welcome/control-center UI.
