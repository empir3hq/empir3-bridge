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
/**
 * Model-specific 'go log in again' phrasing. Everything else in the classifier
 * below is vendor-neutral and always was — only the login hint differs.
 */
const LOGIN_HINTS: Record<string, RegExp> = {
  grok: /\b(?:run|use) [`"']?grok login\b|\bgrok login --device-(?:code|auth)\b/,
  codex: /\bcodex login\b|\blog out and sign in again\b|\bplease try signing in again\b/,
  claude: /\bclaude login\b|\/login\b/,
  agy: /\bagy login\b|\bantigravity login\b/,
};

/**
 * Classify a CLI's output as an auth failure, for any lent CLI.
 *
 * This body was already vendor-neutral — '401 Unauthorized', 'failed to refresh
 * token', 'invalid_grant' are not Grok-specific strings — it was simply only
 * ever CALLED for Grok. On 2026-09-15 a codex run failed with
 *
 *   Failed to refresh token: 401 Unauthorized ... "code": "refresh_token_reused"
 *
 * which matches two of the rules below, and nothing recorded it: cli_status kept
 * reporting codex ready:true, and the Bridge UI kept showing a healthy login,
 * because `authenticated` for codex is a credentials-on-disk check that its own
 * comment admits cannot see expiry. Owner-confirmed.
 */
export function classifyCliAuthFailure(model: string, output: unknown): string | null {
  const base = classifyGrokAuthFailure(output);
  if (base) return base;
  const hint = LOGIN_HINTS[String(model || '').toLowerCase()];
  if (!hint) return null;
  const text = String(output || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  // A spend problem is not an auth problem; keep the same carve-out.
  if (/credit|quota|rate.?limit|usage.?limit|billing|subscription/.test(text)) return null;
  return hint.test(text) ? 'login_required' : null;
}

export function classifyGrokAuthFailure(output: unknown): string | null {
  const text = String(output || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  if (/credit|quota|rate.?limit|usage.?limit|billing|subscription|pending.?limit/.test(text)) return null;
  if (/\bnot signed in\b|\bnot logged in\b/.test(text)) return 'not_signed_in';
  if (/\b(?:authentication|authorization) (?:is )?required\b|\bunauthenticated\b/.test(text)) return 'authentication_required';
  if (/\bunauthori[sz]ed\b|\binvalid credentials?\b/.test(text)) return 'credentials_rejected';
  if (/\b(?:refresh|access|oauth) token\b.{0,80}\b(?:expired|invalid|revoked|rejected)\b/.test(text)) return 'token_rejected';
  // The definitive revocation signature observed live 2026-08-16: the CLI logs
  // `OIDC: token refresh HTTP error http_status=400 oauth2_error=Some("invalid_grant")`
  // when xAI has revoked the session family. Neither older pattern matched it
  // (the words arrive as "token refresh", not "refresh token"), so the badge
  // stayed green while every turn failed.
  if (/\binvalid_grant\b/.test(text)) return 'refresh_rejected';
  if (/\btoken refresh\b.{0,60}\b(?:error|failed|rejected)\b/.test(text)) return 'refresh_failed';
  if (/\bfailed to refresh\b.{0,80}\b(?:token|credentials?)\b/.test(text)) return 'refresh_failed';
  if (/\b(?:run|use) [`"']?grok login\b|\bgrok login --device-(?:code|auth)\b/.test(text)) return 'login_required';
  return null;
}
