import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/pair-claim.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

async function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'empir3-pair-security-'));
  const exports = {};
  const context = { exports, setTimeout, URL, process: { env: { APPDATA: root }, platform: process.platform },
    require: name => name === './account-handover.js' ? { revokePriorDeviceCredential: async () => ({ attempted: false }) }
      : name === './empir3-url.js' ? require('../src/empir3-url.js') : require(name),
  };
  vm.runInNewContext(compiled, context);
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount++;
    const deviceId = req.headers['x-empir3-device-id'];
    assert.match(deviceId, /^bridge-/);
    assert.equal(JSON.parse(readFileSync(join(root, 'Empir3', 'bridge-settings.json'), 'utf8')).deviceId, deviceId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'claimed', userId: 'synthetic-user', ...(legacy ? { token: 'old-account-credential' } : { deviceToken: `e3dt_${'a'.repeat(48)}`, deviceId }) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const result = await exports.claimPairingCode('b'.repeat(64), { serverUrl: `http://127.0.0.1:${server.address().port}`, tries: 1 });
    assert.equal(requestCount, 1);
    const authPath = join(root, 'Empir3', 'bridge-auth.json');
    if (legacy) { assert.equal(result.ok, false); assert.equal(existsSync(authPath), false); }
    else {
      assert.equal(result.ok, true);
      const auth = JSON.parse(readFileSync(authPath, 'utf8'));
      assert.match(auth.deviceToken, /^e3dt_/);
      assert.equal(auth.legacyToken, undefined);
      assert.equal(auth.token, undefined);
      assert.equal(auth.deviceId, JSON.parse(readFileSync(join(root, 'Empir3', 'bridge-settings.json'), 'utf8')).deviceId);
    }
  } finally {
    await new Promise(r => server.close(r));
    if (!resolve(root).startsWith(resolve(tmpdir()) + '\\') && !resolve(root).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture path');
    rmSync(root, { recursive: true, force: true });
  }
}
test('actual installer redemption persists a device identity and scoped credential', () => fixture());
test('installer fails closed instead of saving a legacy account credential', () => fixture(true));

test('actual interactive poll sends its private proof and persists only a matching device credential', async () => {
  const source = ts.createSourceFile('server.ts', readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'startPairPoll');
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const urls = require('../src/empir3-url.js');
  const saved = [], requests = [];
  let tick;
  const context = vm.createContext({
    activePairPoll: null, EMPIR3_SERVER: 'https://app.empir3.com',
    normalizeEmpir3Server: urls.normalizeServer, classifyEmpir3Server: urls.classifyServer, normalizeEmpir3WsUrl: urls.normalizeWsUrl,
    stopPairPoll: state => { if (state) state.stopped = true; },
    setInterval: callback => { tick = callback; return 1; }, setTimeout: () => {},
    requestJson: async (...args) => { requests.push(args); return { status: 200, body: { status: 'claimed', deviceToken: `e3dt_${'c'.repeat(48)}`, deviceId: 'bridge-interactive', userId: 'synthetic' } }; },
    revokePriorDeviceCredential: async () => ({ attempted: false }),
    saveBridgeAuth: auth => saved.push(auth), clearStandaloneMode: () => {}, restartAfterPairing: () => {},
  });
  vm.runInContext(code, context);
  vm.runInContext(`startPairPoll('ABCD2345', '${'d'.repeat(64)}', 'bridge-interactive')`, context);
  await tick();
  assert.equal(requests[0][3]['X-Empir3-Pairing-Secret'], 'd'.repeat(64));
  assert.equal(requests[0][3]['X-Empir3-Device-Id'], 'bridge-interactive');
  assert.ok(!requests[0][1].includes('d'.repeat(64)), 'private proof stays out of the URL');
  assert.equal(saved.length, 1);
  assert.match(saved[0].deviceToken, /^e3dt_/);
  assert.equal(saved[0].legacyToken, undefined);
  assert.equal(saved[0].token, undefined);
});
