import test from 'node:test';
import assert from 'node:assert/strict';
import {createControlRuntime,compactReceipt,validatePlan} from '../src/control-runtime.js';
const target={surface:'browser',tabId:'fixture'};
const locator={selector:'#fixture'};

test('a website dialog stops the plan before verification or a second input',async()=>{
  let calls=0;const dialog={id:'one',type:'confirm'};
  const result=await createControlRuntime().run({target,steps:[{action:'click',locator,expect:{kind:'exists'}},{action:'click',locator}]},{target:async()=>{},act:async()=>{calls++;return {success:true,needsDialogResponse:true,dialog,next:'Answer the dialog'}},inspect:async()=>{throw Error('must not evaluate a suspended page')}});
  assert.equal(calls,1);assert.equal(result.success,false);assert.equal(result.needsDialogResponse,true);assert.equal(result.dialog.id,'one');assert.equal(result.receipts[0].dispatched,true);assert.equal(result.receipts[0].verified,false);
});
test('an absent control cannot satisfy a matching value or permit the next input',async()=>{
  let calls=0,reads=0;const runtime=createControlRuntime();
  const result=await runtime.run({target,steps:[{action:'fill',locator,value:'hello',timeoutMs:0,expect:{kind:'value',equals:'hello'}},{action:'click',locator,when:{kind:'exists'}}]}, {
    target:async()=>{},act:async()=>{calls++;return {success:true}},inspect:async()=>{reads++;return {available:true,exists:false,value:'hello'}}
  });
  // An absent control cannot satisfy a value condition.
  assert.equal(result.success,false);assert.equal(calls,1);assert.equal(reads,1);
});
test('delayed field verification dispatches once',async()=>{
  let calls=0,reads=0;const runtime=createControlRuntime();
  const result=await runtime.run({target,steps:[{action:'fill',locator,value:'done',expect:{kind:'value',equals:'done'},timeoutMs:500}]},{target:async()=>{},act:async()=>{calls++;return {success:true}},inspect:async()=>({available:true,exists:true,value:++reads>1?'done':'pending'})});
  assert.equal(result.success,true);assert.equal(calls,1);assert.equal(result.receipts[0].verified,true);
});
test('unknown later action is rejected before the first mutation',async()=>{
  let calls=0;await assert.rejects(createControlRuntime().run({target,steps:[{action:'click',locator},{action:'evaluate',script:'bad'}]},{act:async()=>calls++}),/Unknown/);assert.equal(calls,0);
});
test('a failed outcome stops the next action and exposes uncertain dispatch',async()=>{
  let calls=0;const result=await createControlRuntime().run({target,steps:[{action:'click',locator,expect:{kind:'exists'},timeoutMs:0},{action:'click',locator}]},{target:async()=>{},act:async()=>{calls++;return {success:true}},inspect:async()=>({available:true,exists:false})});
  assert.equal(calls,1);assert.equal(result.success,false);assert.equal(result.receipts[0].dispatched,true);
});
test('another controller cannot interleave while the original waits',async()=>{
  const runtime=createControlRuntime();let release;const first=runtime.exclusive({owner:'one'},()=>new Promise(r=>release=r));
  await assert.rejects(runtime.exclusive({owner:'two'},async()=>{}),/control_busy/);release();await first;
  await runtime.exclusive({owner:'two'},async()=>{});
});
test('pause interrupts verification and never permits the next input',async()=>{
  let paused=false,calls=0;const runtime=createControlRuntime({isPaused:()=>paused,setPaused:p=>paused=p});
  const result=await runtime.run({target,steps:[{action:'click',locator,expect:{kind:'exists'}},{action:'click',locator}]},{target:async()=>{},act:async()=>{calls++;runtime.pause();return {success:true}},inspect:async()=>({available:true,exists:true})});
  assert.equal(calls,1);assert.equal(result.success,false);assert.match(result.error,/control_cancelled/);runtime.resume();assert.equal(paused,false);
});

test('pause and immediate resume permanently cancel the old plan without releasing its lock early',async()=>{
  let paused=false,calls=0,finish;
  const runtime=createControlRuntime({isPaused:()=>paused,setPaused:value=>paused=value});
  const running=runtime.run({target,steps:[{action:'click',locator},{action:'click',locator}]},{target:async()=>{},act:async()=>{calls++;return new Promise(resolve=>finish=resolve)}});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  runtime.pause();runtime.resume();
  await assert.rejects(runtime.exclusive({owner:'other'},async()=>{}),/control_busy/);
  finish({success:true});const result=await running;
  assert.equal(calls,1);assert.equal(result.success,false);assert.match(result.error,/control_cancelled/);
  assert.equal(result.receipts[0].dispatched,true);assert.equal(result.receipts[0].inputMayHaveOccurred,true);
  await runtime.exclusive({owner:'fresh'},async()=>runtime.check());
});

