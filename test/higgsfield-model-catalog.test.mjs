import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handler = readFileSync(new URL('../src/handlers/higgsfield-cli.ts', import.meta.url), 'utf8');

test('Higgsfield model catalog accepts both current and legacy identifier fields', () => {
  assert.match(handler, /job_set_type:\s*m\.job_type\s*\?\?\s*m\.job_set_type/);
  assert.match(handler, /\.filter\(\(m:\s*any\)\s*=>\s*m\.job_set_type\)/);
});
