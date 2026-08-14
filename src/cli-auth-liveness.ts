export type CliAuthVerificationStatus = 'unverified' | 'verified' | 'needs_reauth';

export interface CliAuthLivenessRecord {
  status: CliAuthVerificationStatus;
  lastVerifiedAt: string | null;
  lastInvalidatedAt: string | null;
  lastCheckAt: string | null;
  source: string | null;
  reason: string | null;
}

const EMPTY_AUTH_LIVENESS: CliAuthLivenessRecord = {
  status: 'unverified',
  lastVerifiedAt: null,
  lastInvalidatedAt: null,
  lastCheckAt: null,
  source: null,
  reason: null,
};

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeCliAuthLivenessRecord(raw: unknown): CliAuthLivenessRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_AUTH_LIVENESS };
  const value = raw as Record<string, unknown>;
  const status: CliAuthVerificationStatus = value.status === 'verified' || value.status === 'needs_reauth'
    ? value.status
    : 'unverified';
  return {
    status,
    lastVerifiedAt: isoOrNull(value.lastVerifiedAt),
    lastInvalidatedAt: isoOrNull(value.lastInvalidatedAt),
    lastCheckAt: isoOrNull(value.lastCheckAt),
    source: typeof value.source === 'string' && value.source.trim() ? value.source.trim().slice(0, 64) : null,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim().slice(0, 96) : null,
  };
}

export function verifiedCliAuthLiveness(
  now = new Date(),
  source = 'successful_turn',
): CliAuthLivenessRecord {
  const timestamp = now.toISOString();
  return {
    status: 'verified',
    lastVerifiedAt: timestamp,
    lastInvalidatedAt: null,
    lastCheckAt: timestamp,
    source,
    reason: null,
  };
}

export function invalidCliAuthLiveness(
  now = new Date(),
  reason = 'credentials_rejected',
): CliAuthLivenessRecord {
  const timestamp = now.toISOString();
  return {
    status: 'needs_reauth',
    lastVerifiedAt: null,
    lastInvalidatedAt: timestamp,
    lastCheckAt: timestamp,
    source: 'provider_error',
    reason,
  };
}

export function unverifiedCliAuthLiveness(
  now = new Date(),
  reason = 'verification_required',
): CliAuthLivenessRecord {
  return {
    status: 'unverified',
    lastVerifiedAt: null,
    lastInvalidatedAt: null,
    lastCheckAt: now.toISOString(),
    source: 'owner_action',
    reason,
  };
}

/**
 * Classifies only credential failures. Quota, subscription, usage-limit, and
 * billing failures deliberately stay out: re-authentication cannot repair
 * those and the Bridge must not send the owner through a pointless login loop.
 */
export function classifyGrokAuthFailure(output: unknown): string | null {
  const text = String(output || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  if (/credit|quota|rate.?limit|usage.?limit|billing|subscription|pending.?limit/.test(text)) return null;
  if (/\bnot signed in\b|\bnot logged in\b/.test(text)) return 'not_signed_in';
  if (/\b(?:authentication|authorization) (?:is )?required\b|\bunauthenticated\b/.test(text)) return 'authentication_required';
  if (/\bunauthori[sz]ed\b|\binvalid credentials?\b/.test(text)) return 'credentials_rejected';
  if (/\b(?:refresh|access|oauth) token\b.{0,80}\b(?:expired|invalid|revoked|rejected)\b/.test(text)) return 'token_rejected';
  if (/\bfailed to refresh\b.{0,80}\b(?:token|credentials?)\b/.test(text)) return 'refresh_failed';
  if (/\b(?:run|use) [`"']?grok login\b|\bgrok login --device-(?:code|auth)\b/.test(text)) return 'login_required';
  return null;
}
