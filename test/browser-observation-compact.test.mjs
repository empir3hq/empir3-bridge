/**
 * bridge_control_observe compact / maxElements (Work Board 22e20910, P3).
 *
 * Observed: on the Bridge settings page observe returned ~40,000 characters
 * (full controls array with every null field, plus 12k of page text) where
 * browser_snapshot gave the same actionable information in ~2,000. The
 * observation now honours compact and maxElements and reports controlCount /
 * truncated so the cost of a fuller read is visible before paying it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserObservationExpression } from '../src/browser-control.js';

const element = (properties = {}, attributes = {}) => ({ tagName: 'INPUT', type: 'text', id: '', value: '', checked: false, getAttribute: (name) => attributes[name] ?? null, ...properties });

function observe(controls, limits) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(browserObservationExpression({ browserTextCharacters: 5000, browserElements: 300, browserNameCharacters: 100, ...limits }), {
    location: { href: 'https://fixture.invalid/' },
    document: { title: 'Fixture', body: { innerText: 'x'.repeat(4000) }, querySelectorAll: () => controls },
  })));
}

const many = Array.from({ length: 120 }, (_, i) => element({ id: `c${i}` }, { role: i % 2 ? 'button' : null }));

test('default observation is unchanged in shape but now reports controlCount and truncated', () => {
  const r = observe(many, {});
  assert.equal(r.controls.length, 120);
  assert.equal(r.controlCount, 120);
  assert.equal(r.truncated, false);
  assert.equal(r.text.length, 4000);
  assert.equal(r.compact, undefined);
  assert.ok('role' in r.controls[0], 'full observation keeps null fields');
});

test('compact keeps usable native roles while dropping empty fields and capping text', () => {
  const r = observe(many, { compact: true });
  assert.equal(r.compact, true);
  assert.equal(r.text.length, 1000);
  assert.equal(r.controls[0].role, 'textbox', 'native input role is usable by control_run');
  assert.ok(!('checked' in r.controls[0]), 'false checked omitted');
  assert.ok(!('value' in r.controls[0]), 'empty value omitted');
  assert.equal(r.controls[1].role, 'button', 'real values kept');
  assert.ok(JSON.stringify(r).length < JSON.stringify(observe(many, {})).length * 0.7, 'compact is materially smaller');
});

test('maxElements caps the controls and flags truncation; it never exceeds the Control limit', () => {
  const r = observe(many, { maxElements: 20 });
  assert.equal(r.controls.length, 20);
  assert.equal(r.controlCount, 120);
  assert.equal(r.truncated, true);
  const capped = observe(many, { maxElements: 5000, browserElements: 50 });
  assert.equal(capped.controls.length, 50, 'browserElements is the ceiling');
  const floor = observe(many, { maxElements: 0 });
  assert.equal(floor.controls.length, 120, 'non-positive maxElements falls back to the limit');
});

test('checked / expanded / password rules survive compaction', () => {
  const r = observe([
    element({ type: 'checkbox', checked: true }),
    element({ tagName: 'DIV' }, { role: 'checkbox', 'aria-checked': 'mixed' }),
    element({ type: 'password', value: 'fixture-secret' }),
    element({ type: 'checkbox', checked: false, labels: [{textContent:'  Remember me  '}] }),
    element({ tagName:'BUTTON',textContent:'More' }, {'aria-expanded':'false'}),
  ], { compact: true });
  assert.equal(r.controls[0].checked, true);
  assert.equal(r.controls[1].checked, 'mixed');
  assert.ok(!('value' in r.controls[2]));
  assert.ok(!JSON.stringify(r).includes('fixture-secret'));
  assert.equal(r.controls[3].checked, false, 'unchecked is known false, not unavailable');
  assert.equal(r.controls[3].name, 'Remember me', 'the observed name matches control_run exact-name lookup');
  assert.equal(r.controls[3].role, 'checkbox');
  assert.equal(r.controls[4].expanded, false, 'collapsed is known false');
});
