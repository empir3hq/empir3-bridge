import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../desktop-shell/scripts/smoke-package.cjs', import.meta.url), 'utf8');

test('hosted package smoke uses browser-only headless CDP without changing installed behavior', () => {
  assert.match(smoke, /EMPIR3_SCALE_BROWSER_HEADLESS: process\.env\.CI === 'true' \? '1' : ''/);
  assert.match(server, /process\.env\.EMPIR3_SCALE_BROWSER_HEADLESS === '1'/);
  assert.match(server, /env\.EMPIR3_CHROME_HEADLESS = '1'/);
  assert.match(bridge, /process\.env\.EMPIR3_CHROME_HEADLESS === '1'/);
  assert.doesNotMatch(smoke, /BRIDGE_HEADLESS: 'true'/);
});
