import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function connectBody() {
  const start = server.indexOf('function connectToEmpir3(');
  assert.ok(start >= 0, 'connectToEmpir3 exists');
  const end = server.indexOf("ws.on('open'", start);
  return server.slice(start, end);
}

test('relay reconnect reads the current token, so a rotated device token is used without a restart', () => {
  const body = connectBody();
  assert.match(body, /const authToken = currentEmpir3AuthToken\(\);/);
  assert.match(body, /Authorization: `Bearer \$\{authToken\}`/);
  assert.doesNotMatch(body, /Bearer \$\{EMPIR3_AUTH_TOKEN\}/);
});

test('current token prefers the env override, then the on-disk auth file', () => {
  assert.match(server, /function currentEmpir3AuthToken\(\): string \{\s*return process\.env\.EMPIR3_AUTH_TOKEN \|\| bridgeAuthToken\(\) \|\| EMPIR3_AUTH_TOKEN;/);
});

test('rotation persists the new token to the auth file the reconnect reads', () => {
  const start = server.indexOf('        auth.deviceToken = payload.deviceToken;');
  const end = server.indexOf('        saveBridgeAuth(auth);', start) + '        saveBridgeAuth(auth);'.length;
  assert.ok(start > 0 && end > start);
  const auth = { deviceToken: 'old-device', legacyToken: 'old-account', token: 'old-account' };
  let saved;
  vm.runInNewContext(transformSync(server.slice(start,end),{loader:'ts'}).code, {
    auth, payload: {deviceToken:'new-device'}, readBridgeSettings:()=>({deviceId:'this-device'}), saveBridgeAuth:value=>{saved={...value}},
  });
  assert.equal(saved.deviceToken,'new-device');
  assert.equal(saved.deviceId,'this-device');
  assert.equal(saved.legacyToken,undefined);
  assert.equal(saved.token,undefined);
  assert.ok(Number.isFinite(Date.parse(saved.deviceTokenMintedAt)));
  assert.match(server, /return auth\?\.deviceToken \|\| auth\?\.legacyToken \|\| auth\?\.token \|\| '';/);
});
