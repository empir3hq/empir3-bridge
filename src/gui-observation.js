'use strict';

// Focus-scoped captures refresh the focus lifetime and may add a grid. Keep
// those, annotations and every unknown GUI action on the control path.
function isPassiveGuiObservation(action, params = {}, focus = null) {
  if (action === 'position' || action === 'monitors') return true;
  if (action !== 'screenshot' || params.marker || params.grid) return false;
  const explicitMonitor = typeof params.monitor === 'string' && !!params.monitor.trim();
  return !(focus && !params.noFocus && !params.region && !explicitMonitor);
}

module.exports = {isPassiveGuiObservation};
