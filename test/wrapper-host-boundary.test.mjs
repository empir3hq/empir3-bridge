import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { isTrustedLocalBridgeHost, localBridgeRequestRefusal } from '../src/browser-surface-security.mjs';
const ts = createRequire(import.meta.url)('typescript');
const source = ts.createSourceFile('server.ts', readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations]).find(d => d.name.getText(source) === 'httpServer');
assert.ok(declaration && ts.isCallExpression(declaration.initializer));
const callback = declaration.initializer.arguments[0].getText(source);
const js = ts.transpileModule(`const handler = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('actual wrapper handler refuses hostile Host before identity or CORS is served', async () => {
  const context = vm.createContext({ URL, PORT: 3006, BRIDGE_NONCE: 'synthetic-test-nonce',
    isTrustedLocalBridgeHost, localBridgeRequestRefusal,
    requestHasBridgeNonce: () => false, applyCors: () => {}, mutatingMethod: () => false,
  });
  vm.runInContext(js, context);
  const handler = vm.runInContext('handler', context);
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end('fixture failed'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function get(headers) {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/identity', headers }, res => {
        let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject); req.end();
    });
  }
  try {
    const rebound = await get({ Host: 'attacker.invalid:3006', 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(rebound.status, 403);
    assert.ok(!rebound.body.includes('synthetic-test-nonce'));
    const foreign = await get({ Host: 'localhost:3006', Origin: 'https://attacker.invalid' });
    assert.equal(foreign.status, 403);
    const native = await get({ Host: 'localhost:3006' });
    assert.equal(native.status, 200);
    assert.equal(JSON.parse(native.body).nonce, 'synthetic-test-nonce');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
