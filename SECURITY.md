# Security Policy

Empir3 Bridge runs locally and can control a real Chrome instance. When you enable desktop tools, it can also move and click the host mouse. That is powerful, so the security boundary is explicit.

The default mode is local-only MCP/CLI use. Empir3 relay is opt-in: it starts only after you pair this PC with an Empir3 account.

## What The Bridge Accesses

- A dedicated Chrome profile at `~/.empir3-bridge/profile/`.
- A local CDP bridge, default `127.0.0.1:9867`.
- A local HTTP/WebSocket wrapper, default `127.0.0.1:3006`.
- Chat config (mode, API key, per-tool toggles) at `~/.empir3-bridge/config.json`.
- Bridge auth token after Empir3 pairing at `%APPDATA%\Empir3\bridge-auth.json` on Windows, `~/.empir3/Empir3/bridge-auth.json` on macOS/Linux.
- Bridge settings (permissions, device name, handlers, custom providers) at `%APPDATA%\Empir3\bridge-settings.json` on Windows, `~/.empir3/Empir3/bridge-settings.json` on macOS/Linux.
- Per-launch bridge nonce at `~/.empir3-bridge/nonce`.
- Local conversations under `~/.empir3-bridge/conversations/`.
- Generated artifacts under `~/.empir3-bridge/artifacts/`.
- Local screenshots and feedback under `./feedback/`.
- Local recordings under `./recordings/`.
- Optional GitHub Releases check to see whether a newer bridge version exists.

If desktop tools are enabled, the bridge can read monitor bounds, capture desktop screenshots, and move/click/drag the mouse in physical screen coordinates.

## What The Bridge Does Not Access By Default

- Your normal Chrome profile.
- Your files outside the bridge data paths.
- Your LAN or the public internet as a server.
- Empir3 cloud services unless you explicitly pair this PC.

The wrapper and CDP bridge bind to `127.0.0.1` by default. Chrome is launched with `--remote-debugging-address=127.0.0.1`.

## Empir3 Pairing And Remote Relay

Pairing is optional. When you pair with Empir3, the bridge stores a local auth token, reports the device to Empir3, and opens an outbound websocket to the Empir3 relay. The relay can deliver browser, desktop, file, CLI, and companion commands to the bridge, but local device permissions remain the final enforcement layer.

Important boundaries:

- No Empir3 account is required for local MCP use.
- Signing out deletes the local bridge auth token.
- Remote relay does not expose `:3006` or `:9867` to the public internet.
- Remote commands still pass through local read/write/execute permissions, per-tool toggles, handler-family gates, and hard blocks for known-dangerous commands.
- The tray and welcome console show paired/relay status, current permissions, and revoke/sign-out actions.

## Localhost Browser Boundary

The bridge serves a welcome console and overlay from localhost. To reduce cross-origin localhost abuse, mutating browser-origin HTTP requests and non-local overlay websocket connections require the per-launch bridge nonce. The nonce is generated on launch and is only injected into trusted bridge-controlled pages.

## Tool Safety

Write-capable tools are disabled by default:

- browser click/type/key tools
- desktop click/hover/drag tools
- JavaScript eval
- recording and replay tools

Remote Empir3 relay commands are subject to the same local tool gates. Turning a category off blocks it for local MCP, the welcome console, and paired Empir3 relay.

You can inspect the current state:

```bash
npx tsx src/cli.ts safety-status
```

You can revoke write control:

```bash
npx tsx src/cli.ts revoke-control
```

More detail: [docs/SAFETY.md](docs/SAFETY.md).

## Sensitive Local Data

Screenshots, recordings, and conversation logs may contain private page data. Do not attach them to public issues without reviewing them first.

If you use API mode in chat settings, your Anthropic API key is stored locally in:

```text
~/.empir3-bridge/config.json
```

Any custom OpenAI-compatible provider keys you add (Ollama, OpenRouter, vLLM, etc.) are stored locally in:

```text
%APPDATA%\Empir3\bridge-settings.json    (Windows)
~/.empir3/Empir3/bridge-settings.json    (macOS/Linux)
```

The bridge does not upload these keys to Empir3.

If you pair with Empir3, the bridge auth token is stored locally in:

```text
%APPDATA%\Empir3\bridge-auth.json    (Windows)
~/.empir3/Empir3/bridge-auth.json    (macOS/Linux)
```

Treat this file like a login credential for this device. Use tray **Sign out** or the welcome console account controls to remove it.

## Reporting A Vulnerability

Email **security@empir3.com** with:

- description of the issue
- reproduction steps
- affected OS and version
- proof of concept, if available

If the repository is public on GitHub, you may also open a private security advisory:

```text
https://github.com/empir3hq/bridge/security/advisories/new
```

Please do not file public GitHub issues for security problems.

## Response

We aim to acknowledge security reports within 72 hours and coordinate disclosure with the reporter.

## Supported Versions

Only the latest minor version receives security fixes.

| Version | Supported |
| --- | --- |
| 0.3.x | Yes |
| < 0.3 | No |
