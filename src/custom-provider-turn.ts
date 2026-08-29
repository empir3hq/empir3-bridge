export const CUSTOM_PROVIDER_PROGRESS_INTERVAL_MS = 15_000;
export const CUSTOM_PROVIDER_TIMEOUT_MIN_MS = 30_000;
export const CUSTOM_PROVIDER_TIMEOUT_MAX_MS = 4 * 60 * 60 * 1000;

export function customProviderTurnTimeoutMs(requested: unknown, fallbackMs: number): number {
  const parsed = Number(requested);
  const fallback = Number.isFinite(fallbackMs) ? fallbackMs : 15 * 60 * 1000;
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(CUSTOM_PROVIDER_TIMEOUT_MIN_MS, Math.min(CUSTOM_PROVIDER_TIMEOUT_MAX_MS, Math.round(value)));
}

export function startCustomProviderProgress(options: {
  id: string;
  emit: (payload: { id: string; elapsed_ms: number }) => void;
  intervalMs?: number;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): () => void {
  const intervalMs = Math.max(1_000, Math.round(options.intervalMs || CUSTOM_PROVIDER_PROGRESS_INTERVAL_MS));
  const now = options.now || Date.now;
  const startedAt = now();
  const timer = (options.setIntervalFn || setInterval)(() => {
    options.emit({ id: options.id, elapsed_ms: Math.max(0, now() - startedAt) });
  }, intervalMs);
  timer.unref?.();
  return () => (options.clearIntervalFn || clearInterval)(timer);
}
