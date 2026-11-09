import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));

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
    ws.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      ws.terminate();
      resolveOutcome({ opened, httpStatus: response.statusCode });
    });
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
  const tempRoot = realpathSync(tmpdir());
  const state = realpathSync(mkdtempSync(join(tempRoot, 'empir3-browser-boundary-')));
  assert.equal(dirname(state), tempRoot);
  assert.ok(basename(state).startsWith('empir3-browser-boundary-'));
  const port = 34_000 + Math.floor(Math.random() * 1_000);
  const cdpPort = port + 1_500;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Import the loader in the owned server process, without a launcher child.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
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
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let closed = false;
  const close = new Promise(resolveClose => child.once('close', () => { closed = true; resolveClose(); }));
  const awaitClose = async () => {
    let timer;
    try { await Promise.race([close, new Promise(resolveWait => { timer = setTimeout(resolveWait, 3_000); })]); }
    finally { clearTimeout(timer); }
  };

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
    assert.equal(hostileCli.opened, false);
    assert.equal(hostileCli.httpStatus, 401);

    const hostileControl = await socketOutcome(`${wsBase}?role=control`, 'https://malicious.example', false);
    assert.equal(hostileControl.opened, false);
    assert.equal(hostileControl.httpStatus, 401);

    const retiredOverlay = await socketOutcome(`${wsBase}?role=overlay`, `http://localhost:${port}`, false);
    assert.equal(retiredOverlay.code, 1008);
    assert.match(retiredOverlay.reason, /unsupported browser socket role/);

    const trustedControl = await socketOutcome(`${wsBase}?role=control`, `http://localhost:${port}`, true);
    assert.equal(trustedControl.opened, true);

    const nativeCli = await socketOutcome(`${wsBase}?role=cli`, '', true);
    assert.equal(nativeCli.opened, true);
  } finally {
    if (!closed) child.kill('SIGTERM');
    await awaitClose();
    if (!closed) { child.kill('SIGKILL'); await awaitClose(); }
    assert.equal(closed, true, 'preserve fixture files until the owned server closes');
    assert.equal(realpathSync(state), state, 'fixture path must not be replaced');
    assert.equal(dirname(state), tempRoot);
    rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  assert.equal(stderr.includes('EADDRINUSE'), false, stderr);
});
