# Running multiple bridges (one agent per browser)

A single bridge is a singleton: it tracks **one** active tab (`currentTargetId`)
shared by every client, so two agents pointed at the same bridge fight over one
tab. To run agents in parallel, give each its **own bridge instance** — its own
wrapper port, CDP-bridge port, Chrome remote-debug port, and Chrome profile. Each
instance is a separate Chrome with separate cookies/logins/tabs and its own
active-tab pointer, so there is zero cross-talk.

## For an agent: the `bridge_scale` MCP tool (preferred)

An MCP-driving agent scales without leaving the session — the daemon spawns the
extra instances itself (from the installed payload in a real install, so this
works for shipped installs, not just dev checkouts):

```
bridge_scale { action: "up", count: 3 }      # ensure 3 total instances; returns each extra's BRIDGE_URL
bridge_scale { action: "status" }            # list every instance
bridge_scale { action: "down", count: 3 }    # stop extras 2..3 (never touches instance 1)
```

`up`/`down` need the bridge's **Execute** permission (they spawn/stop
processes); `status` is read-only. Capped at 4 total (each instance is a full
Chrome).

The `browser_*` MCP tools always drive **instance 1**. To act on an extra
instance, either drive it from the CLI with `BRIDGE_URL`, or give a *second*
agent its own `browser_*` tools via a second MCP registration (below).

```bash
# drive instance 2 (its own Chrome) from the CLI in the same session
BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts navigate "https://example.com"
BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts snapshot
BRIDGE_URL=http://localhost:3106 npx tsx src/cli.ts click-ref e5
```

### Dev/repo fallback: `scripts/scale.js`

When working in the repo (or to manage instances outside an agent session), the
same thing is available as a script — this is what `bridge_scale` uses under the
hood on a dev checkout:

```bash
node scripts/scale.js up 3       # ensure instances 2 and 3 (instance 1 untouched)
node scripts/scale.js status 4
node scripts/scale.js down all
```

## Port scheme (+100 stride)

| # | wrapper | cdp-bridge | chrome-cdp | profile | notes |
|---|---------|-----------|-----------|---------|-------|
| 1 | 3006 | 9867 | 9222 | `~/.empir3-bridge/profile`   | primary — auto-launched by MCP; scale.js never touches it |
| 2 | 3106 | 9967 | 9322 | `~/.empir3-bridge/profile-2` | |
| 3 | 3206 | 10067 | 9422 | `~/.empir3-bridge/profile-3` | |
| 4 | 3306 | 10167 | 9522 | `~/.empir3-bridge/profile-4` | |

## Second-agent MCP registration

To give a *second Claude/agent* its own `browser_*` tools against instance 2, add
to that agent's `.mcp.json` (start the instance with `scale.js` first — an extra
MCP server only connects to `BRIDGE_URL`, it does not auto-launch extras in a
prod install):

```json
{
  "mcpServers": {
    "empir3-bridge-2": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/path/to/empir3-bridge/src/mcp-server.ts"],
      "env": { "BRIDGE_URL": "http://localhost:3106" }
    }
  }
}
```

## What's isolated vs shared

**Isolated per instance** (this is what makes parallel agents safe): ports, Chrome
process + profile (cookies/logins/tabs), and the active-tab pointer. `scale.js` and
`launch.js` only reap their own ports and their own Chrome (matched by CDP port +
a per-launch nonce).

**Shared across all instances**: `~/.empir3-bridge/config.json` (chat config) and
`%APPDATA%\Empir3\bridge-settings.json` (lend toggles + a single Empir3 `deviceId`).
Sharing lend/CLI-auth is convenient. The single `deviceId` means the Empir3 relay
treats all instances as one device — irrelevant for local browser driving, but
don't expect each instance to appear as a distinct device inside Empir3.
