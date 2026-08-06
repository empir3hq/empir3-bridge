# Safety Model

Empir3 Bridge can read browser state and, when explicitly enabled, operate pages and the desktop. This document explains the safety boundary.

## Defaults

The first-run default is read-heavy and write-light:

- Read tools: enabled
- Navigation tools: enabled
- Browser click/type tools: disabled
- Desktop mouse tools: disabled
- JavaScript eval: disabled
- Recording and replay tools: disabled

Disabled tools are not sent to the chat model as available tools. The dispatcher also rejects disabled tool calls as a second layer of protection.

## Visible Control State

The dashboard at `http://localhost:3006` shows a `Control Safety` card:

- `Read Only`: no write-capable tools are enabled.
- `Write Enabled`: one or more click, type, desktop, eval, or recording tools are enabled.

The current state is also available through:

```bash
npx tsx src/cli.ts safety-status
```

and through MCP:

```text
bridge_safety_status
```

## Revoke Control

To disable all write-capable tools immediately:

```bash
npx tsx src/cli.ts revoke-control
```

or call the MCP tool:

```text
bridge_revoke_control
```

or press `Revoke Write Control` on the dashboard.

This turns off:

- browser clicks
- browser typing
- browser keypresses
- desktop click, hover, and drag
- JavaScript eval
- recording and replay tools
- overlay chat programmatic read/write tools

Read tools and browser navigation remain enabled.

## Local Network Boundary

By default, the wrapper and CDP bridge bind to `127.0.0.1`.

Chrome is launched with:

```text
--remote-debugging-address=127.0.0.1
```

The bridge is intended for local tools on your own machine. Do not expose it to the LAN or internet.

## Data Boundary

The bridge uses a dedicated Chrome profile:

```text
~/.empir3-bridge/profile/
```

It does not use your normal Chrome profile. Site logins inside the bridge profile are separate from your daily browser.

Local data paths:

- `~/.empir3-bridge/config.json`: settings
- `~/.empir3-bridge/conversations/`: chat transcripts
- `./feedback/`: screenshots and action feedback
- `./recordings/`: saved replay flows

These paths can contain sensitive page state if you use the bridge on private sites. Treat them accordingly.

## Bridge Model Providers

Supported cloud-provider keys are stored only in the local Bridge chat config;
custom OpenAI-compatible addresses and keys are stored only in the local Bridge
settings file. Every provider is private to local MCP clients until the user
explicitly enables **Available to my Empir3 agents**.

When shared, the Bridge advertises only the provider's display name, model IDs,
capabilities, and current availability. Empir3 sends model messages and tool
schemas through the authenticated relay, but it never receives the endpoint URL
or key. The Bridge translates calls locally into native Anthropic/Gemini or
OpenAI-compatible requests. Requests stay pinned to the selected device and make one upstream model
attempt; failures are returned rather than retried through another account or
silently replaced with a platform model.

## When To Enable Desktop Tools

Enable desktop tools only when you want an agent to operate the host desktop, not just Chrome.

Useful cases:

- desktop app smoke tests
- multi-monitor screenshots
- browser UI that cannot be reached through the DOM
- canvas or game interactions
- drag/drop testing

Use `http://localhost:3006/desktop-test` before trying desktop click/drag on real windows.

## Linux / Headless Servers

On Linux the bridge runs headless-first: shell, files, browser, and CLI
lending work; desktop-control tools return a structured
`capability_unsupported` instead of failing.

Be clear-eyed about what the guards are:

- The shell blocklist and the file-read path blocklist are **speed bumps**,
  not a security boundary. They stop the obvious catastrophic one-liners
  (`rm -rf /`, `dd of=/dev/…`, reading `/etc/shadow`), but a blocklist can
  always be talked around — and a lent Claude/Codex CLI can run arbitrary
  commands *by design*.
- The real boundary is the **service user plus systemd hardening**: run the
  bridge as a dedicated non-root user, and keep `NoNewPrivileges`,
  `ProtectSystem=full`, `ProtectKernelTunables`, `PrivateTmp` and friends in
  the unit file. `ProtectSystem=full` makes the kernel enforce what the path
  blocklist only suggests.
- For tighter setups, `EMPIR3_ALLOWED_ROOTS` switches file reads to an
  allowlist: only paths under the listed roots are readable (the blocklist
  still applies inside them).

By default file reads keep `/var/log`, `/srv`, `/opt`, `/home`, and
`/usr/local` accessible — a fleet agent legitimately reads logs and app
directories, and over-blocking pushes people to disable the guard entirely.

## Reporting Security Issues

Do not open a public issue for security bugs. See [../SECURITY.md](../SECURITY.md).
