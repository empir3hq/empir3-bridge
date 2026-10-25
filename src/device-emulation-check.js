/**
 * Device-emulation consistency check.
 *
 * browser_emulate_device reported the preset it *requested* (390x844, touch
 * on) while the page could measure something else: innerWidth/innerHeight a
 * few CSS px short, and `navigator.maxTouchPoints` > 0 with
 * `'ontouchstart' in window` still false, because Chrome binds the touch
 * event handlers when a document is created — a page loaded before the
 * override was applied never gets them until it reloads. Feature detection
 * that mixes the two signals then disagrees with itself.
 *
 * This module turns a post-apply readback into an explicit verdict so the
 * agent knows whether the environment it asked for is the one it has, and
 * whether a reload is needed. Plain CommonJS for `node --test`.
 */

'use strict';

/**
 * @param {{width:number, height:number}} requested   the applied preset size
 * @param {{innerWidth?:number, innerHeight?:number, maxTouchPoints?:number, ontouchstart?:boolean}|null} measured
 *        values read from the page after the override was applied
 */
function emulationConsistency(requested, measured) {
  const width = Number(requested?.width);
  const height = Number(requested?.height);
  if (!measured || typeof measured !== 'object') {
    return {
      checked: false,
      viewportMatches: null,
      touchConsistent: null,
      reloadRequired: true,
      notes: ['The page could not be read back after applying the override; reload (browser_refresh) before relying on viewport or touch feature detection.'],
    };
  }
  const innerWidth = Number(measured.innerWidth);
  const innerHeight = Number(measured.innerHeight);
  const viewportMatches = innerWidth === width && innerHeight === height;
  const touchPoints = Number(measured.maxTouchPoints) || 0;
  const touchEvents = measured.ontouchstart === true;
  const touchConsistent = (touchPoints > 0) === touchEvents;
  const notes = [];
  if (!viewportMatches) {
    notes.push(`Page reports ${innerWidth}x${innerHeight} CSS px, not the requested ${width}x${height} (delta ${innerWidth - width}/${innerHeight - height}); reload so the new document lays out at the emulated size.`);
  }
  if (!touchConsistent) {
    notes.push(touchEvents
      ? 'Touch events are bound but navigator.maxTouchPoints is 0; reload to re-sync touch emulation.'
      : 'navigator.maxTouchPoints is set but window has no ontouchstart; Chrome binds touch handlers at document creation, so reload (browser_refresh) before touch feature detection.');
  }
  return {
    checked: true,
    viewportMatches,
    touchConsistent,
    delta: { width: innerWidth - width, height: innerHeight - height },
    reloadRequired: !viewportMatches || !touchConsistent,
    notes,
  };
}

module.exports = { emulationConsistency };
