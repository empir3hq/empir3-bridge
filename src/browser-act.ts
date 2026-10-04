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
 * CHUNK in one request, followed by a comparable final choice over winners.
 * Ambiguous controls remain subject to the confidence floor.
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

import { browserRefusal } from './browser-refusal.js';

export interface SnapshotNode { ref: string; role: string; name: string; bounds?: any; description?: string; context?: string; itemOrder?: number; itemTotal?: number; order?: number; total?: number; tag?: string; checked?: boolean | string; selected?: boolean; disabled?: boolean; expanded?: boolean; options?: {value:string;label:string;disabled?:boolean}[] }

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
    .map((n: any) => ({ ...n, ref: n.ref, role: String(n.role || '').toLowerCase(), name: String(n.name || n.description || '').replace(/\s+/g, ' ').trim() }));
}

/** Preserve distinct refs: equal labels may belong to different rows or cards. */
export function actionableNodes(nodes: SnapshotNode[], opts: { editableOnly?: boolean } = {}): SnapshotNode[] {
  const seen = new Set<string>();
  const out: SnapshotNode[] = [];
  for (const n of nodes) {
    if (!(n.name || n.description) || n.disabled || !ACTIONABLE_ROLES.has(n.role)) continue;
    if (opts.editableOnly && (!EDITABLE_ROLES.has(n.role) || n.tag?.toLowerCase() === 'select')) continue;
    const key = n.ref;
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

export function operationFor(node: SnapshotNode, text?: string): 'type' | 'click' | 'select' {
  if (node.tag?.toLowerCase() === 'select') return 'select';
  return text !== undefined && text !== '' && EDITABLE_ROLES.has(node.role) ? 'type' : 'click';
}

export function describeNode(n: SnapshotNode): string {
  const ordinal = (v: number) => `${v}${v%100>=11 && v%100<=13?'th':({1:'st',2:'nd',3:'rd'} as any)[v%10] || 'th'}`;
  const states = ['checked','selected','disabled','expanded'].filter(k=>(n as any)[k] !== undefined).map(k=>`${k}=${(n as any)[k]}`).join(', ');
  return `${n.role}: ${(n.name || n.description || '').slice(0, 80)}`
    + (n.context ? `; item${n.itemOrder ? ` ${n.itemOrder}${n.itemTotal ? ` of ${n.itemTotal}` : ''}` : ''}: ${n.context.slice(0,60)}` : '')
    + (n.order && n.total ? `; ${ordinal(n.order)} of ${n.total} '${n.name}' ${n.role}s` : '')
    + (states ? `; ${states}` : '');
}

export function buildRequest(goal: string, group: SnapshotNode[], model: string, page: string, typing: boolean) {
  const criteria: Record<string, string> = {};
  for (const n of group) criteria[n.ref] = describeNode(n);
  criteria[NONE] = 'None of these controls is the right one for this goal.';
  const instructions = `Goal: ${goal}. Which listed control should be acted on next?`
    + ' Item numbers identify stories, rows or cards; control order counts repeated labels. Match the item number when the goal names an item.'
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
  const stopped = (r: any) => ({...r,success:false,acted:false,reason:r.code || 'action_refused',decisionCalls:0});
  const command = async (cmd: any) => {
    try {return await deps.command(cmd);} catch(error) {const r=browserRefusal(error);if(r)return r;throw error;}
  };
  const preflight = await command({ type: 'act_preflight' });
  if (preflight?.success === false || preflight?.ok === false) return stopped(preflight);

  const typing = params.text !== undefined && params.text !== '';
  const snap = await command({ type: 'snapshot', filter: 'interactive', format: 'compact' });
  const observed = snap?.snapshot ?? snap;
  if (observed?.success === false || snap?.success === false) return stopped(observed?.success === false ? observed : snap);
  const all = snapshotNodes(snap?.snapshot ?? snap);
  const candidatesPool = actionableNodes(all, { editableOnly: typing });
  if (!candidatesPool.length) {
    return { success: false, acted: false, reason: 'no_controls', decisionCalls:0, error: observed?.visibleFrames
      ? 'Controls inside frames are not visible to browser_act. Use browser_screenshot, browser_click_xy and focused browser_type with the explicit browser target; verify the result.' : typing
      ? 'No visible text field on this page. Scroll, or check the page finished loading.'
      : 'No visible actionable controls on this page. Scroll, or check the page finished loading.' };
  }

  let page = '', targetId = preflight?.targetId;
  try {
    const status = await deps.command({ type: 'status' });
    page = String(status?.title || status?.currentUrl || status?.url || '').slice(0, 160);
    targetId ||= status?.currentTargetId || status?.targetId;
  } catch { /* page context is optional */ }

  const floor = clamp(Number(params.minConfidence ?? config.minConfidence), 0, 1, config.minConfidence);
  const groups = chunk(candidatesPool);
  const ranked: Candidate[] = [];
  let best: { node: SnapshotNode; p: number } | null = null;
  let lastReply: any;
  let decisionMs = 0, decisionCalls = 0;
  const request = (questions: any) => ({model:config.model,state:`${page ? `Page: ${page}. ` : ''}Goal: ${goal}.`,questions});
  const targetQuestion = (group: SnapshotNode[]) => buildRequest(goal,group,config.model,page,typing).questions.target;
  const enabledOptions = (n: SnapshotNode) => (n.options || []).filter(o=>!o.disabled);
  const optionQuestion = (n: SnapshotNode, options: any[]) => ({type:'choice',instructions:`Goal: ${goal}. Choose the enabled option that completes this goal in ${describeNode(n)}.`,criteria:Object.fromEntries([...options.map(o=>[o.key,o.label]),[NONE,'None of these options completes the goal.']])});
  const optionGroups = new Map<string, any[][]>();
  const first: any = {};
  groups.forEach((g,i)=>{first[groups.length===1?'target':`group_${i}`]=targetQuestion(g);});
  // Large menus must shortlist their options alongside the control questions,
  // so a final control choice and final option choice still fit two calls.
  for (const n of candidatesPool.filter(n=>n.tag?.toLowerCase()==='select')) {
    const options=enabledOptions(n).map((o,i)=>({...o,key:`option_${i}`}));
    const chunks=chunk(options);optionGroups.set(n.ref,chunks);
    if(chunks.length>1)chunks.forEach((g,i)=>{first[`options_${n.ref}_${i}`]=optionQuestion(n,g);});
  }
  if (Object.keys(first).length>64) return {success:false,acted:false,reason:'too_many_questions',decisionCalls:0,error:'Too many visible controls or select options for a bounded decision. Narrow the page with a snapshot or scroll.'};
  const decide = async (body: any) => {
    const t = now();
    decisionCalls++;
    // A page may echo a previously entered value into its label/context. The
    // literal caller text must still stay local, even in that echoed content.
    const redact = (s: string) => params.text ? String(s).split(params.text).join('[entered text omitted]') : s;
    const safeBody = {...body,state:redact(body.state),questions:Object.fromEntries(Object.entries(body.questions).map(([key,value]:[string,any])=>[key,{...value,instructions:redact(value.instructions),criteria:Object.fromEntries(Object.entries(value.criteria).map(([ref,label])=>[ref,redact(String(label))]))}]))};
    try {lastReply=await deps.decide(safeBody);return lastReply;} finally {decisionMs+=now()-t;}
  };
  const winners: SnapshotNode[] = [];
  let selection: any, optionConfidence = 1;
  try {
    const reply=await decide(request(first));
    for(let i=0;i<groups.length;i++) {
      const group=groups[i], a=parseAnswer(reply,groups.length===1?'target':`group_${i}`);
      if(!a) return {success:false,acted:false,reason:'decision_unreadable',decisionCalls,decisionMs,error:'The decision endpoint answered in an unexpected shape. Nothing was clicked.'};
      const node=group.find(n=>n.ref===a.choice);
      if(node){winners.push(node);if(groups.length===1)best={node,p:a.confidence};}
      if(groups.length===1)for(const n of group)if(Number.isFinite(a.probabilities[n.ref]))ranked.push({ref:n.ref,role:n.role,name:n.name,p:a.probabilities[n.ref]});
    }
    if(winners.length>CHUNK)return {success:false,acted:false,reason:'too_many_winners',decisionCalls,decisionMs,error:'Too many group winners for a comparable final decision. Narrow the page and retry.'};
    const second: any = {};
    if(groups.length>1 && winners.length)second.target=targetQuestion(winners);
    for(const n of winners.filter(n=>n.tag?.toLowerCase()==='select')) {
      const chunks=optionGroups.get(n.ref) || [];
      let options=chunks.flat();
      if(chunks.length>1) {
        options=[];
        for(let i=0;i<chunks.length;i++){
          const a=parseAnswer(reply,`options_${n.ref}_${i}`);
          if(!a)return {success:false,acted:false,reason:'decision_unreadable',decisionCalls,decisionMs,error:'The select option shortlist was unreadable. No input was sent.'};
          const o=chunks[i].find(o=>o.key===a.choice);if(o)options.push(o);
        }
      }
      if(options.length>CHUNK)return {success:false,acted:false,reason:'too_many_options',decisionCalls,decisionMs,error:'Too many option winners for a bounded final selection. Use browser_control select with an explicit value.'};
      second[`select_${n.ref}`]=optionQuestion(n,options);
    }
    if(Object.keys(second).length) {
      const final=await decide(request(second));
      if(groups.length>1){
        const a=parseAnswer(final);if(!a)return {success:false,acted:false,reason:'decision_unreadable',decisionCalls,decisionMs,error:'The final decision was unreadable. Nothing was clicked.'};
        const node=winners.find(n=>n.ref===a.choice);best=node?{node,p:a.confidence}:null;
        for(const n of winners)if(Number.isFinite(a.probabilities[n.ref]))ranked.push({ref:n.ref,role:n.role,name:n.name,p:a.probabilities[n.ref]});
      }
      if(best?.node.tag?.toLowerCase()==='select'){
        const a=parseAnswer(final,`select_${best.node.ref}`);
        selection=a && Object.hasOwn(second[`select_${best.node.ref}`].criteria,a.choice) && enabledOptions(best.node).find((o,i)=>`option_${i}`===a.choice);
        optionConfidence=a?.confidence ?? 0;
      }
    }
  } catch (err: any) {
      return { success: false, acted: false, reason: 'decision_unavailable', error: `${err?.message || err} Nothing was clicked; use browser_snapshot then browser_click_ref.`,
        ...(err?.code ? { code: err.code } : {}), ...(Number.isFinite(err?.retryAfterMs) ? { retryAfterMs: err.retryAfterMs } : {}), decisionMs,decisionCalls };
  }
  ranked.sort((a, b) => b.p - a.p);
  const candidates = ranked.slice(0, 3).map(c => ({ ...c, p: Math.round(c.p * 1000) / 1000 }));
  const engine = lastReply?.engine;
  const base = { goal, decisionMs, decisionCalls, groups: groups.length, controlsConsidered: candidatesPool.length, model: engine?.model || config.model, candidates,
    ...(engine ? { engine, backupUsed: !!lastReply?.backupUsed } : {}) };

  if (!best) return { success: false, acted: false, reason: 'no_match', ...base, error: observed?.visibleFrames ? 'Controls inside frames are not visible to browser_act. Use browser_screenshot, browser_click_xy and focused browser_type with the explicit browser target; verify the result.' : 'The decision model found no visible control for this goal. It may be off-screen: scroll and retry, or choose from browser_snapshot.' };
  const pick = { ref: best.node.ref, role: best.node.role, name: best.node.name.slice(0, 80), confidence: Math.round(best.p * 1000) / 1000 };
  if (best.p < floor) return { success: false, acted: false, reason: 'low_confidence', ...base, pick, minConfidence: floor, error: `Best match was below the confidence floor (${pick.confidence} < ${floor}). Nothing was clicked; choose from the candidates with browser_click_ref.` };

  const operation = operationFor(best.node, params.text);
  const irreversible = best.node.role === 'link'
    ? /^(?:sign\s*out|log\s*out|delete\s+(?:my\s+|your\s+)?account|close\s+(?:my\s+|your\s+)?account)\b/i.test(best.node.name)
    : ['button','menuitem','menuitemcheckbox','menuitemradio'].includes(best.node.role) && isIrreversibleLabel(best.node.name);
  if (operation === 'click' && irreversible) {
    return { success: false, acted: false, reason: 'irreversible', ...base, pick, error: `"${pick.name}" looks irreversible, so browser_act will not click it on its own. If that is what you intend, call browser_click_ref with ref ${pick.ref}.` };
  }
  if(['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(best.node.role) && typeof best.node.checked==='boolean') {
    const desired = /\b(uncheck|untick|turn off|switch off|deselect)\b/i.test(goal) ? false : /\b(check|tick|turn on|switch on|select)\b/i.test(goal) ? true : undefined;
    if(desired!==undefined && desired===best.node.checked)return {success:true,acted:false,reason:'already_done',operation,...base,pick};
  }
  if(operation==='select' && (!selection || optionConfidence<floor))return {success:false,acted:false,reason:selection?'low_confidence':'no_matching_option',...base,pick,error:'No enabled select option was chosen with sufficient confidence. No input was sent.'};
  if (params.dryRun) return { success: true, acted: false, dryRun: true, operation, ...base, pick };

  const receipts: any[] = [];
  if (operation === 'type') {
    receipts.push(await command({ type: 'type_ref', ref: best.node.ref, text: params.text }));
    if (params.submit && receipts[0]?.success !== false && !receipts[0]?.needsDialogResponse) receipts.push(await command({ type: 'press', text: 'Enter' }));
  } else if(operation==='select') {
    if(!targetId)return {success:false,acted:false,reason:'target_missing',...base,pick,error:'A select needs the current browser target. Observe the tab and retry.'};
    receipts.push(await command({type:'control_run',target:{surface:'browser',tabId:targetId},steps:[{action:'select',locator:{ref:best.node.ref},value:selection.value,expect:{kind:'value',locator:{ref:best.node.ref},equals:selection.value}}]}));
  } else {
    receipts.push(await command({ type: 'click_ref', ref: best.node.ref }));
  }
  const failed=receipts.find(r=>r?.success===false || r?.ok===false);
  if(failed)return {...stopped(failed),...base,pick,operation,receipts};
  const pending=receipts.flatMap(r=>[r,...(r?.receipts || []).map((s:any)=>s.result)]).find(r=>r?.needsDialogResponse), opened=receipts.find(r=>r?.newTab);
  const selectionVerified=receipts[0]?.verified===true || (receipts[0]?.success===true && receipts[0]?.receipts?.length && receipts[0].receipts.every((r:any)=>r.success===true && r.verified===true));
  if(operation==='select' && !selectionVerified)return {success:false,acted:false,reason:'selection_not_verified',...base,pick,operation,receipts,error:'The selected value was not verified. Observe before retrying.',...(pending?{needsDialogResponse:true,dialog:pending.dialog}:{})};
  return { success: true, acted: true, operation, submitted: operation === 'type' && !!params.submit, ...base, pick, totalMs: now() - started, receipts,
    ...(pending?{needsDialogResponse:true,dialog:pending.dialog}:{}),...(opened?{newTab:opened.newTab}:{}) };
}
