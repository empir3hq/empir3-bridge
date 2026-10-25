export const MAX_BROWSER_CHECK_STEPS = 12;
export const MAX_BROWSER_CHECK_TIMEOUT_MS = 30_000;
export const ACCURACY_LAB_TARGET_COUNT = 103;

export const BROWSER_CHECK_ACTIONS = new Set([
  'snapshot',
  'text',
  'click_ref',
  'click_selector',
  'type_ref',
  'type_selector',
  'press',
  'scroll',
  'wait',
]);

export interface BrowserCheckStep {
  action: string;
  params: Record<string, unknown>;
  label?: string;
}

export function normalizeBrowserCheckPlan(raw: unknown): BrowserCheckStep[] {
  if (!Array.isArray(raw)) throw new Error('run_checks requires a steps array');
  if (raw.length < 1) throw new Error('run_checks requires at least one step');
  if (raw.length > MAX_BROWSER_CHECK_STEPS) {
    throw new Error(`run_checks accepts at most ${MAX_BROWSER_CHECK_STEPS} steps`);
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`run_checks step ${index + 1} must be an object`);
    const input = value as Record<string, unknown>;
    const action = String(input.action || '').trim().toLowerCase();
    if (!BROWSER_CHECK_ACTIONS.has(action)) {
      throw new Error(`run_checks step ${index + 1} uses unsupported action "${action || '(missing)'}"`);
    }
    const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
      ? { ...(input.params as Record<string, unknown>) }
      : {};
    const label = typeof input.label === 'string' && input.label.trim()
      ? input.label.trim().slice(0, 120)
      : undefined;
    if (action === 'wait') {
      const requested = Number(params.ms ?? 250);
      params.ms = Math.max(0, Math.min(2_000, Number.isFinite(requested) ? Math.round(requested) : 250));
    }
    return { action, params, ...(label ? { label } : {}) };
  });
}

export function compactBrowserStepResult(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, 1_000);
  if (typeof value !== 'object') return value;
  const result = value as Record<string, unknown>;
  if (result.success === false) return { success: false, error: String(result.error || 'step failed').slice(0, 500) };
  if (result.snapshot && typeof result.snapshot === 'object') {
    const snapshot = result.snapshot as Record<string, unknown>;
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.slice(0, 40) : undefined;
    return { success: true, snapshot: { count: snapshot.count, ...(nodes ? { nodes } : {}) } };
  }
  if (typeof result.text === 'string') return { success: true, text: result.text.slice(0, 2_000) };
  const allowed = ['success', 'clicked', 'typed', 'pressed', 'moved', 'target', 'before', 'after', 'delta', 'url'];
  return Object.fromEntries(allowed.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}

export function accuracyLabStatsPass(stats: Record<string, unknown>, trustedReceipts: number): boolean {
  return trustedReceipts === ACCURACY_LAB_TARGET_COUNT
    && Number(stats.registeredTargets) === ACCURACY_LAB_TARGET_COUNT
    && Number(stats.totalClicks) === ACCURACY_LAB_TARGET_COUNT
    && Number(stats.hits) === ACCURACY_LAB_TARGET_COUNT
    && Number(stats.uniqueHits) === ACCURACY_LAB_TARGET_COUNT
    && Number(stats.misses) === 0
    && Number(stats.remaining) === 0
    && Number(stats.worstOffset) <= 5;
}
