import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handler = readFileSync(new URL('../src/handlers/higgsfield-cli.ts', import.meta.url), 'utf8');

test('Windows Higgsfield launch never sends prompts through cmd.exe', () => {
  assert.doesNotMatch(handler, /spawn\('cmd\.exe'/);
  assert.match(handler, /resolveHiggsfieldSpawn\(bin, argv\)/);
  assert.match(handler, /args: \[entry, \.\.\.argv\]/);
});

test('the npm shim is unwrapped to its JavaScript entrypoint', () => {
  assert.match(handler, /'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield\.js'/);
  assert.match(handler, /command: nodeBin/);
  assert.match(handler, /unsupported Higgsfield Windows command shim/);
});
