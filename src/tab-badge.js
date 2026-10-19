/**
 * tab-badge — the "[Koba] page title" who's-driving badge (0.3.46).
 *
 * One place owns the prefix grammar so the three writers can never drift:
 *   - bridge.ts stamps via evaluateOnTarget (works on tabs with no overlay),
 *   - the overlay's presence system re-renders titles on every tab_state
 *     update (it would otherwise wipe a stamped prefix),
 *   - re-stamps fire on navigation (titles reset when a page loads).
 *
 * Grammar: `[<name>] <title>` where <name> is 1–24 chars with no `]`.
 * Idempotent by construction: applying strips any existing badge AND the
 * overlay's presence prefixes (`● Agent - ` / `◎ Focus - `) before
 * prepending, so repeated stamps and overlay/bridge interleaving converge on
 * one clean prefix instead of stacking.
 */

'use strict';

/** Existing badge at the start of a title. */
const BADGE_PREFIX_RE = /^\[[^\]]{1,24}\] /;
/** The overlay presence prefixes a badge must compose with, not stack on. */
const PRESENCE_PREFIX_RE = /^(?:● [^-]{1,30} - |◎ Focus - )/;

/** Max badge name length — a Chrome tab shows ~25 chars total. */
const MAX_AGENT_NAME = 24;

function sanitizeAgentName(name) {
  const clean = String(name || '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AGENT_NAME);
  return clean;
}

/** Pure form of the stamp: what the in-page expression computes. */
function applyBadge(title, agentName) {
  const name = sanitizeAgentName(agentName);
  const stripped = String(title || '')
    .replace(BADGE_PREFIX_RE, '')
    .replace(PRESENCE_PREFIX_RE, '');
  if (!name) return stripped;
  return `[${name}] ${stripped}`;
}

/**
 * Self-contained in-page expression for evaluateOnTarget. Regexes are
 * serialized from the SAME constants above — the in-page behavior cannot
 * drift from applyBadge(). No-op when the title already carries this badge.
 */
function badgeTitleExpression(agentName) {
  const name = sanitizeAgentName(agentName);
  if (!name) return ';';
  return `(() => {
    const name = ${JSON.stringify(name)};
    const prefix = '[' + name + '] ';
    let t = document.title || '';
    if (t.indexOf(prefix) === 0) return;
    t = t.replace(${BADGE_PREFIX_RE.toString()}, '').replace(${PRESENCE_PREFIX_RE.toString()}, '');
    document.title = prefix + t;
  })()`;
}

module.exports = {
  BADGE_PREFIX_RE,
  PRESENCE_PREFIX_RE,
  MAX_AGENT_NAME,
  sanitizeAgentName,
  applyBadge,
  badgeTitleExpression,
};
