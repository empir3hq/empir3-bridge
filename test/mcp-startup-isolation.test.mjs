import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function checkBridgeHealth(');
const end = source.indexOf('// ─── Start', start);
const code = transformSync(source.slice(start, end), { loader: 'ts' }).code;
function harness(url, responses) {
  const requests = []; let launches = 0;
  const context = vm.createContext({ BRIDGE_URL: url, URL, AbortController, setTimeout, clearTimeout,
    process: { env: { BRIDGE_URL: url }, platform: 'win32', argv: [], execPath: 'node' },
    bridgeHeaders: () => ({}), console: { error() {} }, ROOT: 'fixture', LAUNCHER: 'fixture-launcher', resolveBootstrapExe: () => null,
    spawn: () => { launches++; return { unref() {} }; },
    fetch: async endpoint => { requests.push(endpoint); const next = responses.shift(); if (next instanceof Error) throw next; if (!next) throw Error('unexpected request'); return { status: next.status ?? 200, ok: (next.status ?? 200) < 400, json: async () => next.body }; },
  });
  vm.runInContext(code, context);
  return { context, requests, launches: () => launches };
}
test('an unavailable alternate instance never launches the primary browser', async () => {
  const h = harness('http://127.0.0.1:3306', [Error('offline')]);
  await assert.rejects(h.context.ensureBridgeRunning(), /configured Bridge is unavailable.*3306/);
  assert.equal(h.launches(), 0);
});
test('MCP uses lightweight service health without waiting for browser observation', async () => {
  const h = harness('http://localhost:3006', [{ body: { ok: true, engine: 'empir3-bridge' } }]);
  await h.context.ensureBridgeRunning();
  assert.deepEqual(h.requests, ['http://localhost:3006/api/health']); assert.equal(h.launches(), 0);
});
test('older installed Bridge with a closed browser is still healthy', async () => {
  const h = harness('http://localhost:3006', [{ status: 404 }, { body: { engine: 'empir3-bridge', running: false } }]);
  await h.context.ensureBridgeRunning();
  assert.deepEqual(h.requests.map(url => new URL(url).pathname), ['/api/health', '/api/status']); assert.equal(h.launches(), 0);
});
test('a healthy alternate endpoint needs no launcher', async () => {
  const h = harness('http://127.0.0.1:3306', [{ body: { engine: 'empir3-bridge' } }]);
  await h.context.ensureBridgeRunning(); assert.equal(h.launches(), 0);
});
