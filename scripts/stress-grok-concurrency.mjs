#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const requested = Number(process.argv.find(arg => /^--count=/.test(arg))?.split('=')[1] || 5);
const count = Math.max(1, Math.min(10, Math.floor(requested) || 5));
const exactBridgeShape = process.argv.includes('--exact-bridge-shape');
const legacyBridgeShape = process.argv.includes('--legacy-bridge-shape');
const timeoutMs = Math.max(30_000, Number(process.env.EMPIR3_GROK_STRESS_TIMEOUT_MS) || 180_000);
const realHome = homedir();
const grokBin = process.env.EMPIR3_GROK_BIN || join(realHome, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');

async function readable(path) {
  try { await access(path, fsConstants.R_OK); return true; } catch { return false; }
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

async function createIsolation(index, root, shimUrl) {
  const isolatedHome = await mkdtemp(join(root, `session-${index}-`));
  const grokDir = join(isolatedHome, '.grok');
  await mkdir(grokDir, { recursive: true });
  const authSource = join(realHome, '.grok', 'auth.json');
  if (await readable(authSource)) await copyFile(authSource, join(grokDir, 'auth.json'));
  await writeFile(join(grokDir, 'config.toml'), [
    `[mcp_servers.empir3-stress-${index}]`,
    `url = "${shimUrl}"`,
    'type = "http"',
    'enabled = true',
    '',
  ].join('\n'), 'utf8');
  const parsed = parse(isolatedHome);
  const homePath = isolatedHome.slice(parsed.root.length - (parsed.root.endsWith('\\') ? 1 : 0));
  return {
    root: isolatedHome,
    leaderSocket: join(grokDir, `leader-stress-${index}.sock`),
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      ...(process.platform === 'win32' ? {
        HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
        HOMEPATH: homePath.startsWith('\\') ? homePath : `\\${homePath}`,
      } : {}),
    },
  };
}

async function startMarkerServer(marker) {
  const state = { listed: 0, called: 0 };
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      let rpc;
      try { rpc = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const requests = Array.isArray(rpc) ? rpc : [rpc];
      const responses = [];
      for (const request of requests) {
        if (request?.id === undefined || request?.id === null) continue;
        if (request.method === 'initialize') {
          responses.push({
            jsonrpc: '2.0', id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'empir3-grok-stress', version: '1.0.0' },
            },
          });
        } else if (request.method === 'ping' || request.method === 'notifications/initialized') {
          responses.push({ jsonrpc: '2.0', id: request.id, result: {} });
        } else if (request.method === 'tools/list') {
          state.listed += 1;
          responses.push({
            jsonrpc: '2.0', id: request.id,
            result: {
              tools: [{
                name: 'session_marker',
                description: 'Returns the unique marker for this isolated stress session.',
                inputSchema: { type: 'object', properties: {} },
              }],
            },
          });
        } else if (request.method === 'tools/call' && request?.params?.name === 'session_marker') {
          state.called += 1;
          responses.push({
            jsonrpc: '2.0', id: request.id,
            result: { content: [{ type: 'text', text: marker }] },
          });
        } else {
          responses.push({
            jsonrpc: '2.0', id: request.id,
            error: { code: -32601, message: `Method not found: ${request?.method}` },
          });
        }
      }
      if (responses.length === 0) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(rpc) ? responses : responses[0]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    state,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runSession(index, root, markers) {
  const marker = markers[index];
  const markerServer = await startMarkerServer(marker);
  let isolation;
  try {
    isolation = await createIsolation(index, root, markerServer.url);
  } catch (error) {
    await markerServer.close();
    throw error;
  }
  const promptPath = join(isolation.root, 'prompt.txt');
  await writeFile(promptPath, 'Call the session_marker tool. Reply with exactly its result and no other text.', 'utf8');
  const startedAt = Date.now();

  try {
    return await new Promise(resolve => {
      const childArgs = [
        '--prompt-file', promptPath,
        ...(legacyBridgeShape ? [] : ['--output-format', 'plain']),
        '--always-approve',
        // Current relay isolation removes Grok's native filesystem/shell
        // tools. The only callable tool in this stress run must therefore be
        // the unique per-session Empir3 MCP marker.
        ...(legacyBridgeShape ? [] : ['--tools', '']),
        '--leader-socket', isolation.leaderSocket,
      ];
      const child = spawn(grokBin, childArgs, {
        env: isolation.env,
        cwd: isolation.root,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1000); });
      child.on('error', error => {
        clearTimeout(timer);
        resolve({ index, marker, ok: false, durationMs: Date.now() - startedAt, error: error.message });
      });
      child.on('close', code => {
        clearTimeout(timer);
        const ownMarker = stdout.includes(marker);
        const foreignMarker = markers.some((candidate, candidateIndex) => candidateIndex !== index && stdout.includes(candidate));
        resolve({
          index,
          marker,
          ok: !timedOut && code === 0 && ownMarker && !foreignMarker && markerServer.state.called > 0,
          durationMs: Date.now() - startedAt,
          exitCode: code,
          timedOut,
          ownMarker,
          foreignMarker,
          toolsListed: markerServer.state.listed,
          toolCalls: markerServer.state.called,
          stderrTail: stderr.replace(/\s+/g, ' ').trim().slice(-240),
        });
      });
    });
  } finally {
    await markerServer.close();
    await rm(isolation.root, { recursive: true, force: true });
  }
}

if (!(await readable(grokBin))) {
  console.error(`Grok CLI not found: ${grokBin}`);
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), 'empir3-grok-stress-'));
const nonce = Date.now().toString(36);
// Keep every marker non-overlapping. Without fixed-width suffixes marker 10
// contains marker 1, which falsely looks like cross-session leakage.
const markers = Array.from({ length: count }, (_, index) => `EMPIR3_GROK_STRESS_${nonce}_${String(index + 1).padStart(2, '0')}`);
console.log(`Starting ${count} isolated Grok sessions (${legacyBridgeShape ? 'legacy Bridge args' : exactBridgeShape ? 'current Bridge args' : 'explicit plain output'}, timeout ${Math.round(timeoutMs / 1000)}s each)`);

try {
  const results = await Promise.all(markers.map((_, index) => runSession(index, root, markers)));
  for (const result of results) console.log(JSON.stringify(result));
  const passed = results.filter(result => result.ok).length;
  console.log(`Result: ${passed}/${count} isolated sessions passed`);
  process.exitCode = passed === count ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
