Empir3 Bridge 0.3.94 is the unified desktop and headless release for Windows, macOS, and Linux.

Highlights:

- Isolates Claude, Codex, Gemini, Antigravity, and Grok turns from personal MCP servers, project instructions, hooks, skills, plugins, history, and persistent CLI sessions while preserving each provider's authorized subscription login.
- Prevents Grok Verify and routed Grok turns from importing Claude/Cursor MCP catalogs or launching unrelated helpers such as Higgsfield.
- Restores Claude's explicit per-turn Empir3 MCP attachment without re-enabling personal configuration.
- Keeps direct CLI runs, text turns, vision turns, model-catalog refreshes, and relay turns on the same provider-specific isolation boundary.
- Includes cross-platform packaging corrections for Windows payload retention and Linux desktop smoke-test temporary directories.

All native packages completed the Windows, macOS, Linux x64, Linux ARM64, Node 18/20, installer, update, rollback, signing/notarization, MCP, and live Bridge acceptance gates.

Download the signed installer for your platform at https://empir3.com/download.

Full changes: https://github.com/empir3hq/empir3-bridge/blob/v0.3.94/CHANGELOG.md
