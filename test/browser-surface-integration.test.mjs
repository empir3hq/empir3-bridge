import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('isolated server did not become ready');
}

function socketOutcome(url, origin, accepted) {
  return new Promise((resolveOutcome, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : undefined);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error(`websocket outcome timed out for ${url}`));
    }, 5_000);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      if (accepted) ws.close(1000, 'test complete');
    });
    ws.on('error', error => {
      if (!accepted) return;
      clearTimeout(timer);
      reject(error);
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolveOutcome({ opened, code, reason: reason.toString() });
    });
  });
}

test('isolated server rejects hostile browser roles and tombstones overlay scripts', { timeout: 30_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'empir3-browser-boundary-'));
  const port = 34_000 + Math.floor(Math.random() * 1_000);
  const cdpPort = port + 1_500;
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsxCli, 'src/server.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PW_PORT: String(port),
      EMPIR3_BRIDGE_PORT: String(cdpPort),
      EMPIR3_BRIDGE_RUNTIME_DATA_DIR: join(state, 'runtime'),
      APPDATA: join(state, 'appdata'),
      LOCALAPPDATA: join(state, 'localappdata'),
      EMPIR3_WS_URL: '',
      EMPIR3_AUTH_TOKEN: '',
      EMPIR3_BRIDGE_NO_CHROME_AUTOLAUNCH: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer(baseUrl, child);

    const dashboard = await fetch(`${baseUrl}/`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get('content-security-policy') || '', /script-src 'nonce-/);
    assert.match(await dashboard.text(), /role=control/);

    const overlay = await fetch(`${baseUrl}/overlay.js`);
    assert.equal(overlay.status, 410);
    assert.equal((await overlay.json()).controlUrl, `http://localhost:${port}/`);

    const wsBase = `ws://127.0.0.1:${port}`;
    const hostileCli = await socketOutcome(`${wsBase}?role=cli`, 'https://malicious.example', false);
    assert.equal(hostileCli.code, 1008);
    assert.match(hostileCli.reason, /cannot claim the cli role/);

    const hostileControl = await socketOutcome(`${wsBase}?role=control`, 'https://malicious.example', false);
    assert.equal(hostileControl.code, 1008);
    assert.match(hostileControl.reason, /trusted localhost origin/);

    const retiredOverlay = await socketOutcome(`${wsBase}?role=overlay`, `http://localhost:${port}`, false);
    assert.equal(retiredOverlay.code, 1008);
    assert.match(retiredOverlay.reason, /unsupported browser socket role/);

    const trustedControl = await socketOutcome(`${wsBase}?role=control`, `http://localhost:${port}`, true);
    assert.equal(trustedControl.opened, true);

    const nativeCli = await socketOutcome(`${wsBase}?role=cli`, '', true);
    assert.equal(nativeCli.opened, true);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      new Promise(resolveWait => setTimeout(resolveWait, 3_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(state, { recursive: true, force: true });
  }

  assert.equal(stderr.includes('EADDRINUSE'), false, stderr);
});
