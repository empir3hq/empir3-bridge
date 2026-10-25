# Bridge MCP Idle Timeout Evidence — 2026-08-11

Scope: repair the production `dispatch_specialist` abort introduced by Claude
Code 2.1.214's distinct MCP tool idle watchdog, publish one signed Bridge
payload, and update the Vault Bridge without interrupting active work.

## Root Cause And Repair

- Production failed at exactly 300 seconds with `MCP server "empir3" tool
  "dispatch_specialist" sent no response or progress for 300s`.
- The Bridge already set `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT` to its finite
  20-minute tool ceiling. Claude Code 2.1.214 added a separate
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`; the installed CLI binary exposed the
  variable and its 300-second default in the exact error path.
- Claude tool turns now set all three variables to the same finite
  `MCP_TOOL_CALL_TIMEOUT_MS` value. The idle watchdog is not disabled; the
  Bridge's existing total/tool ceilings remain authoritative.

## Verification

- Focused timeout contract: 1 pass, 0 fail.
- TypeScript and MCP bundle builds: pass.
- Full Bridge suite: 281 tests, 277 pass, 4 platform skips, 0 fail.
- Release preflight and npm package dry run: pass for 0.3.75.
- Windows signing preflight: pass with Azure Trusted Signing authenticated.
- Signed legacy build: payload, Node runtime, manifest, and Authenticode
  installer signatures/hashes self-verified.
- Native release workflow `31489114249`: 15/15 jobs passed for exact commit
  `ef0c1411cc647721860cc235b344ac3c3b67e258`.
- Atomic publisher uploaded artifacts first, verified every public hash,
  swapped the signed manifest, passed the public manifest gate, and exposed
  `Empir3Setup.exe` last.

## Live Vault Receipt

- Vault device `DESKTOP-DK98E17` updated through the active tray consumer from
  0.3.74 to 0.3.75.
- Fresh status: Bridge 0.3.75, relay connected, authentication accepted,
  browser ready, ports 3006/9867/9222 listening.
- The update cleaned up the two dormant predecessor Claude workers. The only
  remaining Bridge Node process consumed 0.047 CPU-seconds over a five-second
  idle sample.
- A synthetic production acceptance completed two sequential 52-second inner
  Bash calls without a Bridge abort, then the specialist exited on the separate
  already-tracked project-workspace postcondition before crossing 300 seconds.
  That workspace concern remains open; it is not folded into this timeout fix.

## Production Board

- Canonical 300-second timeout card resolved with the signed-release receipt.
- The Google Drive report was split: its duplicate Bridge-timeout half points
  to this fix; the remaining claude.ai connector permission UI is triaged as an
  external host-owned approval-flow issue.
