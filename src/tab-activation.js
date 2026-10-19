/**
 * Browser tab activation — verified, not assumed.
 *
 * bridge_control_activate and browser_tab_focus action:"control" used to
 * return success:true as soon as the CDP layer had been *asked* to switch
 * tabs. When the switch had not landed yet (or at all), the next
 * browser_evaluate still ran against the old tab while the receipt claimed
 * control. The flags on the returned tab were also computed from whatever
 * tab list happened to be current at the moment, so two identical calls
 * could disagree.
 *
 * This module owns the decision: after asking the bridge to switch, re-read
 * the tab list until the bridge's current target IS the requested tab (or a
 * short settle window expires) and report `switched` truthfully. The flags
 * on the returned tab are derived from that same final readback, so they
 * are stable across repeated calls for the same state.
 *
 * Plain CommonJS so `node --test` can import it without a TS loader.
 */

'use strict';

const ACTIVATION_SETTLE_MS = 1500;
const ACTIVATION_POLL_MS = 100;

function sameTab(a, b) {
  if (!a || !b) return false;
  if (a.targetId && b.targetId) return a.targetId === b.targetId;
  return !!(a.url && b.url && a.url === b.url);
}

/**
 * Enrich raw tab entries with the ownership flags every consumer reads, and
 * surface the agent-controlled tab as `agentTab` (singular) so callers do not
 * have to scan the list. `agentTabs` (plural) is the per-agent ownership map
 * from browser_tab_open and is legitimately empty when no agent has opened
 * its own tab; the two fields answer different questions.
 */
function enrichTabState({ tabs, currentTargetId, agentControlTarget, userFocusTarget, agentTabs }) {
  const current = String(currentTargetId || '');
  const enriched = (Array.isArray(tabs) ? tabs : []).map((t) => ({
    ...t,
    agentControlled: sameTab(t, agentControlTarget),
    userFocused: sameTab(t, userFocusTarget),
    bridgeCurrent: !!(current && t.targetId === current),
  }));
  return {
    currentTargetId: current,
    tabs: enriched,
    agentTab: enriched.find((t) => t.agentControlled) || null,
    agentTabs: Array.isArray(agentTabs) ? agentTabs : [],
  };
}

/**
 * Did the bridge actually switch to `targetId`?
 * @param {{tabs:Array<{targetId:string}>, currentTargetId:string}} state  fresh tab list
 * @param {string} targetId
 */
function activationOutcome(state, targetId) {
  const wanted = String(targetId || '');
  const current = String(state?.currentTargetId || '');
  const tab = (Array.isArray(state?.tabs) ? state.tabs : []).find((t) => t.targetId === wanted) || null;
  if (!tab) {
    return { switched: false, currentTargetId: current, tab: null, error: `target_closed: tab ${wanted || '(none)'} is no longer open; choose a live tab from browser_tab_state.` };
  }
  const switched = !!wanted && current === wanted;
  return {
    switched,
    currentTargetId: current,
    tab,
    error: switched
      ? undefined
      : `activation_unverified: the bridge is still on ${current || 'no tab'} instead of ${wanted}. Retry browser_tab_focus action:"control" or read browser_tab_state before input.`,
  };
}

/**
 * Poll `readState()` until the bridge reports `targetId` as current, or the
 * settle window elapses. Returns the final activationOutcome either way.
 */
async function waitForActivation(readState, targetId, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : ACTIVATION_SETTLE_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : ACTIVATION_POLL_MS;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + settleMs;
  let outcome = activationOutcome(await readState(), targetId);
  while (!outcome.switched && outcome.tab && now() < deadline) {
    await sleep(pollMs);
    outcome = activationOutcome(await readState(), targetId);
  }
  return outcome;
}

/** Find a remembered target in a fresh tab list by exact targetId, else by URL. */
function findTabTarget(tabs, raw) {
  const targetId = String(raw?.targetId || raw?.id || '').trim();
  const url = String(raw?.url || raw?.href || '').trim();
  const list = Array.isArray(tabs) ? tabs : [];
  if (targetId) {
    const byId = list.find((t) => t.targetId === targetId);
    return byId ? { ...byId, source: raw?.source || byId.source } : null;
  }
  if (url) {
    const byUrl = list.find((t) => t.url === url);
    if (byUrl) return { ...byUrl, source: raw?.source || byUrl.source };
  }
  return null;
}

/**
 * Reconcile remembered agent/user targets against the live tab list after a
 * Chrome relaunch (Work Board 7e4b39ab): a targetId that no longer exists is
 * dropped rather than kept as a pointer to a dead tab, and when no agent
 * target survives the bridge-current tab becomes the agent target unless the
 * user has explicitly claimed it. browser_tab_focus action:"show_agent" then
 * has a live tab to raise instead of throwing "Target … not found".
 */
function reconcileTabTargets({ tabs, currentTargetId, agentControlTarget, userFocusTarget, now }) {
  const list = Array.isArray(tabs) ? tabs : [];
  let agent = agentControlTarget ? findTabTarget(list, agentControlTarget) : null;
  const user = userFocusTarget ? findTabTarget(list, userFocusTarget) : null;
  const droppedAgent = !!agentControlTarget && !agent;
  let fellBack = false;
  const current = String(currentTargetId || '');
  if (!agent && current) {
    const currentTab = list.find((t) => t.targetId === current);
    const userHoldsCurrent = !!user && user.targetId === current;
    if (currentTab && !userHoldsCurrent) {
      agent = { ...currentTab, source: 'bridge-current', updatedAt: (now || (() => new Date()))().toISOString() };
      fellBack = true;
    }
  }
  return { agentControlTarget: agent, userFocusTarget: user, droppedAgent, fellBack };
}

module.exports = { enrichTabState, activationOutcome, waitForActivation, findTabTarget, reconcileTabTargets, ACTIVATION_SETTLE_MS, ACTIVATION_POLL_MS };
