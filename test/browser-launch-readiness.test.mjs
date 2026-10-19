import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { WebSocket, WebSocketServer } from 'ws';

const source = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('bridge.ts', source, ts.ScriptTarget.Latest, true);
const declarations = ['pickInitialTarget', 'connectCDP'].map(name => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node);
  return node.getText(tree);
}).join('\n');

async function fixture(t, empty) {
  const methods = [], created = [];
  const server = http.createServer((req, res) => {
    let value;
    if (req.url === '/json') value = empty && !created.length ? [] : [page];
    else if (req.url === '/json/version') value = { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` };
    else if (req.method === 'PUT' && req.url.startsWith('/json/new?')) { created.push(req.url); value = page; }
    else { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => ws.on('message', data => {
    const message = JSON.parse(data);
    methods.push({ path: req.url, method: message.method });
    // The browser is healthy while every page renderer remains stalled.
    if (req.url === '/browser') ws.send(JSON.stringify({ id: message.id, result: { product: 'Chrome/fixture' } }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const page = { id: 'console', type: 'page', url: 'http://localhost:3006/welcome', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` };
  let browserWs;
  const fetchJSON = async (url, method = 'GET') => (await fetch(url, { method })).json();
  const context = vm.createContext({
    URL, WebSocket, process: { env: {} }, console: { log() {} }, setTimeout, clearTimeout,
    CDP_PORT: port, WRAPPER_PORT: 3006, PORT: 9867, CDP_LIVENESS_TIMEOUT_MS: 200,
    currentTargetId: '', cdpWs: null, connected: false, lastCdpLivenessAt: 0, cdpCallbacks: new Map(), fetchJSON,
    verifyCdpConnection: async () => {
      context.cdpWs.send(JSON.stringify({ id: 999, method: 'Runtime.evaluate', params: { expression: '1' } }));
      await new Promise(r => setTimeout(r, 40)); return false;
    },
    ensureBrowserWsReady: async () => {
      if (browserWs?.readyState === WebSocket.OPEN) return;
      const version = await fetchJSON(`http://127.0.0.1:${port}/json/version`);
      browserWs = new WebSocket(version.webSocketDebuggerUrl); await once(browserWs, 'open');
    },
    browserSend: async method => {
      const response = once(browserWs, 'message');
      browserWs.send(JSON.stringify({ id: 1, method, params: {} }));
      return JSON.parse((await response)[0]).result;
    },
  });
  vm.runInContext(ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  t.after(async () => {
    context.cdpWs?.terminate(); browserWs?.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise(r => wss.close(r));
    server.closeAllConnections(); await new Promise(r => server.close(r));
  });
  return { context, created, methods };
}

test('browser launch creates its console when CDP has zero page targets', async t => {
  const f = await fixture(t, true);
  await f.context.connectCDP();
  assert.equal(f.context.connected, true);
  assert.equal(f.created.length, 1);
  assert.ok(f.methods.some(x => x.path === '/browser' && x.method === 'Browser.getVersion'));
  assert.ok(!f.methods.some(x => x.method === 'Runtime.evaluate'));
});

test('stalled page renderer cannot reject a healthy browser launch', async t => {
  const f = await fixture(t, false);
  await f.context.connectCDP();
  assert.equal(f.context.connected, true);
  assert.equal(f.created.length, 0);
  assert.ok(!f.methods.some(x => x.method === 'Runtime.evaluate'));
});

test('passive target lookup preserves a browser with all pages closed', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.context.pickInitialTarget(), /No page targets/);
  assert.equal(f.created.length, 0);
});

for (const exited of [false, true]) test(`unrecoverable Chrome launch gives reversible profile recovery; exited=${exited}`, async () => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'waitForChromeCDP');
  let clockReads = 0;
  const context = vm.createContext({
    Date: { now: () => clockReads++ ? 3000 : 0 }, CHROME_LAUNCH_TIMEOUT_MS: 5000,
    PROFILE_DIR: 'C:/fixture/profile', chromeProcess: null, chromeEverStarted: true,
    chromeExitCode: 1, chromeExitSignal: null, chromeStderrTail: 'fixture launch error',
    connectCDP: async () => { throw new Error('fixture unavailable'); }, sleep: async () => {},
  });
  vm.runInContext(ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await assert.rejects(context.waitForChromeCDP(exited ? 5000 : 0), error => {
    assert.match(error.message, exited ? /Chrome exited/ : /Chrome did not expose CDP/);
    assert.match(error.message, /Restart the Bridge.*quit the Bridge, rename/);
    assert.match(error.message, /"C:\/fixture\/profile" to "C:\/fixture\/profile-old"/);
    assert.match(error.message, /Keep the old folder/);
    return true;
  });
});
