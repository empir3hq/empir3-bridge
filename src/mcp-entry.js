#!/usr/bin/env node
/**
 * empir3-bridge-mcp — stdio MCP server entry for the published npm package.
 *
 * MCP clients (Claude Code, Codex, Cursor, …) launch this with:
 *   npx -y -p @empir3/empir3-bridge empir3-bridge-mcp
 *
 * It runs src/mcp-server.ts through the bundled `tsx` with stdio inherited, so
 * the MCP client speaks JSON-RPC straight to the server over stdin/stdout. The
 * MCP server auto-launches the bridge (HTTP wrapper + CDP) on first tool use,
 * so no separate daemon step is required.
 *
 * The companion `empir3-bridge` bin starts the daemon directly (src/launch.js);
 * this one is the thin MCP shim.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let tsxCli;
try {
  // Resolves tsx from the package's own node_modules regardless of cwd, the
  // same mechanism src/launch.js relies on. tsx is a runtime dependency.
  tsxCli = require.resolve('tsx/cli');
} catch (err) {
  process.stderr.write(
    '[empir3-bridge-mcp] could not resolve tsx — reinstall the package: npm i -g @empir3/empir3-bridge\n'
  );
  process.exit(1);
}

const mcpServer = path.join(__dirname, 'mcp-server.ts');

const child = spawn(process.execPath, [tsxCli, mcpServer, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('error', (err) => {
  process.stderr.write(`[empir3-bridge-mcp] failed to start MCP server: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
  } else {
    process.exit(code == null ? 0 : code);
  }
});

// Forward termination so the MCP client closing the pipe tears down the server.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}
