'use strict';

// One registry for the local operator UI and all control transports. Bounds
// are supported ranges; defaults retain the behavior tested in 0.3.112.
const CONTROL_LIMIT_DEFS = Object.freeze(Object.fromEntries([
  ['planSteps', 'Workflow step limit', 32, 1, 256, 'steps', 'Workflow', 'Maximum actions accepted in one verified workflow.'],
  ['planTimeoutMs', 'Workflow time limit', 60000, 100, 300000, 'ms', 'Workflow', 'Default and maximum time for one workflow. Input is never retried automatically.'],
  ['stepTimeoutMs', 'Verification wait limit', 15000, 0, 60000, 'ms', 'Workflow', 'Maximum wait requested by an individual step. The workflow deadline still applies.'],
  ['stepDefaultTimeoutMs', 'Default verification wait', 5000, 0, 60000, 'ms', 'Workflow', 'Used when a step does not specify its own wait; capped by the verification wait limit.'],
  ['pollIntervalMs', 'Verification polling interval', 100, 10, 2000, 'ms', 'Workflow', 'Time between observations while waiting for an expected result.'],
  ['textCharacters', 'Text input limit', 100000, 1, 1000000, 'characters', 'Workflow', 'Maximum literal text in a fill or native typing action.'],
  ['scrollNotches', 'Native scroll limit', 100, 1, 1000, 'notches', 'Workflow', 'Largest absolute wheel movement accepted in one action.'],
  ['shortcutKeys', 'Shortcut key limit', 8, 1, 16, 'keys', 'Workflow', 'Maximum simultaneous keys in a shortcut.'],
  ['recordingSteps', 'Recording action limit', 2000, 1, 10000, 'steps', 'Recordings', 'Maximum actions accepted for a recording; a caller can request fewer.'],
  ['recordingTimeoutMs', 'Verified playback time limit', 120000, 1000, 900000, 'ms', 'Recordings', 'Includes time paused during verified recording playback.'],
  ['nativeTimeoutMs', 'Native command time limit', 30000, 1000, 120000, 'ms', 'Native control', 'Default timeout for the native worker. Specialized operations use the limits below.'],
  ['workerStartupTimeoutMs', 'Native worker startup limit', 30000, 100, 120000, 'ms', 'Native control', 'Time for PowerShell and native libraries to become ready before any action is dispatched. Action deadlines start after startup.'],
  ['nativeActivationAckMs', 'Window activation acknowledgement', 1000, 50, 5000, 'ms', 'Native control', 'Bounded wait for a window response and safe caption search. Unresponsive windows receive no activation click.'],
  ['nativeActivationSearchPoints', 'Window activation caption search', 300, 3, 1200, 'points', 'Native control', 'Maximum candidate title-bar points examined before refusing activation. Client areas and window buttons are never clicked.'],
  ['nativeQuickTimeoutMs', 'Native shortcut and activation timeout', 8000, 1000, 120000, 'ms', 'Native control', 'Deadline for window activation, scrolling and shortcuts.'],
  ['nativeTextTimeoutMs', 'Native text command timeout', 15000, 1000, 120000, 'ms', 'Native control', 'Outer deadline for native text and semantic control operations.'],
  ['nativeTargetTimeoutMs', 'Native target check timeout', 4000, 100, 30000, 'ms', 'Native control', 'Deadline for confirming a native window is available.'],
  ['nativeReadTimeoutMs', 'Native verification read timeout', 5000, 100, 30000, 'ms', 'Native control', 'Deadline for reading back a native field value.'],
  ['nativeCaptureTimeoutMs', 'Native image capture timeout', 10000, 1000, 60000, 'ms', 'Native control', 'Deadline for capturing the selected window.'],
  ['nativeTextDeadlineMs', 'Unicode typing deadline', 10000, 100, 120000, 'ms', 'Native control', 'Stops a partial Unicode typing operation at this deadline. The outer text command deadline can stop it sooner.'],
  ['editorAckTimeoutMs', 'Editor acknowledgement timeout', 1000, 50, 10000, 'ms', 'Native control', 'Wait for Notepad to acknowledge a selection insertion. Never resends uncertain input.'],
  ['cursorAckTimeoutMs', 'Cursor acknowledgement timeout', 200, 10, 1000, 'ms', 'Native control', 'Wait for Windows to report the requested cursor position. Returns immediately on acknowledgement; unexpected movement still cancels immediately.'],
  ['snapshotLifetimeMs', 'Native observation lifetime', 30000, 100, 30000, 'ms', 'Native control', 'Maximum age of an actionable native reference. Checked again after queueing.'],
  ['ancestorDepth', 'Native target ancestor search', 10, 1, 30, 'levels', 'Native control', 'Maximum parent search when checking a hit-tested control.'],
  ['boundsTolerancePx', 'Observed bounds tolerance', 1, 0, 1, 'px', 'Native control', 'Allowed bounds drift before requiring a fresh observation.'],
  ['cursorTolerancePx', 'User cursor movement tolerance', 4, 0, 4, 'px', 'Native control', 'Unexpected movement beyond this distance cancels input.'],
  ['workerQueue', 'Native worker queue limit', 32, 1, 128, 'requests', 'Native control', 'Reject additional work when this many requests are waiting.'],
  ['workerResponseChars', 'Native worker response limit', 33554432, 65536, 67108864, 'characters', 'Native control', 'Maximum buffered worker reply before the worker stops.'],
  ['browserTextCharacters', 'Browser observation text limit', 12000, 100, 100000, 'characters', 'Observations', 'Text included in a focused browser observation.'],
  ['browserElements', 'Browser observation control limit', 300, 1, 2000, 'controls', 'Observations', 'Maximum controls included in a focused browser observation.'],
  ['browserNameCharacters', 'Browser control name limit', 120, 20, 1000, 'characters', 'Observations', 'Maximum text used as a fallback control name.'],
  ['nativeValueCharacters', 'Native snapshot value limit', 2048, 64, 32768, 'characters', 'Observations', 'Longer native values are marked truncated in observations.'],
  ['nativeElements', 'Default native observation controls', 200, 20, 500, 'controls', 'Observations', 'Default control count for focused native observations.'],
  ['imageWidth', 'Default observation image width', 1600, 320, 2560, 'px', 'Observations', 'Image width when the caller does not choose one.'],
  ['moveMinMs', 'Pointer travel base duration', 80, 0, 500, 'ms', 'Pointer motion', 'Base travel time before adding distance-based motion. Reduced motion still wins.'],
  ['moveMaxMs', 'Pointer travel maximum duration', 260, 0, 1000, 'ms', 'Pointer motion', 'Caps automatic travel time; zero makes automatic travel immediate.'],
  ['moveDistanceFactor', 'Pointer travel distance factor', 5, 0, 20, 'factor', 'Pointer motion', 'Added duration is this factor times the square root of travel distance in pixels.'],
  ['moveArcPx', 'Pointer travel curve limit', 12, 0, 40, 'px', 'Pointer motion', 'Maximum gentle bend during travel. Held-button dragging stays straight.'],
  ['moveFrameMs', 'Native pointer frame interval', 8, 1, 32, 'ms', 'Pointer motion', 'Time between movement updates; endpoints and cancellation checks remain exact.'],
  ['doubleClickIntervalMs', 'Native double-click interval', 60, 10, 200, 'ms', 'Native control', 'Time between the two clicks of an explicit double-click.'],
  ['browserNavigationTimeoutMs', 'Browser navigation timeout', 20000, 1000, 120000, 'ms', 'Workflow', 'Deadline for a requested page navigation.'],
  ['browserGeometryTimeoutMs', 'Browser cursor geometry timeout', 3000, 100, 30000, 'ms', 'Pointer motion', 'Deadline for locating the browser content area before showing its pointer.'],
  ['pointerFeedbackMs', 'Native action pointer duration', 2000, 100, 10000, 'ms', 'Pointer motion', 'Default time to display the action pointer.'],
  ['pointerHoldMs', 'Pointer hold after input', 900, 0, 5000, 'ms', 'Pointer motion', 'How long the visible pointer remains after an action.'],
  ['browserPointerHoldMs', 'Browser pointer duration', 1600, 100, 10000, 'ms', 'Pointer motion', 'How long browser input feedback remains visible.'],
  ['browserPointerSettleMs', 'Browser pointer lead time', 100, 0, 1000, 'ms', 'Pointer motion', 'Time to show the pointer over a browser target before input.'],
  ['pointerPulseMs', 'Click pulse duration', 260, 50, 1000, 'ms', 'Pointer motion', 'Length of the visible click pulse; reduced motion disables it.'],
  ['presenceHoldMs', 'Observed region border duration', 6000, 100, 30000, 'ms', 'Pointer motion', 'How long to show the border for an observed native region.'],
].map(([key, label, value, min, max, unit, category, description]) => [key, Object.freeze({key, label, default:value, min, max, unit, category, description})])));
const DEFAULT_CONTROL_LIMITS = Object.freeze(Object.fromEntries(Object.values(CONTROL_LIMIT_DEFS).map(d => [d.key, d.default])));
let read = () => ({});
function setControlLimitsReader(reader) { read = reader; }
function resolveControlLimits(values = {}) {
  return Object.fromEntries(Object.values(CONTROL_LIMIT_DEFS).map(d => {
    const v = values?.[d.key];
    return [d.key, typeof v === 'number' && Number.isFinite(v) && v >= d.min && v <= d.max && (d.key === 'moveDistanceFactor' || Number.isInteger(v)) ? v : d.default];
  }));
}
function getControlLimits() { return resolveControlLimits(read()); }
function patchControlLimits(current = {}, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Control limits must be an object.');
  const next = {...current};
  for (const [key, value] of Object.entries(patch)) {
    const d = CONTROL_LIMIT_DEFS[key];
    if (!Object.hasOwn(CONTROL_LIMIT_DEFS, key)) throw new Error(`Unknown control limit: ${key}`);
    if (value === null) { delete next[key]; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < d.min || value > d.max || (key !== 'moveDistanceFactor' && !Number.isInteger(value))) throw new Error(`${d.label} must be ${d.min}–${d.max} ${d.unit}.`);
    next[key] = value;
  }
  return next;
}
module.exports = {CONTROL_LIMIT_DEFS, DEFAULT_CONTROL_LIMITS, setControlLimitsReader, resolveControlLimits, getControlLimits, patchControlLimits};