test('stop during target inspection prevents the first input and retains a paused status',async()=>{
  let paused=false,calls=0;
  const runtime=createControlRuntime({isPaused:()=>paused,setPaused:value=>paused=value});
  const result=await runtime.run({target,steps:[{action:'click',locator}]},{target:async()=>runtime.pause(),act:async()=>calls++});
  assert.equal(calls,0);assert.equal(result.success,false);assert.equal(result.receipts[0].inputMayHaveOccurred,false);
  assert.equal(runtime.status().phase,'paused');assert.equal(runtime.status().busy,false);
});

test('stop during the last input reports that input without claiming a completed workflow',async()=>{
  let paused=false;
  const runtime=createControlRuntime({isPaused:()=>paused,setPaused:value=>paused=value});
  const result=await runtime.run({target,steps:[{action:'click',locator}]},{target:async()=>{},act:async()=>{runtime.pause();return {success:true}}});
  assert.equal(result.success,false);assert.match(result.error,/control_cancelled/);assert.equal(result.receipts[0].dispatched,true);
});
test('exact target and condition schemas reject missing identities and unbounded waits',()=>{
  assert.throws(()=>validatePlan({target:{surface:'desktop'},steps:[{action:'click'}]}),/windowHandle/);
  assert.throws(()=>validatePlan({target,steps:[{action:'wait'}]}),/expect/);
  assert.throws(()=>validatePlan({target,steps:[{action:'wait',expect:{kind:'exists',locator},timeoutMs:Infinity}]}),/timeoutMs/);
});
test('diagnostics bound images and remove sensitive content recursively',()=>{
  const result=compactReceipt({result:{base64:'x'.repeat(500000),value:'private',url:'https://example.com/private?token=secret',token:'secret'},steps:[{value:'typed',expect:{equals:'typed'}}]});
  const json=JSON.stringify(result);assert.ok(json.length<500);assert.ok(!json.includes('secret'));assert.ok(!json.includes('typed'));assert.ok(!json.includes('/private'));
});
test('malformed later semantic action prevents all input',async()=>{
  let calls=0;await assert.rejects(createControlRuntime().run({target,steps:[{action:'click',locator},{action:'check',locator,value:'yes'}]},{act:async()=>calls++}),/true or false/);assert.equal(calls,0);
});
test('transport failure reports possible input without claiming dispatch confirmation',async()=>{
  const r=await createControlRuntime().run({target,steps:[{action:'click',locator}]},{target:async()=>{},act:async()=>{throw Error('transport lost')}});
  assert.equal(r.success,false);assert.equal(r.receipts[0].inputMayHaveOccurred,true);assert.equal(r.receipts[0].dispatched,false);
});
test('an action that returns after the deadline cannot claim workflow success',async()=>{
  const r=await createControlRuntime().run({target,timeoutMs:10,steps:[{action:'click',locator}]},{target:async()=>{},act:async()=>{await new Promise(r=>setTimeout(r,25));return {success:true}}});
  assert.equal(r.success,false);assert.equal(r.receipts[0].dispatched,true);assert.match(r.error,/deadline/);
});

test('conditions inherit the step locator without mutating the submitted plan',async()=>{
  const plan={target,steps:[{action:'fill',locator,value:'done',when:{kind:'exists'},expect:{kind:'value',equals:'done'}}]};
  const original=JSON.stringify(plan);const inspected=[];
  const result=await createControlRuntime().run(plan,{
    target:async()=>{},act:async()=>({success:true}),
    inspect:async(_target,condition)=>{assert.deepEqual(condition.locator,locator);inspected.push(condition.kind);return {available:true,exists:true,value:'done'};}
  });
  assert.equal(result.success,true);assert.deepEqual(inspected,['exists','value']);assert.equal(JSON.stringify(plan),original);
});

test('invalid later condition rejects before any earlier input is dispatched',async()=>{
  let calls=0;
  await assert.rejects(createControlRuntime().run({target,steps:[{action:'click',locator},{action:'wait',expect:{kind:'text',equals:'Saved'}}]}, {target:async()=>{},act:async()=>calls++}),/locator/i);
  assert.equal(calls,0);
  for(const key of ['expect','when'])for(const condition of [null,false,'']){
    await assert.rejects(createControlRuntime().run({target,steps:[{action:'click',locator},{action:'click',locator,[key]:condition}]},{act:async()=>calls++}),/condition kind/);
  }
  assert.equal(calls,0);
});

test('explicit condition targets remain distinct and URLs need no locator',()=>{
  const result=validatePlan({target,steps:[{action:'click',locator,expect:{kind:'text',locator:{selector:'#status'},equals:'Saved'}},{action:'wait',expect:{kind:'url',contains:'done'}}]});
  assert.deepEqual(result.steps[0].expect.locator,{selector:'#status'});assert.equal(result.steps[1].expect.locator,undefined);
  assert.throws(()=>validatePlan({target,steps:[{action:'click',locator,expect:{kind:'exists',locator:{}}}]}),/locator/i);
});
