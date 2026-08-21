export const DEFAULT_PROVIDER_MAX_CONCURRENT = 5;
export const MAX_PROVIDER_CONCURRENCY_LIMIT = 512;

export interface ProviderConcurrencySnapshot {
  isolated_sessions: true;
  max_active: number;
  active: number;
  /** Present for pools with refresh-gated admission (Grok): 'refreshing'
   * means capacity is truthfully serialized to 1 while a token rotation is
   * due, so callers must not fan out against the advertised configured max. */
  pool_state?: 'open' | 'refreshing';
}

export interface ProviderConcurrencyLease {
  release: () => void;
  snapshot: ProviderConcurrencySnapshot;
}

export function normalizeProviderConcurrencyLimit(
  raw: unknown,
  fallback = DEFAULT_PROVIDER_MAX_CONCURRENT,
): number {
  const safeFallback = Number.isFinite(Number(fallback)) && Number(fallback) >= 1
    ? Math.min(MAX_PROVIDER_CONCURRENCY_LIMIT, Math.floor(Number(fallback)))
    : DEFAULT_PROVIDER_MAX_CONCURRENT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return safeFallback;
  return Math.min(MAX_PROVIDER_CONCURRENCY_LIMIT, Math.max(1, Math.floor(parsed)));
}

/**
 * One physical Bridge owns admission for every subscription, API key, and
 * local model endpoint attached to it. Provider pools are independent: five
 * Grok calls do not consume Spark's two slots, while every user/project that
 * reaches the same physical provider shares that provider's one pool.
 */
export class ProviderConcurrencyGate {
  private readonly activeByProvider = new Map<string, Set<string>>();

  snapshot(providerKey: string, maxActive: unknown): ProviderConcurrencySnapshot {
    const key = String(providerKey || 'unknown');
    return {
      isolated_sessions: true,
      max_active: normalizeProviderConcurrencyLimit(maxActive),
      active: this.activeByProvider.get(key)?.size ?? 0,
    };
  }

  tryAcquire(
    providerKey: string,
    runId: string,
    maxActive: unknown,
  ): ProviderConcurrencyLease | null {
    const key = String(providerKey || 'unknown');
    const runKey = String(runId || 'unknown');
    const limit = normalizeProviderConcurrencyLimit(maxActive);
    const active = this.activeByProvider.get(key) ?? new Set<string>();
    if (active.has(runKey) || active.size >= limit) return null;

    active.add(runKey);
    this.activeByProvider.set(key, active);
    let released = false;
    return {
      snapshot: this.snapshot(key, limit),
      release: () => {
        if (released) return;
        released = true;
        const current = this.activeByProvider.get(key);
        current?.delete(runKey);
        if (!current?.size) this.activeByProvider.delete(key);
      },
    };
  }
}

export const providerConcurrencyGate = new ProviderConcurrencyGate();
