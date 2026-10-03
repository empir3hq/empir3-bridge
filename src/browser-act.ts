/**
 * browser_act — one call from a stated goal to a browser action.
 *
 * The caller says what it wants ("open the account menu", or "the email field"
 * plus the text to type). The Bridge snapshots the page, a decision model picks
 * ONE control from that snapshot, and the Bridge clicks it or types into it
 * through the same click_ref / type_ref / press commands the caller would
 * otherwise have sent. Every local permission therefore still applies, twice:
 * browser_act has its own Permissions-page switch (checked by the daemon via
 * the act_preflight command), and each click or keystroke it sends is gated
 * again as browser_click_ref / browser_type_ref / browser_press.
 *
 * Paired Bridges use Empir3's owner-selected and billed decision engine, with
 * no engine key on the device. An explicit local endpoint takes precedence.
 * Any endpoint that speaks the System One shape
 * works — POST {url}/v1/systemone with {model, state, questions}, answering
 * answers.<name>.choice plus per-option probabilities — such as a self-hosted
 * Bespoke Nimble server or a TypeSafe-compatible service. Nothing is configured
 * by default for unpaired Bridges; with no endpoint the tool refuses, and
 * MCP users are never pushed into an Empir3 account to use it.
 *
 * Privacy: the goal and the visible controls' roles and labels are sent to the
 * configured endpoint. Typed text is never sent to it.
 *
 * What it will not do by itself:
 *  - click a control whose label reads as irreversible (submit, pay, send,
 *    delete, publish, sign out, …): it returns that control as a suggestion and
 *    the caller decides with browser_click_ref;
 *  - act when the model answers "none" or is below the confidence floor: it
 *    returns the best candidates instead;
 *  - invent text: anything typed comes only from the caller's `text`.
 *
 * Limits worth knowing: snapshots list only VISIBLE main-document controls, so
 * "no_match" can mean the control is off-screen (scroll and retry). Choice
 * models cap options per question, so large pages are split into groups of
 * CHUNK and the most confident non-"none" answer across groups wins; the
 * groups' probabilities are each normalised, so cross-group confidence is
 * approximate. Ambiguous labels can still be picked wrongly — confirm the
 * result before relying on it.
 */

export const CHUNK = 24; // + one "none" option = 25, under the common 26-option cap
export const DEFAULT_MODEL = 'nimble-latest';
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_TIMEOUT_MS = 8000;
const NONE = 'none';

export const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'slider', 'spinbutton', 'treeitem',
]);
export const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

export interface DecisionConfig {
  url: string;
  apiKey?: string;
  model: string;
  minConfidence: number;
  timeoutMs: number;
  source: 'env' | 'settings' | 'empir3';
}

export interface SnapshotNode { ref: string; role: string; name: string; bounds?: any }

export interface ActParams {
  goal: string;
  text?: string;
  submit?: boolean;
  dryRun?: boolean;
  minConfidence?: number;
}

export interface Candidate { ref: string; role: string; name: string; p: number }

