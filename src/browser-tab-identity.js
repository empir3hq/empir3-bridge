'use strict';

// This is a second boundary on the device itself. The app's cached inventory
// cannot guarantee which tabs are still open when an input reaches Chrome.
const INPUT_ACTIONS = new Set(['click','click_xy','click_ref','click_selector','type','type_ref','type_selector','press','scroll','tap','swipe','control_run','run_checks','play','record_play','evaluate','accuracy_lab_sweep','dialog']);
function createBrowserTabIdentityGuard() {
  const opened = new Map();
  function prune(tabs) {
    const live = new Set(tabs.map(t => t.targetId).filter(Boolean));
    for (const [id] of opened) if (!live.has(id)) opened.delete(id);
  }
  function check(action, params, state, scope) {
    prune(state.tabs || []);
    if (!INPUT_ACTIONS.has(action)) return null;
    const tabs = (state.tabs || []).filter(t => typeof t.targetId === 'string' && t.targetId);
    const id = params?.target?.surface === 'browser' ? params.target.tabId : params?.tabId || params?.targetId;
    let reason;
    if (!id && tabs.length > 1) reason = `no target tab was given and ${tabs.length} tabs are open`;
    else if (id && opened.get(id) !== scope) {
      const origin = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin : ''; } catch { return ''; } };
      const site = origin(tabs.find(t => t.targetId === id)?.url);
      if (site && tabs.some(t => t.targetId !== id && origin(t.url) === site)) reason = 'the target was not opened by this agent and another tab is open on the same site';
    }
    return reason ? { success: false, code: 'browser_tab_identity_required', inputMayHaveOccurred: false,
      error: `Input stopped: ${reason}. Use tab_open for a separate work tab, then pass its returned target to input calls.`,
      guard: 'runtime.browserTabIdentityGuard' } : null;
  }
  return { check, prune, remember: (scope, id) => { if (id) opened.set(id, scope); }, forget: id => opened.delete(id), clear: () => opened.clear(), isInput: action => INPUT_ACTIONS.has(action) };
}
module.exports = { createBrowserTabIdentityGuard };
