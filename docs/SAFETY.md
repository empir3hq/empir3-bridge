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

MCP clients (Claude Code, Codex, Cursor, and others) receive the full tool inventory when they connect, and that inventory is fixed for the session. A tool you disable therefore stays listed in the client, and is refused the moment the agent calls it with `MCP tool disabled locally: <tool>`. Enforcement is at call time, on this PC, regardless of what the client believes it can do. Only handler families (Higgsfield) and provider-gated tools (`custom_llm`, `custom_capability`) are omitted from `tools/list` when nothing is configured for them.

## Local and Private Origins

By default the browser tools refuse to navigate to loopback, private-network, link-local, and `file:` URLs, so an agent cannot use the Bridge browser as a pivot into your LAN or filesystem. Local development needs exactly that, so the Permissions page has a `Local & private origins` list: approve an exact origin (`http://localhost:3000`, `http://192.168.1.20:8080`) or a file prefix (`file:///home/me/project/`) and navigation to it is allowed until you remove it. The list is stored in `bridge-settings.json` (`navigationAllowlist`), is shown by `bridge_safety_status`, and can only be edited from the local dashboard; no agent or MCP call can add to it. Everything not listed stays blocked, and the refusal names the origin and where to approve it.

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

## CLI turn cancellation

Relay CLI turns register an original execution scope before waiting for capacity
or preparing their tool connection. Stop cancels that scope for Claude, Codex,
Gemini, Grok and Agy. Process creation checks the scope immediately before spawn,
including PTY creation and attachment retries. Cancelled preparation cannot start
a process later, and cancellation does not expire after a fixed timeout. Captured
callbacks cannot adopt a later turn that happens to reuse the same wire ID.

The relay accepts Stop after the local Execute permission is revoked; new turns
and tool results remain refused. Device targeting still applies. Original scopes
also recheck the Bridge owner's Execute setting, provider opt-in, restart hold
and enrollment identity before spawning or serving a tool callback.

Production CLI admission now writes `cli-turns.sqlite` in the Bridge settings
directory using Node 24's bundled SQLite and independent FULL-WAL transactions.
The journal stores request hashes and immutable execution identities, not prompts,
credentials, tool arguments or results. Preparation is committed before capacity
waits; issued is committed before process creation. Duplicate wire identities
cannot restart after reconnect or daemon restart. A preparation fence races
atomically against issue; elapsed time never proves an issued call has stopped.

An issued call remains `uncertain` when only a normal process result arrives.
The recorded outcome is evidence, not an acknowledgment that all remote effects
have ended. Completion-write failure produces an error instead of success. Schema
loss, changed journal identity and capacity exhaustion refuse new execution. The
100,000-record bound never evicts uncertain history to make room. An independent
identity marker refuses recreation after journal-file loss; losing the entire
settings directory is not covered by that marker. Retention acknowledgments,
operator visibility and complete migration-gate consumption remain required
before launch; the journal alone grants no clearance.

Windows admitted relay turns now run through `empir3-cli-job.exe`, including
ordinary and ConPTY launches. The native helper assigns the provider to a
non-breakaway Windows Job Object at process creation, before its first thread
runs. Cancellation writes an original-nonce marker; normal root completion also
terminates remaining job members. Only a kernel query reporting zero active job
processes permits a stop receipt. A helper crash closes the job but supplies no
receipt. Missing binaries and invalid evidence never fall back to uncontained
execution or a PID-based kill. Closing a turn cancels every attachment attempt.

Private launch arguments are removed before the provider starts. Immutable
bindings and stop receipts stay under the settings directory's `cli-jobs` folder
for recovery. Each attempt is registered and issued in independent FULL-WAL
transactions before its helper can start. Stop seals this inventory before
cancellation, so no later attachment can start. Recovery reopens only the
original nonce-bound files and persists every kernel stop receipt. Only a sealed,
complete inventory can return `stopped`; legacy records without an inventory
remain uncertain. Ordinary helpers survive a Bridge process exit. If a crash
leaves an issued but unconsumed launch file, recovery invokes the native helper's
cancellation-only mode. It must validate the original cancellation marker and
exclusively consume that file; it has no provider-process creation path. A late
original helper loses its required consume-before-run step. Missing launch files
never prove non-execution. Recovery helpers are bounded to 32 concurrent children
and a ten-second lifetime. ConPTY/helper crashes without receipts and already
consumed or removed launch files without receipts stay held.
Tool-effect reconciliation, equivalent non-Windows containment and signed
packaged-provider acceptance remain launch requirements. This is a lifecycle
boundary for trusted provider executables, not a sandbox against arbitrary
programs running as the same OS user.

The ConPTY integration pins node-pty 1.1.0. After the terminal exit event it
disposes only the original terminal's captured input socket and output worker.
It does not invoke node-pty's console PID enumeration. Real Windows tests must
continue to prove both descendant termination and clean test-process exit when
upgrading that dependency.

The authenticated relay exposes `<provider>:cli:execution:inspect`,
`<provider>:cli:execution:fence` and `<provider>:cli:execution:stop` for the five
journaled turn providers. Queries
must match the current enrollment, provider, original execution ID and request
hash. They return only phase/identity evidence, never prompts or results. These
actions remain available after Execute revocation because they cannot start work.
The fence atomically changes only preparing work to not-started; retries recover
the same nonce/generation after a lost reply or restart. Stop seals and cancels
the original attempt inventory. Missing or changed evidence is an error, not proof that
execution never happened. The app uses an exact-device query client and a durable
dispatch journal. Automatic reconciliation can release a hold for a matching
not-started result or a complete native stop receipt when no tool callback has
begun. The evidence and exact account-activity release commit atomically. Any
started tool callback keeps its hold, even after returning; a successful provider
result alone is insufficient.

