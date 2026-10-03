import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewportClip } from '../src/screenshotClip.ts';

// 2026-09-12: browser_screenshot returned a flat frame after any programmatic
// scroll. Proven live via CDP on a 1440x675 @2x tab at scrollY 2045: a clip at
// {0,0} gave 9,744 bytes of one colour, the scroll-offset clip 39,407 bytes of
// page. The clip must follow the scroll.
test('capped screenshot clip follows the scroll position', () => {
  const clip = viewportClip({ w: 1440, h: 675, dpr: 2, sx: 0, sy: 2045 }, 0.625);
  assert.deepEqual(clip, { x: 0, y: 2045, width: 1440, height: 675, scale: 0.625 });
  assert.notEqual(clip.y, 0, 'a scrolled page must not clip at the document top');
});

test('unscrolled page clips at the origin, missing or bad scroll values clamp to 0', () => {
  assert.deepEqual(viewportClip({ w: 390, h: 844 }, 1), { x: 0, y: 0, width: 390, height: 844, scale: 1 });
  assert.deepEqual(viewportClip({ w: 390, h: 844, sx: -3, sy: NaN }, 1), { x: 0, y: 0, width: 390, height: 844, scale: 1 });
  assert.deepEqual(viewportClip({ w: 1000, h: 500, sx: 120.5, sy: 33 }, 0.5), { x: 120.5, y: 33, width: 1000, height: 500, scale: 0.5 });
});
