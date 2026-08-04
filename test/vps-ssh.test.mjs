import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handler = readFileSync(new URL('../src/handlers/vps-ssh.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('VPS SSH keeps credentials off argv and removes the ephemeral key', () => {
  assert.match(handler, /writeFileSync\(keyPath/);
  assert.match(handler, /unlinkSync\(keyPath\)/);
  assert.match(handler, /child\.stdin\?\.end\(input\)/);
  assert.match(handler, /sudoPassword\}\\n\$\{stdin/);
  assert.match(handler, /exec sudo -kS -p '' --/);
  assert.doesNotMatch(handler, /sudo -n/);
  const argvBlock = handler.match(/const args = \[([\s\S]*?)\];\s*return await runProcess/)?.[1] || '';
  assert.ok(argvBlock, 'ssh argv block is present');
  assert.doesNotMatch(argvBlock, /sudoPassword|privateKey/);
});

test('VPS SSH has one explicit mutation route and bounded job polling', () => {
  assert.match(handler, /action !== 'exec'/);
  assert.match(handler, /action === 'status'/);
  assert.match(handler, /randomInt\(100_000_000, 1_000_000_000\)/);
  assert.match(handler, /Math\.min\(Number\(raw\.timeoutSec\) \|\| 60, 300\)/);
  assert.match(handler, /transportUncertain: result\.timedOut \|\| code === 255/);
});

test('relay dispatcher exposes desktop:vps through the execute permission gate', () => {
  assert.match(server, /type === 'desktop:vps'/);
  assert.match(server, /handleVpsSsh/);
  assert.match(server, /requiredBridgePermission\(syntheticCmd\)/);
});
