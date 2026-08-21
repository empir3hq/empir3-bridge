import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/stress-grok-concurrency.mjs', import.meta.url), 'utf8');

test('ten-session Grok stress markers cannot be substrings of one another', () => {
  assert.match(source, /String\(index \+ 1\)\.padStart\(2, '0'\)/);
});

test('current Bridge stress shape requests deterministic plain output', () => {
  assert.match(source, /legacyBridgeShape \? \[\] : \['--output-format', 'plain'\]/);
  assert.match(source, /legacyBridgeShape \? \[\] : \['--tools', ''\]/);
  assert.match(source, /--exact-bridge-shape/);
});
