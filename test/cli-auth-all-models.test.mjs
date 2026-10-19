/**
 * Auth truth is reported for every lent CLI, not just Grok — smoke 2026-09-15.
 *
 * OWNER-CONFIRMED SPECIMEN. The Bridge UI showed codex signed in, lent and fine
 * while its OAuth token was dead, and `cli_status` agreed: authenticated:true,
 * ready:true, blocker:null. The real state was in the run transcript:
 *
 *   ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized
 *   "code": "refresh_token_reused"
 *   "Your refresh token has already been used ... Please try signing in again."
 *
 * The decisive detail: cli_status returned IDENTICAL output before and after the
 * owner re-authenticated. Its answer was invariant to whether the tool worked,
 * because codex's `authenticated` is a credentials-on-disk check whose own
 * comment says it "stays structural" and cannot see expiry.
 *
 * The machinery to fix it already existed and was generic — the liveness record,
 * the per-model settings map, the verified/invalid constructors — and the
 * classifier below was never Grok-specific in the first place. It was simply
 * only ever CALLED for Grok. These tests pin that it now answers for all four.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import sourceModule1 from '../src/cli-auth-liveness.ts';
const { classifyCliAuthFailure, classifyGrokAuthFailure } = sourceModule1;

/** Verbatim from the incident transcript. */
const CODEX_DEAD_TOKEN =
  '2026-09-15T18:40:24.165616Z ERROR codex_login::auth::manager: Failed to refresh token: ' +
  '401 Unauthorized: { "error": { "message": "Your refresh token has already been used to ' +
  'generate a new access token. Please try signing in again.", "code": "refresh_token_reused" } }';

test('THE SPECIMEN: the codex dead-token output is classified as an auth failure', () => {
  const verdict = classifyCliAuthFailure('codex', CODEX_DEAD_TOKEN);
  assert.ok(verdict, 'must not return null — this is the failure that went unrecorded');
  assert.equal(typeof verdict, 'string');
});

test('the classifier body was ALREADY vendor-neutral — it was only ever called for Grok', () => {
  // This is the point of the whole change: nothing new had to be taught. The
  // same text fed to the old Grok-only entry point classifies identically.
  assert.equal(
    classifyGrokAuthFailure(CODEX_DEAD_TOKEN),
    classifyCliAuthFailure('codex', CODEX_DEAD_TOKEN),
  );
});

test('a spend problem is never mistaken for an auth problem', () => {
  for (const model of ['codex', 'grok', 'claude', 'agy']) {
    assert.equal(
      classifyCliAuthFailure(model, 'You have exceeded your monthly quota. Upgrade your billing plan.'),
      null,
      `${model}: quota is not auth`,
    );
    assert.equal(
      classifyCliAuthFailure(model, 'Rate limit reached, please retry in 30s'),
      null,
      `${model}: rate limit is not auth`,
    );
  }
});

test('an ordinary successful run is not an auth failure', () => {
  for (const model of ['codex', 'grok', 'claude', 'agy']) {
    assert.equal(classifyCliAuthFailure(model, 'thinking... done. wrote 3 files.'), null, model);
    assert.equal(classifyCliAuthFailure(model, ''), null, `${model}: empty output`);
  }
});

test('each CLI\'s own re-login phrasing is recognised', () => {
  assert.equal(classifyCliAuthFailure('codex', 'Please run codex login to continue'), 'login_required');
  assert.equal(classifyCliAuthFailure('claude', 'Session ended. Run /login to sign in.'), 'login_required');
  assert.equal(classifyCliAuthFailure('agy', 'not authorised; run agy login'), 'login_required');
});

test('a model with no login hint falls back to the neutral rules, not to a guess', () => {
  // An unknown model must never be *more* eager to declare an auth failure.
  assert.equal(classifyCliAuthFailure('someFutureCli', 'wrote 2 files'), null);
  assert.ok(classifyCliAuthFailure('someFutureCli', '401 Unauthorized'), 'neutral rules still apply');
});

test('the login hint cannot fire on a quota message that happens to mention login', () => {
  assert.equal(
    classifyCliAuthFailure('codex', 'Your subscription expired — visit billing, then codex login'),
    null,
    'billing wording wins; this is a spend problem, not a dead token',
  );
});

test('regex escapes survived the edit — no control characters in the patterns', async () => {
  // Written after a real incident in this session: a scripted edit wrote literal
  // backspace characters (0x08) where \b was intended, and tsc compiled it
  // happily. A passing typecheck is not evidence that a regex says what you meant.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/cli-auth-liveness.ts', import.meta.url), 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(src), false, 'control character found in source');
});
