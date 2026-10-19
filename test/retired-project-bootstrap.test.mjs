import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Bridge history uses websocket state and never calls the retired owner-scoped project route', async () => {
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
  assert.doesNotMatch(source, /mirrorEmpir3Project/);
  assert.match(source, /type === 'state:snapshot'/);
  assert.match(source, /payload\.missedEvents/);
  assert.match(source, /startLocalProjectSyncLoop\(ws\)/);
  assert.match(source, /desktop:sync:request/);
});