Behavioral tests execute the actual capacity wrapper, five runner routes, spawn
boundary, abort handlers and relay permission handler with simulated processes,
filesystems and transport. They cover cancellation during capacity/setup waits,
retry suppression, duplicate preparation, late callbacks and normal completion.
Native SQLite tests add separate connections, fault-trigger rollback, original
binding checks, schema loss, bounded storage and abrupt child-process exits.
All five actual runner functions also use native SQLite in tests with simulated
children: a separate connection sees the issued commit at spawn, and reopening
the journal refuses replay after completion.

## Per-turn CLI tool server

The temporary loopback MCP server uses a random private URL path for each turn.
Browser Origin/Fetch Metadata, an unexpected Host and public/incorrect paths are
rejected before tool dispatch. The original admitted scope must have crossed the
issued boundary, remain uncancelled and retain the owner's current permission.
The same check runs again before returning a private tool result, including all
earlier results buffered while a later batch call waits. A request body completed
after cancellation cannot read the toolkit or dispatch work.

Request bodies are bounded to 4 MiB, batches to 32 requests, pending tool calls
and concurrent connections to 64 each. Header/body receipt has finite deadlines;
long authorized tool responses keep their existing response lifetime. Actual
loopback HTTP tests cover valid native calls, browser/Host/path refusals, delayed
results and buffered batches after Stop, delayed bodies, reused identities and
capacity limits. This does not certify
every other localhost endpoint or final packaged-provider behavior.

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
- trusted local chat programmatic read/write tools

Read tools and browser navigation remain enabled.

## Local Network Boundary

By default, the wrapper and CDP bridge bind to `127.0.0.1`.

Chrome is launched with:

```text
--remote-debugging-address=127.0.0.1
```

The bridge is intended for local tools on your own machine. Do not expose it to the LAN or internet.

## Browser Page Boundary

Websites loaded in the dedicated Chrome profile are untrusted. Bridge 0.3.72
retired the former page-injected chat/control overlay. Chat and agent replies
now live only on the localhost dashboard at `http://localhost:3006/`.

The internal CDP HTTP service accepts native clients only. Browser Origin or
Fetch Metadata headers are rejected before commands and setup proxies run;
the Host header must name the configured local service. It does not provide
cross-origin access. Old `/welcome` links redirect to the maintained console.

Browser WebSockets fail closed by role:

- native CLI clients are accepted only without a browser `Origin` header;
- the control role is accepted only from the exact localhost dashboard origin;
- the former overlay role is rejected;
- no Bridge nonce, queue, or agent reply is injected into webpage JavaScript.

The `bridge_overlay_reinject` compatibility command now removes any legacy
overlay left in an already-open tab and returns the trusted dashboard URL.

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

## Goal-Based Actions (browser_act)

`browser_act` lets an agent say what it wants ("open the account menu", "the
email field" plus text) instead of reading a snapshot and choosing a ref. A
decision engine picks one visible control; the Bridge then
clicks it or types into it.

- **Off by default.** It has its own Permissions-page switch, and each click or
  keystroke it sends is gated again as `browser_click_ref`,
  `browser_type_ref` or `browser_press`. Turning on `browser_act` alone does
  not let it click anything those switches forbid.
- **Engine selection.** API & CLIs → Decisions shows the active source. Its
  main checkbox is the existing default-off `browser_act` permission and
  refuses every source locally when off. A local engine is tested before
  saving; its own checkbox falls back to Empir3 when unchecked and paired.
  An explicit daemon `EMPIR3_DECISION_URL` (and
  `EMPIR3_DECISION_API_KEY` if needed) or an enabled `decisionModel.url` wins.
  Environment overrides are visible and can be unchecked; CLI/MCP requests
  use this daemon-owned source. Otherwise,
  paired Bridges ask Empir3 over their existing connection: the owner's Tool
  Route chooses the engine and backups, and Empir3 records usage and billing.
  No platform engine key is stored on the device. Unpaired Bridges can use any
  System One endpoint, including a self-hosted model, without an Empir3 account.
  Pairing or a local endpoint is required. The relay shares browser_act's
  default-off Execute gate, including direct HTTP and CLI calls; it never
  queues or retries after a refusal, timeout or disconnect.
- **What leaves the machine.** The goal and the visible controls' roles and
  labels go to the selected engine, through Empir3 when paired. Typed text never does.
- **What it never does on its own.** It will not click a control whose label
  reads as irreversible (submit, pay, buy, send, post, publish, delete, remove,
  confirm, sign out and similar); it returns that control as a suggestion and
  the agent must click it deliberately with `browser_click_ref`. It also stops
  and returns candidates when the model answers "none" or is below the
  confidence floor (`EMPIR3_DECISION_MIN_CONFIDENCE`, default 0.6).
- **Limits.** It sees only visible main-document controls, picks one control per
  call, and can still choose the wrong field when labels are ambiguous.
  Confirm the result before relying on it.

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
