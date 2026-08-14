import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGrokAuthFailure,
  invalidCliAuthLiveness,
  normalizeCliAuthLivenessRecord,
  unverifiedCliAuthLiveness,
  verifiedCliAuthLiveness,
} from '../src/cli-auth-liveness.ts';

const at = new Date('2026-08-14T12:34:56.000Z');

test('auth liveness records normalize untrusted persisted data', () => {
  assert.deepEqual(normalizeCliAuthLivenessRecord({
    status: 'verified',
    lastVerifiedAt: '2026-08-14T12:34:56Z',
    lastCheckAt: 'not-a-date',
    source: ' manual_probe ',
    reason: 42,
  }), {
    status: 'verified',
    lastVerifiedAt: '2026-08-14T12:34:56.000Z',
    lastInvalidatedAt: null,
    lastCheckAt: null,
    source: 'manual_probe',
    reason: null,
  });
  assert.equal(normalizeCliAuthLivenessRecord({ status: 'invented' }).status, 'unverified');
});

test('auth liveness builders distinguish proof, invalidation, and owner action', () => {
  assert.deepEqual(verifiedCliAuthLiveness(at, 'manual_probe'), {
    status: 'verified',
    lastVerifiedAt: at.toISOString(),
    lastInvalidatedAt: null,
    lastCheckAt: at.toISOString(),
    source: 'manual_probe',
    reason: null,
  });
  assert.equal(invalidCliAuthLiveness(at, 'not_signed_in').status, 'needs_reauth');
  assert.equal(invalidCliAuthLiveness(at, 'not_signed_in').lastInvalidatedAt, at.toISOString());
  assert.equal(unverifiedCliAuthLiveness(at, 'verification_required').status, 'unverified');
  assert.equal(unverifiedCliAuthLiveness(at, 'verification_required').lastCheckAt, at.toISOString());
});

test('Grok auth classifier recognizes credential failures without relabeling billing failures', () => {
  assert.equal(classifyGrokAuthFailure('Not signed in. Run: grok login --device-code'), 'not_signed_in');
  assert.equal(classifyGrokAuthFailure('Authentication required before continuing'), 'authentication_required');
  assert.equal(classifyGrokAuthFailure('OAuth token was revoked by the provider'), 'token_rejected');
  assert.equal(classifyGrokAuthFailure('Use grok login to continue'), 'login_required');
  assert.equal(classifyGrokAuthFailure('You have run out of credits or need a Grok subscription'), null);
  assert.equal(classifyGrokAuthFailure('personal-team-blocked:pending-limit'), null);
  assert.equal(classifyGrokAuthFailure('HTTP 429 rate limit'), null);
});
