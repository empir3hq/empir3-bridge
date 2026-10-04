#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const model = process.argv[2] || 'gemini-3.7-flash-high';
const toolCalls = [];

function agyCommand() {
  if (process.env.EMPIR3_AGY_COMMAND) return process.env.EMPIR3_AGY_COMMAND;
  if (process.platform !== 'win32') return 'agy';
  const bundled = join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  if (existsSync(bundled)) return bundled;
  throw new Error('Antigravity Windows executable not found; set EMPIR3_AGY_COMMAND to its full path.');
}

function rpcResponse(request) {
  const id = request?.id ?? null;
  if (request?.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'empir3-smoke', version: '1.0.0' },
        instructions: 'Empir3 provides the authorized tools for this turn. For requests that create, inspect, modify, test, browse, or deploy project work, call the appropriate Empir3 tool before answering. Do not claim work was completed without a successful tool result. A prose-only response does not satisfy a project-work request.',
      },
    };
  }
  if (request?.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'Write',
          description: 'Write exact content to a project workspace file. Use this for requested file creation.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        }],
      },
    };
  }
  if (request?.method === 'tools/call') {
    toolCalls.push({ name: request?.params?.name, args: request?.params?.arguments });
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'Saved .empir3-agy-mcp-smoke.txt successfully.' }] },
    };
  }
  return id === null ? null : { jsonrpc: '2.0', id, result: {} };
}

async function copyAuthReceipt(tempHome, relativeParts) {
  const source = join(homedir(), ...relativeParts);
  const destination = join(tempHome, ...relativeParts);
  try {
    if (!(await stat(source)).isFile()) return;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const input = JSON.parse(body);
      const output = Array.isArray(input)
        ? input.map(rpcResponse).filter(Boolean)
        : rpcResponse(input);
      if (!output || (Array.isArray(output) && output.length === 0)) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(output));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }));
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const cwd = await mkdtemp(join(tmpdir(), 'empir3-agy-mcp-smoke-'));
const agyDir = join(cwd, '.gemini', 'config');
const promptFile = join(cwd, 'empir3-prompt.txt');
const prompt = [
  'CRITICAL EMPIR3 TOOL CONTRACT:',
  'Empir3 MCP tools are attached to this turn. For any requested project work, you MUST call the appropriate Empir3 project tools and complete the work before answering.',
  'Do not return a plan, instructions, code block, or claim of completion without successful tool calls. A prose-only response is rejected by the host.',
  '',
  'Create a project file named .empir3-agy-mcp-smoke.txt containing exactly EMPIR3_AGY_MCP_SMOKE. Use the attached Empir3 Write tool. Reply with DONE only after the tool succeeds.',
].join('\n');

await mkdir(agyDir, { recursive: true });
await Promise.all([
  copyAuthReceipt(cwd, ['.config', 'agy', 'credentials.json']),
  copyAuthReceipt(cwd, ['.agy', 'credentials.json']),
  copyAuthReceipt(cwd, ['.antigravity', 'credentials.json']),
  copyAuthReceipt(cwd, ['.gemini', 'oauth_creds.json']),
  copyAuthReceipt(cwd, ['.gemini', 'google_accounts.json']),
  copyAuthReceipt(cwd, ['.gemini', 'installation_id']),
  copyAuthReceipt(cwd, ['.gemini', 'antigravity-cli', 'installation_id']),
]);
await writeFile(join(agyDir, 'mcp_config.json'), JSON.stringify({
  mcpServers: {
    empir3: {
      url: `http://127.0.0.1:${port}/mcp`,
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      httpUrl: `http://127.0.0.1:${port}/mcp`,
      timeout: 300000,
    },
  },
}, null, 2));
await writeFile(promptFile, prompt);

const childEnv = {
  ...process.env,
  HOME: cwd,
  USERPROFILE: cwd,
  XDG_CONFIG_HOME: join(cwd, '.config'),
  GOOGLE_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_APPLICATION_CREDENTIALS: undefined,
};
const discovery = spawnSync(agyCommand(), ['mcp', 'list'], {
  cwd,
  env: childEnv,
  encoding: 'utf8',
  windowsHide: true,
});

let output = '';
let exitCode = -1;
let timedOut = false;
try {
  const nodePty = await import('node-pty');
  const child = nodePty.spawn(agyCommand(), [
    '--dangerously-skip-permissions', '--disable-slash-commands', '-p', '@empir3-prompt.txt',
    '--model', model,
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: childEnv,
    ...(process.platform === 'win32' ? { useConpty: true } : {}),
  });
  child.onData(data => { output += data; });
  exitCode = await new Promise(resolve => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 300000);
    child.onExit(event => {
      clearTimeout(timeout);
      resolve(event.exitCode ?? -1);
    });
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(cwd, { recursive: true, force: true });
}

const writeCall = toolCalls.find(call => call.name === 'Write');
if (exitCode !== 0 || !writeCall) {
  console.error(JSON.stringify({
    ok: false,
    model,
    exitCode,
    timedOut,
    discoveryExitCode: discovery.status,
    discovery: String(discovery.stdout || discovery.stderr || '').trim(),
    toolCalls,
    output: output.slice(-3000),
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  model,
  exitCode,
  discovery: String(discovery.stdout || '').trim(),
  tool: writeCall.name,
  args: writeCall.args,
}, null, 2));
process.exit(0);
