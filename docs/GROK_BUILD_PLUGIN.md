# Empir3 Bridge as a Grok Build plugin

Grok Build is xAI's terminal agent. Its marketplace is an open GitHub catalog
(`xai-org/plugin-marketplace`): one JSON entry per plugin pointing at a public
repository pinned to a commit. A plugin is a directory with any of `skills/`,
`commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json` and an
optional `.grok-plugin/plugin.json`. Grok Build runs locally, so a stdio MCP
server is enough.

The Empir3 plugin lives in [`grok-plugin/`](../grok-plugin/) in this
repository and is listed as **empir3**. The catalog entry points at the public
repository with `source.path = "grok-plugin"`, the same layout other listed
vendors use for a plugin that ships inside a larger repository.

## What is in the plugin

| Path | Purpose |
| --- | --- |
| `grok-plugin/.mcp.json` | Starts the Bridge MCP server with `npx -y -p @empir3hq/empir3-bridge empir3-bridge-mcp` |
| `grok-plugin/.grok-plugin/plugin.json` | Display metadata: name `empir3`, author Empir3 HQ, homepage, version (kept equal to `package.json`) |
| `grok-plugin/skills/*/SKILL.md` | Four procedural skills, each naming real tools from `src/mcp-server.ts` |
| `grok-plugin/README.md` | What the user needs, how to install, platform truth |
| `grok-plugin/assets/logo.svg` | The Bridge icon |

`test/grok-plugin-contract.test.mjs` keeps this honest: the JSON parses, every
backticked tool name in the skills exists in the MCP server, the manifest
version equals the package version, and the plugin copy never uses the names
or claims the marketplace reviewers reject.

### Why `npx` and not the installed executable

The repository root `.mcp.json` is the maintainer's working configuration and
runs the installed Windows bootstrap (`Empir3Setup.exe --mcp`); the public
exporter drops it. A plugin must start on Windows, macOS and Linux from one
file, and only the npm path does that: `empir3-bridge-mcp` (see
`src/mcp-entry.js`) runs `src/mcp-server.ts` through the bundled `tsx`. On
connect the server checks `http://127.0.0.1:3006`; if an installed Bridge is
running it simply uses it, if the Windows bootstrap is installed but stopped it
starts it with `--daemon`, and otherwise it starts a source Bridge from the npm
package. Installed desktop Bridges on macOS and Linux should be running before
the agent connects; the console's **MCP Connection → Show config** prints the
exact installed-executable form for people who prefer it.

The npm package is therefore part of this listing. Before the catalog PR is
opened or its SHA bumped, `npm view @empir3hq/empir3-bridge version` must
report the release the SHA points at, or the release receipt must say why the
older published package is still compatible with that commit's tools.

## Install (user view)

1. Install and start Empir3 Bridge from <https://empir3.com/download>
   (signed Windows, macOS, Linux desktop and Linux headless packages).
2. In the Bridge console at `http://localhost:3006/console`, enable what the
   agent may do: browser interact for clicking and typing, Recording,
   Desktop Tools, and each CLI row under API & CLIs. Read and navigate are on
   by default.
3. In Grok Build, open `/marketplace` and install **empir3**, or run
   `grok plugin install empir3 --trust`. (Both forms are the ones xAI documents in
   the marketplace launch note, https://x.ai/news/grok-plugin-marketplace: `/marketplace`
   then `i` to install, or `grok plugin marketplace list` / `grok plugin install <name> --trust`.)
4. Ask for something concrete: "Check the Bridge status, open example.com in
   a new tab and tell me what is on the page."

Node.js 18+ with `npx` is required on the machine running Grok Build.

## What the skills do

- **control-my-browser** — `browser_status` and `bridge_safety_status`
  first, then `browser_tab_state` / `browser_tab_open` → `browser_snapshot` →
  one action (`browser_click_ref`, `browser_type_ref`, `browser_press`) →
  verify with a fresh snapshot, `browser_text` or `browser_screenshot`. Covers
  frames and shadow roots (`browser_click_xy` + `browser_type`), dialogs
  (`browser_dialog`), the private-origin refusal and clean tab handling.
- **use-my-desktop** — `bridge_control_catalog` to read device support, the
  Windows loop `desktop_window` → `desktop_snapshot` → `desktop_click_ref` /
  `desktop_type` / `desktop_key` → verify, screenshots with
  `desktop_monitors` / `desktop_screenshot`, the user-selected focus region
  (`desktop_select_region`, `desktop_release_focus`) and the recovery table.
- **delegate-to-my-ai-clis** — `cli_status` before `cli_run`; the four lent
  CLIs (`codex`, `grok`, `claude`, `agy`); text versus agentic mode; background
  runs with `cli_run_status` and `cli_runs`; honest reporting of failed runs.
- **record-and-replay-a-routine** — `browser_record_start` →
  `browser_record_stop` → `browser_recordings` → `browser_play` with
  `variables`; why a failed start is not a recording and a stopped replay is
  never rerun whole.

Every skill tells the agent that a refused tool is the correct result and
names the console switch the user controls.

## How the listing is updated

The catalog pins a full 40-character commit SHA of the public repository
`empir3hq/empir3-bridge`. Grok Build re-verifies that SHA after cloning, so a
new plugin version is always a new catalog PR that bumps the `sha`.

1. Ship the Bridge release through the private release contract in
   `docs/internal/RELEASE_OPERATIONS.md` (staging merge, version bump, shared
   checks, signed artifacts, public source export with
   `scripts/export-public.mjs`, HQ-only push and tag, GitHub Release, npm).
   `grok-plugin/.grok-plugin/plugin.json` carries the package version and the
   contract test fails if it drifts, so bump it with the other package files.
2. Read the released commit on the public repository:
   `git ls-remote https://github.com/empir3hq/empir3-bridge.git refs/tags/v<version>`
   (the tag's commit is the SHA to pin; never a staging SHA).
3. In a fork of `xai-org/plugin-marketplace`, edit the `empir3` entry in
   `.grok-plugin/marketplace.json`, set `source.sha`, then run
   `python3 scripts/generate-plugin-index.py` and
   `python3 scripts/validate-catalog.py`.
4. Open the PR from the Empir3 HQ GitHub identity. The exact entry, PR text and
   checklist are in `docs/internal/GROK_BUILD_MARKETPLACE_PR.md` (private).

Documentation-only changes to the skills still need a new pinned SHA to reach
Grok Build users, because the catalog does not follow a branch.
