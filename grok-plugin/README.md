# Empir3 for Grok Build

This folder is the Grok Build plugin for [Empir3 Bridge](https://github.com/empir3hq/empir3-bridge):
a local-first MCP server that lets the agent in your terminal use your own Chrome,
your Windows desktop apps, and the AI CLIs you are already signed into, with
read-only defaults and a switch per capability.

The plugin is listed in the Grok Build marketplace as **empir3**. Everything the
agent does runs on your computer; nothing here needs an Empir3 account.

## What you need

1. **Node.js 18 or newer** with `npx` on your PATH. The plugin's `.mcp.json`
   starts the MCP server with `npx -y -p @empir3hq/empir3-bridge empir3-bridge-mcp`,
   which works on Windows, macOS and Linux.
2. **Empir3 Bridge running.** Install the signed package for your OS from
   [empir3.com/download](https://empir3.com/download) and start it; the MCP
   server connects to it at `http://127.0.0.1:3006`. On Windows the npm shim
   also starts an installed-but-stopped Bridge for you. Without an installed
   Bridge, the npm package starts a source Bridge itself, which needs Chrome on
   the machine.
3. **The switches for what you want the agent to do**, in the Bridge console at
   `http://localhost:3006/console`: browser interact for clicking and typing,
   Recording for record and replay, Desktop Tools for native apps, and the row
   under API & CLIs for each CLI you want to lend. Reading pages and navigating
   work out of the box. A disabled tool is refused at call time on your PC, no
   matter what the client believes.

Platform truth: browser control, CLI delegation and recording are
cross-platform. Native desktop control is Windows; Linux with X11 has
screenshot, pointer and keyboard only; macOS has no native desktop control and
the `use-my-desktop` skill says so.

## Install

In Grok Build, open `/marketplace` and install **empir3**, or run
`grok plugin install empir3 --trust`. Then ask:

```text
Check the Bridge status, open example.com in a new tab and tell me what is on the page.
```

## Skills

| Skill | What it teaches the agent |
| --- | --- |
| `control-my-browser` | `browser_status` → `browser_tab_open` → `browser_snapshot` → `browser_click_ref` / `browser_type_ref` → verify, and what to do when a control is hidden in a frame |
| `use-my-desktop` | `bridge_control_catalog` first, then `desktop_window` → `desktop_snapshot` → `desktop_click_ref` / `desktop_type` → verify, with the recovery table (Windows) |
| `delegate-to-my-ai-clis` | `cli_status` before `cli_run`; text versus agentic mode; background runs with `cli_run_status` |
| `record-and-replay-a-routine` | `browser_record_start` → `browser_record_stop` → `browser_play` with variables, and why a stopped replay is never rerun whole |

The full tool inventory (93 tools in this release) is in the
[repository README](https://github.com/empir3hq/empir3-bridge#what-you-get) and
the [operating guide](https://github.com/empir3hq/empir3-bridge/blob/main/docs/AGENT_GUIDE.md).

## Safety

`bridge_safety_status` shows what is enabled; `bridge_revoke_control` turns
every write-capable tool off at once; the console's Revoke Write Control button
does the same. Details: [docs/SAFETY.md](https://github.com/empir3hq/empir3-bridge/blob/main/docs/SAFETY.md).

Maintainers: [docs/GROK_BUILD_PLUGIN.md](../docs/GROK_BUILD_PLUGIN.md) explains
how this listing is built and updated.
