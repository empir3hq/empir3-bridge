import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Windows wake controller wraps both screenshot and click paths', () => {
  assert.match(source, /createWindowsDesktopAwakeController/);
  const screenshot = source.slice(source.indexOf('async function takeDesktopScreenshot'), source.indexOf('async function desktopClick'));
  assert.match(screenshot, /await windowsDesktopAwake\.ensureAwake\(runPowerShellJson\)/);
  const click = source.slice(source.indexOf('async function desktopClick'), source.indexOf('async function desktopHover'));
  assert.match(click, /await windowsDesktopAwake\.ensureAwake\(runPowerShellJson\)/);
});

test('graceful shutdown releases the keep-awake lease', () => {
  assert.match(source, /process\.on\('SIGINT',[\s\S]*windowsDesktopAwake\.release\(\)/);
});
