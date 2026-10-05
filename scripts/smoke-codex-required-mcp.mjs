#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = process.argv[2] || 'gpt-5.6-sol';
const toolCalls = [];

function codexCommand() {
  if (process.env.EMPIR3_CODEX_COMMAND) return process.env.EMPIR3_CODEX_COMMAND;
  if (process.platform !== 'win32') return 'codex';
  const appData = process.env.APPDATA || '';
  const bundled = join(
    appData,
    'npm', 'node_modules', '@openai', 'codex', 'node_modules',
    '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
  );
  if (existsSync(bundled)) return bundled;
  throw new Error('Codex Windows executable not found; set EMPIR3_CODEX_COMMAND to its full path.');
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
      result: { content: [{ type: 'text', text: 'Saved .empir3-codex-mcp-smoke.txt successfully.' }] },
    };
  }
  return id === null ? null : { jsonrpc: '2.0', id, result: {} };
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
const cwd = await mkdtemp(join(tmpdir(), 'empir3-codex-mcp-smoke-'));
const prompt = [
  'CRITICAL EMPIR3 TOOL CONTRACT:',
  'Empir3 MCP tools are attached to this turn. For any requested project work, you MUST call the appropriate Empir3 project tools and complete the work before answering.',
  'Do not return a plan, instructions, code block, or claim of completion without successful tool calls. A prose-only response is rejected by the host.',
  '',
  'Create a project file named .empir3-codex-mcp-smoke.txt containing exactly EMPIR3_CODEX_MCP_SMOKE. Use the attached Empir3 Write tool. Reply with DONE only after the tool succeeds.',
].join('\n');

const args = [
  'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--sandbox', 'read-only', '--cd', cwd, '--skip-git-repo-check', '--model', model,
  '-c', `mcp_servers.empir3.url="http://127.0.0.1:${port}/mcp"`,
  '-c', 'mcp_servers.empir3.required=true',
  '-c', 'mcp_servers.empir3.default_tools_approval_mode="approve"',
  '-',
];

let stdout = '';
let stderr = '';
let exitCode = -1;
try {
  const child = spawn(codexCommand(), args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.end(prompt);
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  exitCode = await new Promise(resolve => {
    child.on('close', code => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(cwd, { recursive: true, force: true });
}

const writeCall = toolCalls.find(call => call.name === 'Write');
if (exitCode !== 0 || !writeCall) {
  console.error(JSON.stringify({ ok: false, model, exitCode, toolCalls, stderr: stderr.slice(-1000), stdout: stdout.slice(-2000) }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, model, exitCode, tool: writeCall.name, args: writeCall.args }, null, 2));
