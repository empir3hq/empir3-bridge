/**
 * Device-emulation consistency verdict (Work Board 22e20910, P3).
 *
 * Observed: browser_emulate_device iphone14 reported 390x844 while the page
 * measured 382x826, and navigator.maxTouchPoints was 5 with
 * 'ontouchstart' in window false. The tool now reads the page back after
 * applying the override and reports a verdict plus a reload recommendation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { emulationConsistency } = require_('../src/device-emulation-check.js');

test('matching viewport and consistent touch → no reload required', () => {
  const v = emulationConsistency({ width: 390, height: 844 }, { innerWidth: 390, innerHeight: 844, maxTouchPoints: 5, ontouchstart: true });
  assert.equal(v.checked, true);
  assert.equal(v.viewportMatches, true);
  assert.equal(v.touchConsistent, true);
  assert.equal(v.reloadRequired, false);
  assert.deepEqual(v.notes, []);
});

test('the observed inconsistency is named: viewport delta and unbound touch handlers', () => {
  const v = emulationConsistency({ width: 390, height: 844 }, { innerWidth: 382, innerHeight: 826, maxTouchPoints: 5, ontouchstart: false });
  assert.equal(v.viewportMatches, false);
  assert.deepEqual(v.delta, { width: -8, height: -18 });
  assert.equal(v.touchConsistent, false);
  assert.equal(v.reloadRequired, true);
  assert.match(v.notes[0], /382x826 CSS px, not the requested 390x844 \(delta -8\/-18\)/);
  assert.match(v.notes[1], /binds touch handlers at document creation, so reload/);
});

test('no readback → reload recommended, verdict unchecked', () => {
  const v = emulationConsistency({ width: 412, height: 915 }, null);
  assert.equal(v.checked, false);
  assert.equal(v.viewportMatches, null);
  assert.equal(v.reloadRequired, true);
  assert.match(v.notes[0], /could not be read back/);
});

test('bridge reads the page back, hides scrollbars, and honours reload', () => {
  const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  assert.match(bridge, /Emulation\.setScrollbarsHidden/);
  assert.match(bridge, /const measured = await readEmulationBack\(session\);/);
  assert.match(bridge, /const consistency = emulationConsistency\(\{ width: w, height: h \}, measured\);/);
  assert.match(bridge, /setDeviceEmulation\(String\(body\.preset \|\| 'off'\), body\.width, body\.height, body\.reload === true\)/);
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /kind: 'emulate_device', preset, width: cmd\.width, height: cmd\.height, reload: \(cmd as any\)\.reload === true/);
});
