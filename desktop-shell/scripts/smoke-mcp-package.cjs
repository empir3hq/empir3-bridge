'use strict';

const { existsSync, readdirSync, statSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const shellRoot = resolve(__dirname, '..');
const outRoot = join(shellRoot, 'out');

function walk(root, matches = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'make' || name === 'test-cleanup' || name === 'stale-artifacts') continue;
      walk(full, matches);
    } else if (stat.isFile() && (
      (process.platform === 'win32' && name.toLowerCase() === 'empir3-bridge.exe')
      || (process.platform !== 'win32' && name === 'empir3-bridge')
    )) {
      matches.push(full);
    }
  }
  return matches;
}

async function main() {
  const override = String(process.env.EMPIR3_DESKTOP_SMOKE_EXECUTABLE || '').trim();
  const candidates = override ? [resolve(override)] : walk(outRoot);
  if (candidates.length !== 1 || !existsSync(candidates[0])) {
    throw new Error(`Expected one packaged Bridge executable, found ${candidates.length}`);
  }
  const bridgeUrl = String(process.env.EMPIR3_DESKTOP_MCP_BRIDGE_URL || 'http://127.0.0.1:3006');
  const executableArgs = ['--mcp'];
  // GitHub's Linux runners cannot use Electron's production Chromium sandbox.
  // Keep the product sandbox enabled everywhere else, including real installs.
  if (process.platform === 'linux' && process.env.CI === 'true') executableArgs.push('--no-sandbox');
  const transport = new StdioClientTransport({
    command: candidates[0],
    args: executableArgs,
    env: { ...process.env, BRIDGE_URL: bridgeUrl },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: 'empir3-desktop-package-smoke', version: '1.0.0' });
  try {
    let timeout;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Packaged MCP connect timed out. ${stderr.trim()}`)), 75_000);
          timeout.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const required of ['browser_status', 'browser_navigate', 'browser_snapshot', 'desktop_screenshot']) {
      if (!names.includes(required)) throw new Error(`Packaged MCP is missing ${required}`);
    }
    const status = await client.callTool({ name: 'browser_status', arguments: {} });
    if (status?.isError) throw new Error(`Packaged MCP browser_status failed: ${JSON.stringify(status)}`);
    console.log(JSON.stringify({
      ok: true,
      executable: basename(candidates[0]),
      bridgeUrl,
      tools: names.length,
      statusRoundTrip: true,
    }));
  } catch (error) {
    const detail = stderr.trim();
    if (detail && error instanceof Error) error.message = `${error.message}\nPackaged MCP stderr:\n${detail}`;
    throw error;
  } finally {
    await client.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  },
);