export interface ActDeps {
  /** Send one command to the daemon and return its inner result; throws on refusal. */
  command: (cmd: any) => Promise<any>;
  /** POST a System One request body and return the parsed JSON reply. */
  decide: (body: any) => Promise<any>;
  now?: () => number;
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function validHttpUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Environment wins over bridge-settings.json so an MCP client can configure the
 * endpoint in its own server entry without touching the Bridge's settings.
 *   EMPIR3_DECISION_URL, EMPIR3_DECISION_API_KEY, EMPIR3_DECISION_MODEL,
 *   EMPIR3_DECISION_MIN_CONFIDENCE, EMPIR3_DECISION_TIMEOUT_MS
 *   bridge-settings.json: { "decisionModel": { url, apiKey, model, minConfidence, timeoutMs } }
 */
export function resolveDecisionConfig(env: Record<string, string | undefined>, settings: any, paired = false): DecisionConfig | null {
  const s = settings?.decisionModel && typeof settings.decisionModel === 'object' ? settings.decisionModel : {};
  const envUrl = validHttpUrl(env.EMPIR3_DECISION_URL);
  const url = envUrl || validHttpUrl(s.url);
  // A mistyped explicit local URL must not silently spend through Empir3.
  const explicitUrl = String(env.EMPIR3_DECISION_URL || s.url || '').trim();
  const pick = (envKey: string, settingsKey: string) => {
    const e = env[envKey];
    return e !== undefined && String(e).trim() !== '' ? e : s[settingsKey];
  };
  const apiKey = String(pick('EMPIR3_DECISION_API_KEY', 'apiKey') ?? '').trim();
  const model = String(pick('EMPIR3_DECISION_MODEL', 'model') ?? '').trim() || DEFAULT_MODEL;
  const minConfidence = clamp(Number(pick('EMPIR3_DECISION_MIN_CONFIDENCE', 'minConfidence') ?? DEFAULT_MIN_CONFIDENCE), 0, 1, DEFAULT_MIN_CONFIDENCE);
  if (!url) return paired && !explicitUrl ? { url: '', model: 'Empir3', minConfidence, timeoutMs: 35_000, source: 'empir3' } : null;
  const timeoutMs = clamp(Number(pick('EMPIR3_DECISION_TIMEOUT_MS', 'timeoutMs') ?? DEFAULT_TIMEOUT_MS), 500, 30000, DEFAULT_TIMEOUT_MS);
  return { url, ...(apiKey ? { apiKey } : {}), model, minConfidence, timeoutMs, source: envUrl ? 'env' : 'settings' };
}

/** Accepts the compact snapshot object ({nodes}), a bare array, or its JSON text. */
export function snapshotNodes(snapshot: any): SnapshotNode[] {
  let s = snapshot;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return []; }
  }
  const list = Array.isArray(s) ? s : Array.isArray(s?.nodes) ? s.nodes : [];
  return list
    .filter((n: any) => n && typeof n.ref === 'string')
    .map((n: any) => ({ ref: n.ref, role: String(n.role || '').toLowerCase(), name: String(n.name || '').replace(/\s+/g, ' ').trim(), bounds: n.bounds }));
}

