import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {CONTROL_LIMIT_DEFS, DEFAULT_CONTROL_LIMITS, getControlLimits, patchControlLimits, setControlLimitsReader} from '../src/control-limits.js';
import {createControlRuntime, validatePlan} from '../src/control-runtime.js';
import {literalTextBase64, NATIVE_INPUT_PS, NATIVE_TARGET_GUARD_PS} from '../src/windows-native-input.js';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {createControlServices} from '../src/control-services.js';
import {controlLimitsPanelHtml} from '../src/control-limits-panel.js';
const target={surface:'browser',tabId:'fixture'};
test('operator overrides change validation, text input and observation; reset restores defaults',async()=>{
  let saved={};setControlLimitsReader(()=>saved);
  try {
    saved=patchControlLimits(saved,{planSteps:1,textCharacters:3,browserTextCharacters:200,browserElements:5});
    assert.throws(()=>validatePlan({target,steps:[{action:'observe'},{action:'observe'}]}),/1–1 steps/);
    assert.throws(()=>literalTextBase64('four'),/1–3/);
    assert.equal(Buffer.from(literalTextBase64('abc'),'base64').toString('utf16le'),'abc');
    let expression;
    const services=createControlServices({tabs:async()=>({tabs:[{targetId:'fixture'}]}),cdpPost:async(_path,data)=>{expression=data.expression;return {result:{}}}});
    await services.observe(target);
    const observation=vm.runInNewContext(expression,{location:{href:'https://fixture.invalid/'},document:{title:'Fixture',body:{innerText:'x'.repeat(300)},querySelectorAll:()=>Array.from({length:10},()=>({tagName:'BUTTON',textContent:'Button',getAttribute:()=>null}))}});
    assert.equal(observation.text.length,200);assert.equal(observation.controls.length,5);
    saved=patchControlLimits(saved,{planSteps:null,textCharacters:null});
    validatePlan({target,steps:[{action:'observe'},{action:'observe'}]});
    assert.equal(getControlLimits().textCharacters,DEFAULT_CONTROL_LIMITS.textCharacters);
    for(const bad of [{planSteps:NaN},{planSteps:1.5},{planSteps:'2'},{planSteps:0},{unknown:1},[],null])assert.throws(()=>patchControlLimits(saved,bad));
    assert.equal(saved.browserElements,5);
  }finally{setControlLimitsReader(()=>({}));}
});
test('active workflow keeps its budget while a later workflow uses new operator limits',async()=>{
  let saved={planTimeoutMs:500,stepDefaultTimeoutMs:0};setControlLimitsReader(()=>saved);
  const clock=Date.now;let now=1000,calls=0;
  try {
    Date.now=()=>now;
    const result=await createControlRuntime().run({target,steps:[{action:'observe'},{action:'observe'}]}, {target:async()=>{},act:async()=>{calls++;now+=150;saved={planTimeoutMs:100};return {success:true}}});
    assert.equal(result.success,true);assert.equal(calls,2);
    const next=await createControlRuntime().run({target,steps:[{action:'observe'}]}, {target:async()=>{},act:async()=>{now+=150;return {success:true}}});
    assert.equal(next.success,false);assert.match(next.error,/deadline/);
  }finally{Date.now=clock;setControlLimitsReader(()=>({}));}
});
test('every registered dial is rendered with units, supported range and a reset action',()=>{
  const html=controlLimitsPanelHtml();
  for(const d of Object.values(CONTROL_LIMIT_DEFS)){assert.ok(html.includes(`data-control-limit="${d.key}"`));assert.ok(html.includes(`Default ${d.default}`));}
  assert.match(html,/Restore defaults/);assert.match(html,/role="status"/);assert.match(html,/if\(!form.reportValidity\(\)\)return/);
});
test('warm native worker applies changed limits without recompiling interop; queued guard uses the same setting',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  const probe=NATIVE_INPUT_PS+'\n@{ack=[Empir3NativeInput]::EditorAckTimeoutMs;life=[Empir3NativeInput]::SnapshotLifetimeMs;motion=[Empir3NativeInput]::MoveMaxMs}|ConvertTo-Json -Compress';
  try {
    assert.equal((await worker.run(probe,15000,{controlLimits:{...DEFAULT_CONTROL_LIMITS,editorAckTimeoutMs:400}})).ack,400);
    const changed=await worker.run(probe,15000,{controlLimits:{...DEFAULT_CONTROL_LIMITS,editorAckTimeoutMs:700,snapshotLifetimeMs:100,moveMaxMs:0}});
    assert.deepEqual(changed,{ack:700,life:100,motion:0});
    await assert.rejects(worker.run(NATIVE_TARGET_GUARD_PS,5000,{controlLimits:{snapshotLifetimeMs:100},target:{capturedAt:Date.now()-1000}}),/queued snapshot expired/);
    assert.equal((await worker.run(probe,5000,{})).ack,DEFAULT_CONTROL_LIMITS.editorAckTimeoutMs);
  }finally{worker.stop();}
});
