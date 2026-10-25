#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const offset = process.pid % 200;
const bridgePort = 19600 + offset;
const cdpPort = 19100 + offset;
const temp = await mkdtemp(join(tmpdir(), 'empir3-browser-action-'));
const stdoutPath = join(temp, 'stdout.log');
const stderrPath = join(temp, 'stderr.log');
const output = [];

function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  }
  throw new Error('isolated CDP bridge did not become healthy');
}

async function action(body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `action HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

const child = spawn(process.execPath, ['--import', 'tsx', 'src/bridge.ts'], {
  cwd: root,
  detached: process.platform !== 'win32',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BRIDGE_PORT: String(bridgePort),
    PW_PORT: String(bridgePort),
    CDP_PORT: String(cdpPort),
    BRIDGE_PROFILE: join(temp, 'profile'),
    BRIDGE_HEADLESS: 'true',
    EMPIR3_CHROME_AUTOLAUNCH: '1',
  },
});
child.stdout.on('data', chunk => output.push(chunk.toString()));
child.stderr.on('data', chunk => output.push(chunk.toString()));

try {
  const health = await waitForHealth();
  // Chrome creates the welcome tab after its initial about:blank target. Let
  // target polling select the new page before resolving selectors on it.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  const clicked = await action({ kind: 'click', selector: '.mode[data-mode="empir3"]' }, 30_000);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const typed = await action({ kind: 'type', selector: '#email', text: 'rn-web-receipt@example.test' });
  if (!typed?.verified || typed?.characters !== 27) throw new Error(`type receipt failed: ${JSON.stringify(typed)}`);
  if (!clicked?.verified || !clicked?.receivedEvents?.length) throw new Error(`click receipt failed: ${JSON.stringify(clicked)}`);
  console.log(JSON.stringify({ ok: true, health: health.status, typed, clicked }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  console.error(output.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  stopTree(child);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rm(temp, { recursive: true, force: true }); break; }
    catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 200)); }
  }
}
