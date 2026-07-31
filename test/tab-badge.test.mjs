/**
 * tab-badge — the "[Koba] title" grammar (0.3.46).
 *
 * Pinned: idempotency (stamping twice = stamping once), composition with the
 * overlay's presence prefixes (never "[Koba] ● Agent - x" stacking), name
 * sanitization (a name containing "]" cannot break the prefix grammar), and
 * that the in-page expression embeds the same behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeAgentName, applyBadge, badgeTitleExpression, MAX_AGENT_NAME } = require('../src/tab-badge.js');

test('sanitizeAgentName: strips brackets, collapses whitespace, caps length', () => {
  assert.equal(sanitizeAgentName('Koba'), 'Koba');
  assert.equal(sanitizeAgentName('  Dr.   Park  '), 'Dr. Park');
  assert.equal(sanitizeAgentName('K]ob[a'), 'Koba', 'brackets cannot break the prefix grammar');
  assert.equal(sanitizeAgentName('x'.repeat(60)).length, MAX_AGENT_NAME);
  assert.equal(sanitizeAgentName(null), '');
  assert.equal(sanitizeAgentName(42), '42');
});

test('applyBadge is idempotent and replaces a different agent\'s badge', () => {
  assert.equal(applyBadge('Empir3 — AI Team', 'Koba'), '[Koba] Empir3 — AI Team');
  assert.equal(applyBadge('[Koba] Empir3 — AI Team', 'Koba'), '[Koba] Empir3 — AI Team');
  assert.equal(applyBadge('[Zara] Empir3 — AI Team', 'Koba'), '[Koba] Empir3 — AI Team');
});

test('applyBadge composes with the overlay presence prefixes instead of stacking', () => {
  assert.equal(applyBadge('● Agent - Dashboard', 'Zara'), '[Zara] Dashboard');
  assert.equal(applyBadge('◎ Focus - Dashboard', 'Zara'), '[Zara] Dashboard');
});

test('applyBadge with no usable name just strips', () => {
  assert.equal(applyBadge('[Koba] Dashboard', ''), 'Dashboard');
  assert.equal(applyBadge('Dashboard', null), 'Dashboard');
});

test('badgeTitleExpression embeds the sanitized name and no-ops when empty', () => {
  const expr = badgeTitleExpression('Koba');
  assert.match(expr, /"Koba"/);
  assert.match(expr, /document\.title/);
  assert.equal(badgeTitleExpression(''), ';');
  assert.equal(badgeTitleExpression('[]'), ';', 'a name that sanitizes to nothing produces a no-op');
});
