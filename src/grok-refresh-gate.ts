import { readFileSync } from 'fs';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Freshness-gated admission for the Grok channel pool.
 *
 * Grok refresh tokens are single-use with reuse detection. Concurrent isolated
 * turns each hold a COPY of ~/.grok/auth.json; if two of them cross an
 * access-token expiry, both try to spend the same refresh token and xAI revokes
 * the whole session family. The rule that prevents that without giving up the
 * pool: parallel use of a VALID access token is normal client behavior, so
 * admit concurrently while the shared token has comfortable lifetime; once
 * expiry is inside the margin, collapse admission to exactly one turn — that
 * solo CLI performs the rotation, an eager watcher persists the rotated token
 * to the real home the moment it appears, and the pool reopens with every new
 * turn copying the NEW token.
 *
 * The auth store shape (observed 2026-08-16) is a keyed credential map:
 * `{"https://auth.x.ai::<uuid>": {expires_at: ISO-8601, key: <JWT>,
 * refresh_token, ...}}`. `expires_at` is the primary freshness source; the
 * JWT's `exp` claim is the fallback. No token material is ever logged.
 */

export const DEFAULT_GROK_REFRESH_MARGIN_MS = 5 * 60_000;
export const GROK_AUTH_FAILURE_LATCH_MS = 60_000;
const DEFAULT_FRESHNESS_CACHE_MS = 2_000;
const DEFAULT_WATCH_INTERVAL_MS = 1_500;
const WINDOWS_REPLACE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 160, 160];

export interface GrokAuthFreshness {
  expiresAtMs: number | null;
  source: 'expires_at' | 'jwt_exp' | null;
}

function decodeJwtExpMs(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
    );
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp < 1e12 ? exp * 1000 : exp;
  } catch {
    return null;
  }
}

/** Earliest expiry across every credential entry in the auth store. */
export function parseGrokAuthFreshness(raw: string): GrokAuthFreshness {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { expiresAtMs: null, source: null };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { expiresAtMs: null, source: null };
  let earliest: number | null = null;
  let source: GrokAuthFreshness['source'] = null;
  for (const entry of Object.values(data)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    let expiresMs: number | null = null;
    let entrySource: GrokAuthFreshness['source'] = null;
    if (typeof value.expires_at === 'string') {
      const parsed = Date.parse(value.expires_at);
      if (Number.isFinite(parsed)) {
        expiresMs = parsed;
        entrySource = 'expires_at';
      }
    }
    if (expiresMs === null) {
      const fromJwt = decodeJwtExpMs(value.key);
      if (fromJwt !== null) {
        expiresMs = fromJwt;
        entrySource = 'jwt_exp';
      }
    }
    if (expiresMs !== null && (earliest === null || expiresMs < earliest)) {
      earliest = expiresMs;
      source = entrySource;
    }
  }
  return { expiresAtMs: earliest, source };
}

