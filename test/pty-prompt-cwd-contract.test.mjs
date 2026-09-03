import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('PTY prompt files are referenced relative to the CLI spawn cwd', () => {
  assert.match(source, /args\.push\(`\$\{imageRefPrefix\}\$\{spec\.promptFile\.prefix \?\? ''\}\$\{filename\}`\)/);
  assert.match(source, /return \{\s*cwd: dir,\s*cleanup:/);
  assert.match(source, /cwd: promptArgHandle\?\.cwd \?\? mcpHandle\?\.cwd \?\? process\.cwd\(\)/);
  assert.doesNotMatch(source, /promptFile\.prefix \?\? ''\}\$\{promptPath\}/);
});
