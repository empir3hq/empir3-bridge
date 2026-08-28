/**
 * Local wrapper -> CDP bridge request budgets.
 *
 * The CDP bridge already owns the command timeout. The wrapper must wait
 * slightly longer than that command, and it must never start a second copy
 * merely because its own shorter timer fired. Otherwise the abandoned first
 * request keeps the serialized CDP queue busy while retries pile up behind it.
 */

export function localBrowserRequestTimeoutMs(path: string, raw = false): number {
  if (path === '/text' || path === '/snapshot') return 12_000;
  if (raw && path === '/screenshot') return 22_000;
  return raw ? 8_000 : 5_000;
}

export function shouldRetryLocalBrowserFetch(error: unknown, attempt: number): boolean {
  if (attempt >= 2) return false;
  const name = String((error as any)?.name || '');
  const message = String((error as any)?.message || error || '');
  // An AbortError means our request budget expired. Retrying immediately
  // creates another command while the original CDP operation may still be
  // draining. Connection failures remain eligible for the bounded retry.
  return name !== 'AbortError' && !/aborted|aborterror/i.test(message);
}

export function shouldRetryScreenshotCdpFailure(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  // A timed-out capture can still be unwinding inside Chrome. Reconnect only
  // for a dead transport; never stack a second full capture after a timeout.
  if (/timeout/i.test(message)) return false;
  return /not connected|connection reset|connection closed|websocket|browser ws/i.test(message);
}