interface AtomicWriteOptions {
  renameFile?: typeof rename;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function atomicWrite(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const renameFile = options.renameFile || rename;
  const platform = options.platform || process.platform;
  const wait = options.wait || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await renameFile(tempPath, path);
        break;
      } catch (error: any) {
        const retryable = platform === 'win32'
          && WINDOWS_REPLACE_RETRY_CODES.has(error?.code)
          && attempt < WINDOWS_REPLACE_RETRY_DELAYS_MS.length;
        if (!retryable) throw error;
        // Defender, search indexing, and sync clients can briefly hold the
        // destination after reading it. Preserve the current credential file
        // and retry the atomic replacement instead of losing a rotated token.
        await wait(WINDOWS_REPLACE_RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

// Serializes auth write-backs across concurrent turn cleanups and the eager
// watcher in this process, so no two writers interleave their
// read-compare-write on the real auth.json.
let authWriteBackChain: Promise<void> = Promise.resolve();

/**
 * If the isolated turn refreshed the Grok token, persist it to the REAL
 * ~/.grok/auth.json. Grok rotates refresh tokens on use — discarding the
 * isolated copy leaves the real file holding a REVOKED token.
 *
 * Compare-and-swap: only write when the real file still holds the exact bytes
 * this caller last synced from (`originalAuth`). If another writer already
 * landed a newer token, keep theirs — a stale write-back would revoke it.
 *
 * Returns the isolated content when it differed from `originalAuth` and parsed
 * as JSON (whether or not the CAS allowed the write), so callers can advance
 * their baseline; null when there was nothing new to persist.
 */
export async function writeBackRefreshedAuth(
  realHome: string,
  isolatedGrokDir: string,
  originalAuth: string | null,
): Promise<string | null> {
  if (originalAuth === null) return null; // nothing was copied in — nothing to sync
  let observed: string | null = null;
  const task = authWriteBackChain.then(async () => {
    let refreshed: string;
    try {
      refreshed = await readFile(join(isolatedGrokDir, 'auth.json'), 'utf-8');
    } catch {
      return; // turn deleted its auth copy — nothing to persist
    }
    if (!refreshed.trim() || refreshed === originalAuth) return; // unchanged
    // The CLI may be mid-write when the eager watcher reads; a torn read must
    // never reach the real credential store.
    try { JSON.parse(refreshed); } catch { return; }
    observed = refreshed;
    const realPath = join(realHome, '.grok', 'auth.json');
    let current: string | null = null;
    try { current = await readFile(realPath, 'utf-8'); } catch { /* missing → restore */ }
    if (current !== null && current !== originalAuth) return; // newer token already landed
    await atomicWrite(realPath, refreshed);
    console.error('[grok-isolation] persisted refreshed auth.json back to the real home');
  }).catch((err: any) => {
    console.error('[grok-isolation] auth write-back failed:', err?.message || err);
  });
  authWriteBackChain = task;
  await task;
  return observed;
}

interface IsolationWatch {
  realHome: string;
  grokDir: string;
  baseline: string;
}

export interface GrokRefreshGateOptions {
  realHome?: () => string;
  now?: () => number;
  marginMs?: number;
  latchMs?: number;
  watchIntervalMs?: number;
  freshnessCacheMs?: number;
}

export class GrokRefreshGate {
  private readonly realHome: () => string;
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly latchMs: number;
  private readonly watchIntervalMs: number;
  private readonly freshnessCacheMs: number;
  private cache: { readAtMs: number; expiresAtMs: number | null } | null = null;
  private latchUntilMs = 0;
  private readonly watches = new Map<string, IsolationWatch>();
  private watchTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastLoggedStale: boolean | null = null;

  constructor(options: GrokRefreshGateOptions = {}) {
    this.realHome = options.realHome || (() => homedir());
    this.now = options.now || (() => Date.now());
    const envMargin = Number(process.env.EMPIR3_GROK_REFRESH_MARGIN_MS);
    this.marginMs = options.marginMs
      ?? (Number.isFinite(envMargin) && envMargin >= 0 ? envMargin : DEFAULT_GROK_REFRESH_MARGIN_MS);
    this.latchMs = options.latchMs ?? GROK_AUTH_FAILURE_LATCH_MS;
    this.watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    this.freshnessCacheMs = options.freshnessCacheMs ?? DEFAULT_FRESHNESS_CACHE_MS;
  }

  /** Expiry of the REAL auth store (cached briefly); null = unknown. */
  freshnessExpiresAtMs(): number | null {
    const now = this.now();
    if (this.cache && now - this.cache.readAtMs < this.freshnessCacheMs) return this.cache.expiresAtMs;
    let expiresAtMs: number | null = null;
    try {
      const raw = readFileSync(join(this.realHome(), '.grok', 'auth.json'), 'utf-8');
      expiresAtMs = parseGrokAuthFreshness(raw).expiresAtMs;
    } catch {
      // Missing/unreadable auth store: freshness unknown. API-key auth has no
      // store at all — never serialize it on a guess.
    }
    this.cache = { readAtMs: now, expiresAtMs };
    return expiresAtMs;
  }

  isStale(): boolean {
    const now = this.now();
    let stale: boolean;
    if (now < this.latchUntilMs) {
      stale = true;
    } else {
      const expiresAtMs = this.freshnessExpiresAtMs();
      // Unknown expiry admits concurrently; the auth-failure latch is the
      // reactive drain for stores this parser cannot read.
      stale = expiresAtMs !== null && expiresAtMs - now < this.marginMs;
    }
    if (stale !== this.lastLoggedStale) {
      this.lastLoggedStale = stale;
      if (stale) {
        const expiresAtMs = this.freshnessExpiresAtMs();
        const secondsLeft = expiresAtMs === null ? null : Math.round((expiresAtMs - now) / 1000);
        console.error(`[grok-refresh-gate] pool serialized for token refresh${secondsLeft === null ? '' : ` (access token expires in ${secondsLeft}s)`}`);
      } else {
        console.error('[grok-refresh-gate] pool reopened — access token fresh');
      }
    }
    return stale;
  }

  /** Concurrent while fresh; exactly one channel while a refresh is due. */
  effectiveLimit(configured: number): number {
    return this.isStale() ? 1 : configured;
  }

  poolState(): 'open' | 'refreshing' {
    return this.isStale() ? 'refreshing' : 'open';
  }

  /** Reactive drain: an auth-class turn failure serializes admissions until a
   * rotation (or re-login) lands or the latch expires. */
  noteAuthFailure(): void {
    this.latchUntilMs = this.now() + this.latchMs;
    this.cache = null;
  }

  noteRotation(): void {
    this.cache = null;
    this.latchUntilMs = 0;
  }

  registerIsolation(key: string, realHome: string, grokDir: string, baseline: string): void {
    this.watches.set(key, { realHome, grokDir, baseline });
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => { void this.watchTick(); }, this.watchIntervalMs);
      this.watchTimer.unref?.();
    }
  }

  baselineFor(key: string): string | null {
    return this.watches.get(key)?.baseline ?? null;
  }

  unregisterIsolation(key: string): void {
    this.watches.delete(key);
    if (!this.watches.size && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /**
   * Eager write-back: don't wait for turn cleanup — the pool reopens the
   * moment ANY in-flight isolated home shows a rotated token and it is
   * CAS-persisted to the real store. Polling, not fs.watch: Windows watchers
   * are unreliable, and at most five ~1KB reads per tick is negligible.
   */
  private async watchTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [key, watch] of [...this.watches]) {
        let content: string;
        try {
          content = await readFile(join(watch.grokDir, 'auth.json'), 'utf-8');
        } catch {
          continue; // turn already cleaning up
        }
        if (content === watch.baseline) continue;
        const observed = await writeBackRefreshedAuth(watch.realHome, watch.grokDir, watch.baseline);
        if (observed !== null && this.watches.has(key)) {
          this.watches.get(key)!.baseline = observed;
          this.noteRotation();
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export const grokRefreshGate = new GrokRefreshGate();