/** Controls worth offering: actionable role, a visible label, one per role+label. */
export function actionableNodes(nodes: SnapshotNode[], opts: { editableOnly?: boolean } = {}): SnapshotNode[] {
  const seen = new Set<string>();
  const out: SnapshotNode[] = [];
  for (const n of nodes) {
    if (!n.name || !ACTIONABLE_ROLES.has(n.role)) continue;
    if (opts.editableOnly && !EDITABLE_ROLES.has(n.role)) continue;
    const key = `${n.role}\u0000${n.name.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Labels that commit something the caller cannot take back. Deliberately broad:
 * a false positive only means browser_act hands the control back as a
 * suggestion and the caller clicks it explicitly with browser_click_ref.
 */
const IRREVERSIBLE = /\b(submit|pay|payment|purchase|buy|checkout|check out|place order|order now|confirm|send|post|publish|delete|remove|destroy|erase|discard|archive|unsubscribe|deactivate|cancel (?:subscription|order|account|plan|membership)|close account|transfer|withdraw|donate|sign out|log ?out|reset|revoke|uninstall|approve)\b/i;

export function isIrreversibleLabel(name: string): boolean {
  return IRREVERSIBLE.test(String(name || ''));
}

export function operationFor(node: SnapshotNode, text?: string): 'type' | 'click' {
  return text !== undefined && text !== '' && EDITABLE_ROLES.has(node.role) ? 'type' : 'click';
}

export function describeNode(n: SnapshotNode): string {
  return `${n.role}: ${n.name.slice(0, 80)}`;
}

export function buildRequest(goal: string, group: SnapshotNode[], model: string, page: string, typing: boolean) {
  const criteria: Record<string, string> = {};
  for (const n of group) criteria[n.ref] = describeNode(n);
  criteria[NONE] = 'None of these controls is the right one for this goal.';
  const instructions = `Goal: ${goal}. Which listed control should be acted on next?`
    + (typing ? ' Text will be typed into it, so it must be the field this goal is about.' : '');
  return {
    model,
    state: `${page ? `Page: ${page}. ` : ''}Goal: ${goal}.`,
    questions: { target: { type: 'choice', instructions, criteria } },
  };
}

export interface ParsedAnswer { choice: string; confidence: number; probabilities: Record<string, number> }

/** Tolerant reader for System One replies: answers.<name>.choice / probabilities / confidence. */
export function parseAnswer(reply: any, name = 'target'): ParsedAnswer | null {
  const a = reply?.answers?.[name];
  if (!a || typeof a !== 'object') return null;
  const probabilities: Record<string, number> = {};
  if (a.probabilities && typeof a.probabilities === 'object') {
    for (const [k, v] of Object.entries(a.probabilities)) {
      const n = Number(v);
      if (Number.isFinite(n)) probabilities[k] = n;
    }
  }
  const choice = typeof a.choice === 'string' ? a.choice : '';
  if (!choice) return null;
  const confidence = Number.isFinite(Number(a.confidence)) ? Number(a.confidence)
    : (probabilities[choice] ?? Math.max(0, ...Object.values(probabilities)));
  return { choice, confidence, probabilities };
}

export function createHttpDecider(config: DecisionConfig, fetchImpl: typeof fetch = fetch) {
  return async (body: any): Promise<any> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const res = await fetchImpl(`${config.url}/v1/systemone`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) throw new Error(`decision endpoint answered ${res.status}`);
      return await res.json();
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error(`decision endpoint timed out after ${config.timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The server owns engine selection, billing and backups. Never retry a refusal. */
export function createEmpir3Decider(sendCommand: ActDeps['command']) {
  return async (body: any): Promise<any> => {
    const result = await sendCommand({ type: 'decision_relay', state: body.state, questions: body.questions });
    if (result?.success !== true) {
      throw Object.assign(new Error(result?.error || 'Empir3 could not answer this decision.'), {
        code: result?.code,
        ...(Number.isFinite(result?.retryAfterMs) ? { retryAfterMs: result.retryAfterMs } : {}),
      });
    }
    return result;
  };
}

const NOT_CONFIGURED = 'No decision engine is configured, so browser_act did nothing. Pair this Bridge with Empir3, or set EMPIR3_DECISION_URL (and EMPIR3_DECISION_API_KEY if needed), or "decisionModel": {"url": "..."} in bridge-settings.json. Any System One endpoint works, for example a self-hosted Nimble server. Until then, use browser_snapshot then browser_click_ref.';

export async function runBrowserAct(params: ActParams, config: DecisionConfig | null, deps: ActDeps): Promise<any> {
  const now = deps.now || (() => Date.now());
  const started = now();
  const goal = String(params.goal || '').replace(/\s+/g, ' ').trim();
  if (!goal) return { success: false, acted: false, reason: 'no_goal', error: 'Say what to do in `goal`, for example "open the account menu".' };
  if (!config) return { success: false, acted: false, reason: 'no_decision_model', error: NOT_CONFIGURED };

  // The daemon answers whether browser_act may run here (its own switch, global
  // Execute permission, local MCP policy). A refusal throws and nothing else runs.
  await deps.command({ type: 'act_preflight' });

  const typing = params.text !== undefined && params.text !== '';
  const snap = await deps.command({ type: 'snapshot', filter: 'interactive', format: 'compact' });
  const all = snapshotNodes(snap?.snapshot ?? snap);
  const candidatesPool = actionableNodes(all, { editableOnly: typing });
  if (!candidatesPool.length) {
    return { success: false, acted: false, reason: 'no_controls', error: typing
      ? 'No visible text field on this page. Scroll, or check the page finished loading.'
      : 'No visible actionable controls on this page. Scroll, or check the page finished loading.' };
  }

  let page = '';
  try {
    const status = await deps.command({ type: 'status' });
    page = String(status?.title || status?.currentUrl || status?.url || '').slice(0, 160);
  } catch { /* page context is optional */ }

  const floor = clamp(Number(params.minConfidence ?? config.minConfidence), 0, 1, config.minConfidence);
  const groups = chunk(candidatesPool);
  const ranked: Candidate[] = [];
  let best: { node: SnapshotNode; p: number; engine?: any; backupUsed?: boolean } | null = null;
  let lastReply: any;
  let decisionMs = 0;
  for (const group of groups) {
    const t = now();
    let reply: any;
    try {
      reply = await deps.decide(buildRequest(goal, group, config.model, page, typing));
      lastReply = reply;
    } catch (err: any) {
      return { success: false, acted: false, reason: 'decision_unavailable', error: `${err?.message || err} Nothing was clicked; use browser_snapshot then browser_click_ref.`,
        ...(err?.code ? { code: err.code } : {}), ...(Number.isFinite(err?.retryAfterMs) ? { retryAfterMs: err.retryAfterMs } : {}), decisionMs: decisionMs + (now() - t) };
    }
    decisionMs += now() - t;
    const answer = parseAnswer(reply);
    if (!answer) return { success: false, acted: false, reason: 'decision_unreadable', error: 'The decision endpoint answered in an unexpected shape. Nothing was clicked.', decisionMs };
    for (const n of group) {
      const p = answer.probabilities[n.ref];
      if (Number.isFinite(p)) ranked.push({ ref: n.ref, role: n.role, name: n.name.slice(0, 80), p });
    }
    if (answer.choice === NONE) continue;
    const node = group.find(n => n.ref === answer.choice);
    if (node && (!best || answer.confidence > best.p)) best = { node, p: answer.confidence, engine: reply.engine, backupUsed: reply.backupUsed };
  }
  ranked.sort((a, b) => b.p - a.p);
  const candidates = ranked.slice(0, 3).map(c => ({ ...c, p: Math.round(c.p * 1000) / 1000 }));
  const engine = best?.engine || lastReply?.engine;
  const base = { goal, decisionMs, groups: groups.length, controlsConsidered: candidatesPool.length, model: engine?.model || config.model, candidates,
    ...(engine ? { engine, backupUsed: best ? !!best.backupUsed : !!lastReply?.backupUsed } : {}) };

  if (!best) return { success: false, acted: false, reason: 'no_match', ...base, error: 'The decision model found no visible control for this goal. It may be off-screen: scroll and retry, or choose from browser_snapshot.' };
  const pick = { ref: best.node.ref, role: best.node.role, name: best.node.name.slice(0, 80), confidence: Math.round(best.p * 1000) / 1000 };
  if (best.p < floor) return { success: false, acted: false, reason: 'low_confidence', ...base, pick, minConfidence: floor, error: `Best match was below the confidence floor (${pick.confidence} < ${floor}). Nothing was clicked; choose from the candidates with browser_click_ref.` };

  const operation = operationFor(best.node, params.text);
  if (operation === 'click' && isIrreversibleLabel(best.node.name)) {
    return { success: false, acted: false, reason: 'irreversible', ...base, pick, error: `"${pick.name}" looks irreversible, so browser_act will not click it on its own. If that is what you intend, call browser_click_ref with ref ${pick.ref}.` };
  }
  if (params.dryRun) return { success: true, acted: false, dryRun: true, operation, ...base, pick };

  const receipts: any[] = [];
  if (operation === 'type') {
    receipts.push(await deps.command({ type: 'type_ref', ref: best.node.ref, text: params.text }));
    if (params.submit) receipts.push(await deps.command({ type: 'press', text: 'Enter' }));
  } else {
    receipts.push(await deps.command({ type: 'click_ref', ref: best.node.ref }));
  }
  return { success: true, acted: true, operation, submitted: operation === 'type' && !!params.submit, ...base, pick, totalMs: now() - started, receipts };
}
