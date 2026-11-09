import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import lifecycleModule from '../src/cli-turn-lifecycle.ts';
const { CliTurnLifecycle } = lifecycleModule;
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'startCliMcpShim');
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(parsed) + '\nglobalThis.start=startCliMcpShim;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: {} } };
function send(url, payload = call, headers = {}, raw = false) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', x => { body += x; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject); req.end(raw ? payload : JSON.stringify(payload));
  });
}
async function fixture(t, { issued = true, complete = true, observeCall = () => {} } = {}) {
  const lifecycle = new CliTurnLifecycle(), scope = lifecycle.begin('codex', 'fixture'), events = [], pending = new Map();
  let onCall; const called = new Promise(r => { onCall = r; });
  const sandbox = { cliTurnLifecycle: lifecycle, createServer, require, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    MCP_TOOL_CALL_TIMEOUT_MS: 120000, cliPendingToolCalls: pending, cliMcpShims: new Map() };
  vm.runInNewContext(code, sandbox);
  const emit = (type, value) => { events.push({ type, value }); if (type.endsWith('tool:call')) {
    const entry = pending.get('fixture').get(value.callId); onCall(entry); observeCall(entry, events.length);
    if (complete) { clearTimeout(entry.timer); pending.get('fixture').delete(value.callId); entry.resolve('PRIVATE RESULT'); }
  } };
  const shim = await scope.run(() => sandbox.start('codex', 'fixture', 'empir3', [{ name: 'Read' }], emit));
  if (issued) scope.run(() => lifecycle.assertCanSpawn());
  t.after(async () => {
    scope.close(); for (const entry of pending.get('fixture')?.values() || []) { clearTimeout(entry.timer); entry.reject(Error('fixture closed')); }
    await new Promise(resolve => { shim.serverHandle.close(resolve); shim.serverHandle.closeAllConnections(); });
  });
  return { lifecycle, scope, shim, events, called, pending, issue: () => scope.run(() => lifecycle.assertCanSpawn()) };
}

test('actual local tool HTTP server rejects browser requests, public paths and hostile Host before dispatch', async t => {
  const f = await fixture(t);
  assert.match(new URL(f.shim.url).pathname, /^\/mcp\/[a-f0-9]{64}$/);
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'attacker.invalid' }]) {
    assert.equal((await send(f.shim.url, call, headers)).status, 403);
  }
  assert.equal((await send(new URL('/mcp', f.shim.url))).status, 403);
  assert.equal((await send(new URL('/mcp/' + '0'.repeat(64), f.shim.url))).status, 403);
  assert.equal(f.events.length, 0);
  const accepted = await send(f.shim.url); assert.equal(accepted.status, 200); assert.match(accepted.body, /PRIVATE RESULT/);
  assert.equal(f.events.length, 1);
});

test('local tool calls cannot run before the issued boundary or after cancellation', async t => {
  const f = await fixture(t, { issued: false }); assert.equal((await send(f.shim.url)).status, 403); assert.equal(f.events.length, 0);
  f.issue(); assert.equal((await send(f.shim.url)).status, 200);
  f.lifecycle.cancel('codex', 'fixture'); assert.equal((await send(f.shim.url)).status, 403); assert.equal(f.events.length, 1);
});

test('a pending tool result cannot disclose private content after Stop', async t => {
  const f = await fixture(t, { complete: false }), reply = send(f.shim.url);
  const entry = await f.called; f.lifecycle.cancel('codex', 'fixture'); clearTimeout(entry.timer); f.pending.get('fixture').clear(); entry.resolve('PRIVATE RESULT');
  const result = await reply; assert.equal(result.status, 200); assert.doesNotMatch(result.body, /PRIVATE RESULT/); assert.match(result.body, /cancelled/);
});

test('a closed tool server cannot adopt a new turn with the same wire identity', async t => {
  const f = await fixture(t); f.scope.close(); const second = f.lifecycle.begin('codex', 'fixture');
  second.run(() => f.lifecycle.assertCanSpawn());
  assert.equal((await send(f.shim.url)).status, 403); assert.equal(f.events.length, 0); second.close();
});

test('cancellation while a later batch call waits also withholds earlier buffered results', async t => {
  let observeSecond; const second = new Promise(resolve => { observeSecond = resolve; });
  const f = await fixture(t, { complete: false, observeCall: (entry, count) => { if (count === 2) observeSecond(entry); } });
  const reply = send(f.shim.url, [call, { ...call, id: 2 }]);
  const first = await f.called; clearTimeout(first.timer); first.resolve('PRIVATE EARLIER RESULT');
  const later = await second; f.lifecycle.cancel('codex', 'fixture'); clearTimeout(later.timer); later.resolve('PRIVATE LATER RESULT');
  f.pending.get('fixture').clear();
  const result = await reply; assert.equal(result.status, 200); assert.doesNotMatch(result.body, /PRIVATE/);
  const responses = JSON.parse(result.body); assert.equal(responses.length, 2);
  assert.ok(responses.every(r => r.error && !r.result));
});

test('a request body completed after cancellation cannot list the private toolkit', async t => {
  const f = await fixture(t);
  const listed = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  let observed; const received = new Promise(resolve => { observed = resolve; });
  f.shim.serverHandle.once('request', observed);
  let req;
  const response = new Promise((resolve, reject) => {
    req = request(f.shim.url, { method: 'POST', headers: { Connection: 'close' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject); req.flushHeaders();
  });
  await received; f.lifecycle.cancel('codex', 'fixture'); req.end(JSON.stringify(listed));
  const result = await response; assert.equal(result.status, 403); assert.doesNotMatch(result.body, /Read/);
  assert.equal(f.shim.attach.listed, false); assert.equal(f.events.length, 0);
});

test('tool server bounds request batches and bodies before dispatch', async t => {
  const f = await fixture(t);
  assert.equal((await send(f.shim.url, Array(33).fill(call))).status, 413);
  const oversized = await send(f.shim.url, 'x'.repeat(4 * 1024 * 1024 + 1), {}, true).catch(e => ({ error: e.code }));
  assert.ok(oversized.status === 413 || oversized.error === 'ECONNRESET', JSON.stringify(oversized));
  assert.equal(f.events.length, 0);
});

test('tool server refuses calls beyond its pending capacity', async t => {
  const f = await fixture(t); const pending = f.pending.get('fixture');
  for (let i = 0; i < 64; i++) pending.set('held-' + i, { timer: undefined, reject() {} });
  const reply = await send(f.shim.url); assert.match(reply.body, /capacity reached/); assert.equal(f.events.length, 0); pending.clear();
});
