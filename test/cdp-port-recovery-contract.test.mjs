import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const daemon = readFileSync(new URL('../src/payload-daemon.ts', import.meta.url), 'utf8');
const stager = readFileSync(new URL('../scripts/stage-bridge-runtime.cjs', import.meta.url), 'utf8');

test('legacy Windows payload relocates CDP only when an unrelated process owns the default', () => {
  assert.match(daemon, /function chooseCdpPort/);
  assert.match(daemon, /unrelated = holders\.some/);
  assert.match(daemon, /process\.env\.CDP_PORT = String\(cdpPort\)/);
  assert.match(daemon, /CDP port \$\{preferred\} belongs to another app/);
});

test('universal runtime staging carries display discovery used by headless-entry', () => {
  assert.match(stager, /'platform-profile\.js'/);
});
