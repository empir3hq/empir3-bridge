import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(server, /auth\.deviceToken = payload\.deviceToken;[\s\S]{0,200}saveBridgeAuth\(auth\);/);
  assert.match(server, /return auth\?\.deviceToken \|\| auth\?\.legacyToken \|\| auth\?\.token \|\| '';/);
});
