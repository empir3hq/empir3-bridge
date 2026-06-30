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

## When To Enable Desktop Tools

Enable desktop tools only when you want an agent to operate the host desktop, not just Chrome.

Useful cases:

- desktop app smoke tests
- multi-monitor screenshots
- browser UI that cannot be reached through the DOM
- canvas or game interactions
- drag/drop testing

Use `http://localhost:3006/desktop-test` before trying desktop click/drag on real windows.

## Reporting Security Issues

Do not open a public issue for security bugs. See [../SECURITY.md](../SECURITY.md).
