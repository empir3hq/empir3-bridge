import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// Dedicated profile/CDP port; this never connects to the maintained Bridge.
test('real Chrome: concurrent multi-tab sweep, exact targets, bounded retention and explicit cleanup', {
  skip: process.env.EMPIR3_RUN_BROWSER_INTEGRATION !== '1', timeout: 120_000,
}, async t => {
  const state = await mkdtemp(join(tmpdir(), 'empir3-tab-batch-'));
  const fixture = createServer((req, res) => {
    if (req.url.startsWith('/redirect/')) { res.writeHead(302, { Location: req.url.replace('/redirect/', '/page/') }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><title>Fixture</title></head><body>${req.url}</body></html>`);
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const portFor = async () => { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const port = await portFor(), cdpPort = await portFor();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bridge.ts'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, BRIDGE_PORT: String(port), CDP_PORT: String(cdpPort), BRIDGE_PROFILE: join(state, 'profile'), EMPIR3_BRIDGE_RUNTIME_DATA_DIR: join(state, 'runtime'), BRIDGE_HEADLESS: 'true', BRIDGE_TOKEN: '', EMPIR3_CHROME_AUTOLAUNCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
  const api = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await r.json();
    if (!r.ok || value.error || value.success === false) throw Error(value.error || JSON.stringify(value));
    return value;
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw Error(log);
      try { const h = await api('/health'); if (h.browserRunning && h.cdpConnected) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(ready, log);
    const baseline = await api('/tabs');
    const started = Date.now();
    const work = await Promise.all(Array.from({ length: 12 }, (_, i) => api('/create-tab', { url: `${fixtureUrl}/redirect/${i}` })));
    assert.equal(new Set(work.map(p => p.targetId)).size, 12);
    for (const [i, page] of work.entries()) {
      assert.equal(page.url, `${fixtureUrl}/page/${i}`);
      assert.equal(page.loaded, true);
    }
    const before = await api('/tabs');
    await api('/navigate', { targetId: work[0].targetId, url: fixtureUrl + '/changed' });
    const image = await api(`/screenshot?format=json&targetId=${work[0].targetId}`);
    assert.ok(image.data.length > 100);
    const after = await api('/tabs');
    assert.equal(after.currentTargetId, before.currentTargetId);
    assert.equal(after.tabs.find(p => p.id === work[1].targetId).url, fixtureUrl + '/page/1');
    const limit = 24;
    for (let i = after.tabs.length; i < limit; i++) work.push(await api('/create-tab', { url: fixtureUrl + '/kept' }));
    await assert.rejects(api('/create-tab', { url: fixtureUrl + '/excess' }), /browser_tab_limit.*No tabs were closed/);
    for (const page of work) {
      assert.equal(page.tabPolicy.mode, 'keep-until-explicit-close');
      assert.equal(page.tabPolicy.maxOpenTabs, limit);
    }
    const full = await api('/tabs');
    assert.equal(full.tabs.length, limit);
    for (const page of [...baseline.tabs, ...work]) assert.ok(full.tabs.some(p => p.id === (page.targetId || page.id)));
    for (const page of work) assert.equal((await api('/close-target', { targetId: page.targetId })).closed, true);
    assert.deepEqual((await api('/tabs')).tabs.map(p => p.id).sort(), baseline.tabs.map(p => p.id).sort());
    t.diagnostic(JSON.stringify({ concurrentOpens: 12, maxOpenTabs: limit, baselineTabsPreserved: baseline.tabs.length, elapsedMs: Date.now() - started }));
  } finally {
    try {
      const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      await new Promise(resolve => { const ws = new WebSocket(v.webSocketDebuggerUrl); const timer = setTimeout(() => { ws.terminate(); resolve(); }, 2000); ws.on('error', () => { clearTimeout(timer); resolve(); }); ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))); ws.on('close', () => { clearTimeout(timer); resolve(); }); });
    } catch {}
    child.kill();
    await new Promise(r => setTimeout(r, 500));
    fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
    await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
