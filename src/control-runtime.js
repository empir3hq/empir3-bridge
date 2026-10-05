'use strict';
const {getControlLimits} = require('./control-limits.js');
const { AsyncLocalStorage } = require('node:async_hooks');

// These are declarative operations, not generated code. Existing scripting tools
// retain their own permission checks and remain in the advanced catalog.
const ACTIONS = new Set(['observe', 'click', 'fill', 'select', 'check', 'expand', 'press', 'scroll', 'drag', 'navigate', 'wait']);
const CONDITIONS = new Set(['exists', 'absent', 'value', 'text', 'checked', 'expanded', 'url']);
function validateTarget(target) {
  if (!target || !['browser', 'desktop'].includes(target.surface)) throw new Error('Choose target.surface: browser or desktop.');
  if (target.surface === 'browser' && (typeof target.tabId !== 'string' || !target.tabId.trim())) throw new Error('Copy target.tabId from browser_tab_state.');
  if (target.surface === 'desktop' && (!Number.isSafeInteger(target.windowHandle) || target.windowHandle <= 0)) throw new Error('Copy target.windowHandle from desktop_snapshot or window list.');
  return target;
}
function validateCondition(condition, stepLocator) {
  if (!condition || !CONDITIONS.has(condition.kind)) throw new Error('Expected condition kind: exists, absent, value, text, checked, expanded or url.');
  if (!['exists', 'absent'].includes(condition.kind) && !Object.hasOwn(condition, 'equals') && !Object.hasOwn(condition, 'contains')) throw new Error('Condition needs equals or contains.');
  if (Object.hasOwn(condition, 'contains') && typeof condition.contains !== 'string') throw new Error('contains must be text.');
  if (condition.kind === 'url') return {...condition};
  const locator = condition.locator === undefined ? stepLocator : condition.locator;
  validateLocator(locator);
  return {...condition, locator};
}
function validateLocator(locator) {
  if (!locator || !['ref','selector','role','name','automationId','runtimeId'].some(k => typeof locator[k] === 'string' && locator[k].trim())) throw new Error('Choose an observed locator for this action.');
}
function validatePlan(plan, limits = getControlLimits()) {
  validateTarget(plan?.target);
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > limits.planSteps) throw new Error(`Provide 1–${limits.planSteps} steps.`);
  const steps = [];
  for (const submittedStep of plan.steps) {
    const step = {...submittedStep};
    if (!step || !ACTIONS.has(step.action)) throw new Error('Unknown control action. Use bridge_control_catalog for examples.');
    if (['click','fill','select','check','expand'].includes(step.action)) validateLocator(step.locator);
    if (step.action === 'fill' && (typeof step.value !== 'string' || step.value.length > limits.textCharacters)) throw new Error(`fill requires a string value up to ${limits.textCharacters} characters.`);
    if (step.action === 'select' && plan.target.surface === 'browser' && typeof step.value !== 'string') throw new Error('select requires an observed option value.');
    if (['check','expand'].includes(step.action) && typeof step.value !== 'boolean') throw new Error('check/expand value must be true or false.');
    if (step.action === 'navigate' && (plan.target.surface !== 'browser' || typeof step.url !== 'string' || !/^https?:\/\//i.test(step.url))) throw new Error('navigate requires a browser target and an http(s) URL.');
    if (step.action === 'press' && !(typeof step.key === 'string' && step.key.length) && !(Array.isArray(step.keys) && step.keys.length && step.keys.every(k=>typeof k==='string' && k.length))) throw new Error('press requires key or keys.');
    if (step.action === 'drag' && (plan.target.surface !== 'desktop' || !['x','y','toX','toY'].every(k=>Number.isFinite(step[k])))) throw new Error('Native drag needs x/y and toX/toY in physical desktop pixels.');
    if (step.action === 'scroll') {
      if(plan.target.surface==='browser' && !['x','y'].some(k=>Number.isFinite(step[k])))throw new Error('Browser scroll needs a finite x or y distance in CSS pixels.');
      if(plan.target.surface==='desktop' && (!Number.isFinite(step.clicks)||Math.abs(step.clicks)>limits.scrollNotches))throw new Error(`Native scroll needs clicks between -${limits.scrollNotches} and ${limits.scrollNotches} (wheel notches; positive is up).`);
    }
    if (step.expect !== undefined) step.expect = validateCondition(step.expect, step.locator);
    if (step.when !== undefined) step.when = validateCondition(step.when, step.locator);
    if (step.action === 'wait' && !step.expect) throw new Error('wait requires expect; wait for a state, not a guessed delay.');
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 0 || step.timeoutMs > limits.stepTimeoutMs)) throw new Error(`Step timeoutMs must be 0–${limits.stepTimeoutMs}.`);
    steps.push(step);
  }
  if (plan.timeoutMs !== undefined && (!Number.isFinite(plan.timeoutMs) || plan.timeoutMs < 1 || plan.timeoutMs > limits.planTimeoutMs)) throw new Error(`Plan timeoutMs must be 1–${limits.planTimeoutMs}.`);
  return {...plan, steps};
}
function matchesCondition(observed, condition) {
  if (!observed || observed.available === false) return false;
  if (condition.kind === 'exists') return observed.exists === true;
  if (condition.kind === 'absent') return observed.exists === false;
  if (observed.exists === false && condition.kind !== 'url') return false;
  return Object.hasOwn(condition, 'equals') ? observed.value === condition.equals : String(observed.value ?? '').includes(condition.contains);
}
function compactReceipt(value, depth = 0) {
  if (depth > 7) return '[depth limit]';
  if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) + '…' : value;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => compactReceipt(v, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 70)) {
    if (/^(base64|thumbnail|screenshot|imageData|dataUrl|buffer)$/i.test(key)) { out[key] = '[image omitted]'; continue; }
    if (/password|secret|token|authorization|cookie|api.?key/i.test(key)) { out[key] = '[redacted]'; continue; }
    // Diagnostics retain action shape, not entered text, documents or scripts.
    if (/^(text|value|equals|contains|expression|script|content|typedText)$/i.test(key)) { out[key] = '[content omitted]'; continue; }
    if (/url|href/i.test(key) && typeof item === 'string') {
      try { const u = new URL(item); out[key] = u.origin + '/[path omitted]'; } catch { out[key] = '[url omitted]'; }
      continue;
    }
    out[key] = compactReceipt(item, depth + 1);
  }
  return out;
}
function createControlRuntime({ isPaused = () => false, setPaused = () => {}, onState = () => {} } = {}) {
  const context = new AsyncLocalStorage();
  let active = null;
  let state = { phase: 'idle', owner: null, action: null, target: null, updatedAt: new Date().toISOString() };
  function update(patch) { state = { ...state, ...patch, updatedAt: new Date().toISOString() }; onState(status()); }
  function status() { return { ...state, paused: isPaused(), busy: !!active }; }
  function check() {
    if (context.getStore()?.cancelled) throw new Error('control_cancelled: the user stopped this action; observe again after control is resumed.');
    if (isPaused()) throw new Error('control_paused: resume from the local Bridge control panel; observe again before acting.');
  }
  async function exclusive(meta, fn) {
    if (context.getStore() === active && active) return fn();
    if (active) throw new Error('control_busy: another action owns this Bridge. Wait for idle or use an isolated Bridge instance.');
    const lease = {target:meta.target}; active = lease;
    update({ phase: 'working', owner: String(meta.owner || 'Agent').slice(0, 64), action: meta.action, target: meta.target || state.target || null, ...(meta.target?.surface==='desktop'?{lastNativeTarget:meta.target}:{}), message:null });
    try { return await context.run(lease, fn); }
    catch (error) { update({ phase: 'failed', message: String(error.message || error).slice(0, 300) }); throw error; }
    finally { active = null; update({ phase: isPaused() ? 'paused' : state.phase === 'failed' ? 'failed' : 'idle' }); }
  }
  async function run(plan, adapter) {
    const limits = getControlLimits();
    plan = validatePlan(plan, limits); // Normalize and validate every step before the first side effect.
    return exclusive({owner: plan.owner, action:'workflow', target:plan.target}, async () => {
      check();
      const start = Date.now(), deadline = start + (plan.timeoutMs ?? limits.planTimeoutMs), receipts = [];
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i], began = Date.now();
        let dispatched = false, attempted = false;
        try {
          check();
          if (Date.now() >= deadline) throw new Error('control_timeout: plan time limit reached.');
          await adapter.target(plan.target);
          if (step.when && !matchesCondition(await adapter.inspect(plan.target, step.when), step.when)) {
            receipts.push({step:i+1, action:step.action, skipped:true, reason:'condition_not_met'}); continue;
          }
          check(); // A user can stop control while target/condition inspection is pending.
          update({ phase:'working', action:step.action, step:i+1, message:null });
          attempted = !['wait','observe'].includes(step.action);
          const result = step.action === 'wait' ? null : await adapter.act(plan.target, step);
          dispatched = step.action !== 'wait' && step.action !== 'observe';
          if (result?.success === false || result?.ok === false) throw new Error(result.error || 'Action refused');
          check(); // Even the final action must report a stop that occurred during input.
          if (result?.needsDialogResponse) {
            receipts.push({step:i+1, action:step.action, success:true, dispatched, inputState:'dispatched', verified:false, durationMs:Date.now()-began, result});
            update({phase:'waiting',message:'The website is waiting for a dialog response'});
            return {success:false,needsDialogResponse:true,dialog:result.dialog,target:plan.target,completed:receipts.length,requested:plan.steps.length,receipts,error:result.next,durationMs:Date.now()-start};
          }
          if(['fill','select','check','expand'].includes(step.action)&&result?.verified===false&&!step.expect)throw new Error('verification_failed: requested control state was not observed; inspect before continuing.');
          if (Date.now() >= deadline) throw new Error('control_timeout: action exceeded the plan deadline; inspect state before continuing.');
          let observed = null, verified = result?.verified === true;
          if (step.expect) {
            const until = Math.min(deadline, Date.now() + (step.timeoutMs ?? Math.min(limits.stepDefaultTimeoutMs, limits.stepTimeoutMs)));
            update({phase:'waiting', message:'Waiting for the expected result'});
            do {
              check(); await adapter.target(plan.target);
              observed = await adapter.inspect(plan.target, step.expect);
              verified = matchesCondition(observed, step.expect);
              if (verified || Date.now() >= until) break;
              await new Promise(resolve => setTimeout(resolve, Math.min(limits.pollIntervalMs, Math.max(0, until-Date.now()))));
            } while (Date.now() <= until);
            if (!verified) throw new Error('verification_timeout: expected state was not observed. Input was not repeated.');
          }
          receipts.push({step:i+1, action:step.action, success:true, dispatched, inputState:dispatched?'dispatched':'none', verified, durationMs:Date.now()-began, result, observed});
          update({phase:verified?'verified':'working', message:verified?'Expected result verified':'Action dispatched; outcome not verified'});
        } catch (error) {
          // dispatched: the surface confirmed it received the input.
          // inputMayHaveOccurred: input could not be ruled out — true after a
          // confirmed dispatch, false when the adapter failed before reaching
          // input (locator, guard, policy), and true only for the genuinely
          // uncertain case (an input call threw mid-flight). inputState names
          // which of the three the receipt describes.
          const inputMayHaveOccurred = attempted && (dispatched || error?.inputMayHaveOccurred !== false);
          const inputState = dispatched ? 'dispatched' : inputMayHaveOccurred ? 'uncertain' : 'none';
          receipts.push({step:i+1, action:step.action, success:false, dispatched, inputMayHaveOccurred, inputState, verified:false, durationMs:Date.now()-began, error:String(error.message || error)});
          update({phase:'failed', message:receipts.at(-1).error});
          return {success:false, target:plan.target, completed:receipts.length, requested:plan.steps.length, receipts, error:receipts.at(-1).error, durationMs:Date.now()-start};
        }
      }
      return {success:true, target:plan.target, completed:receipts.length, receipts, durationMs:Date.now()-start};
    });
  }
  return {status, update, check, exclusive, run, currentTarget:()=>context.getStore()?.target, pause(){if(active)active.cancelled=true;setPaused(true);update({phase:'paused',message:'Paused by user'});return status();}, resume(){setPaused(false);update({phase:active?'working':'idle',message:'Resumed; take a fresh observation'});return status();}};
}
module.exports = { createControlRuntime, compactReceipt, validateTarget, validatePlan, matchesCondition };
