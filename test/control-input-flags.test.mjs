/**
 * Receipt input flags cannot contradict each other (Work Board 22e20910, P3).
 *
 * Observed: a failed browser_play step returned dispatched:false together
 * with inputMayHaveOccurred:true. That pair was a default, not a
 * computation: `attempted` flipped to true before the adapter had resolved
 * the locator, so a step that never reached the page still claimed input
 * might have happened — making agents needlessly conservative about retries.
 *
 * Now the adapter marks failures that happen before any input call with
 * inputMayHaveOccurred:false, and the runtime reports three explicit states:
 * dispatched (confirmed), uncertain (an input call threw), none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { createControlRuntime } = require_('../src/control-runtime.js');
const { createControlServices } = require_('../src/control-services.js');

const target = { surface: 'browser', tabId: 'tab-1' };
const locator = { ref: 'e1_0' };

test('pre-input failure (locator missing) → dispatched:false, inputMayHaveOccurred:false, inputState:none', async () => {
  const preInput = Object.assign(new Error('target_missing: observe again and choose a visible control.'), { inputMayHaveOccurred: false });
  const result = await createControlRuntime().run({ target, steps: [{ action: 'click', locator }] }, {
    target: async () => {}, inspect: async () => ({}), act: async () => { throw preInput; },
  });
  assert.equal(result.success, false);
  const receipt = result.receipts[0];
  assert.equal(receipt.dispatched, false);
  assert.equal(receipt.inputMayHaveOccurred, false);
  assert.equal(receipt.inputState, 'none');
});

test('input call threw mid-flight → dispatched:false, inputMayHaveOccurred:true, inputState:uncertain', async () => {
  const result = await createControlRuntime().run({ target, steps: [{ action: 'click', locator }] }, {
    target: async () => {}, inspect: async () => ({}), act: async () => { throw new Error('CDP socket closed during click'); },
  });
  const receipt = result.receipts[0];
  assert.equal(receipt.dispatched, false);
  assert.equal(receipt.inputMayHaveOccurred, true);
  assert.equal(receipt.inputState, 'uncertain');
});

test('dispatched then verification timeout → dispatched:true, inputMayHaveOccurred:true, inputState:dispatched', async () => {
  const result = await createControlRuntime().run({ target, steps: [{ action: 'click', locator, expect: { kind: 'exists' }, timeoutMs: 0 }] }, {
    target: async () => {}, inspect: async () => ({ available: true, exists: false }), act: async () => ({ success: true }),
  });
  const receipt = result.receipts[0];
  assert.equal(receipt.dispatched, true);
  assert.equal(receipt.inputMayHaveOccurred, true);
  assert.equal(receipt.inputState, 'dispatched');
  assert.match(receipt.error, /verification_timeout/);
});

test('successful step reports inputState too', async () => {
  const result = await createControlRuntime().run({ target, steps: [{ action: 'click', locator }, { action: 'wait', expect: { kind: 'exists', locator }, timeoutMs: 1 }] }, {
    target: async () => {}, inspect: async () => ({ available: true, exists: true }), act: async () => ({ success: true }),
  });
  assert.equal(result.receipts[0].inputState, 'dispatched');
  assert.equal(result.receipts[1].inputState, 'none');
});

test('control-services marks locator/guard failures as no-input and leaves real input errors alone', async () => {
  let executed = 0;
  const d = {
    runtime: { check() {} },
    policy: () => null,
    tabs: async () => ({ tabs: [{ targetId: 'tab-1' }], currentTargetId: 'tab-1' }),
    userTarget: () => null,
    cdpPost: async (path, body) => {
      if (String(body.expression).includes('"operation":"resolve"')) throw new Error('target_missing: observe again and choose a visible control.');
      return { ok: true, result: {} };
    },
    execute: async () => { executed++; throw new Error('CDP socket closed'); },
    cursor: async () => {}, beginFeedback() {}, snapshot: async () => ({ elements: [] }), resolveRef: () => ({}), runPS: async () => ({}), preamble: () => '', feedbackDir: () => '', awake: async () => {},
  };
  const services = createControlServices(d);
  await assert.rejects(services.act(target, { action: 'click', locator }, 'test'), (error) => error.inputMayHaveOccurred === false && /target_missing/.test(error.message));
  assert.equal(executed, 0, 'no input was attempted');

  // Once the locator resolves, an input-time failure must not be masked as "no input".
  d.cdpPost = async () => ({ ok: true, result: { selector: '#go' } });
  await assert.rejects(services.act(target, { action: 'click', locator }, 'test'), (error) => error.inputMayHaveOccurred === undefined && /CDP socket closed/.test(error.message));
  assert.equal(executed, 1);
});

test('recording receives verified select/expand with persistent selectors, never unverified or duplicate checkbox actions',async()=>{
  let verified=true;const recorded=[];
  const d={runtime:{check(){}},policy:()=>null,tabs:async()=>({tabs:[{targetId:'tab-1'}],currentTargetId:'tab-1'}),userTarget:()=>null,cursor:async()=>{},
    cdpPost:async(_path,body)=>({result:body.expression.includes('"operation":"resolve"')?{selector:'#stable'}:{success:true,verified}}),
    recordSemantic:async(t,step)=>recorded.push({target:t,step})};
  const services=createControlServices(d);
  for(const [action,value] of [['select','café'],['expand',true],['check',true]])await services.act(target,{action,locator:{ref:'e1_2'},value},'test');
  assert.equal(recorded.length,2);assert.deepEqual(recorded.map(r=>r.step.action),['select','expand']);
  assert.deepEqual(recorded[0].target,target);assert.deepEqual(recorded[0].step.locator,{selector:'#stable'});
  assert.deepEqual(recorded[0].step.expect,{kind:'value',locator:{selector:'#stable'},equals:'café'});
  assert.equal(recorded[1].step.expect.kind,'expanded');assert.ok(Number.isFinite(recorded[0].step.at));
  verified=false;await services.act(target,{action:'select',locator:{ref:'e1_2'},value:'other'},'test');assert.equal(recorded.length,2);
});

test('semantic selection propagates a pending dialog instead of recording or falsely verifying it',async()=>{
  const dialog={id:'fresh',type:'confirm'},recorded=[];
  const services=createControlServices({runtime:{check(){}},policy:()=>null,tabs:async()=>({tabs:[{targetId:'tab-1'}],currentTargetId:'tab-1'}),userTarget:()=>null,cursor:async()=>{},
    cdpPost:async(_path,body)=>{
      if(body.expression.includes('"operation":"resolve"')){assert.equal(body.observeDialogs,undefined);return {result:{selector:'#select'}};}
      assert.equal(body.observeDialogs,true);return {success:true,needsDialogResponse:true,dispatched:true,verified:false,dialog};
    },recordSemantic:async(...args)=>recorded.push(args)});
  const result=await services.act(target,{action:'select',locator:{selector:'#select'},value:'two'},'test');
  assert.equal(result.needsDialogResponse,true);assert.deepEqual(result.dialog,dialog);assert.equal(result.verified,false);assert.deepEqual(recorded,[]);
});
