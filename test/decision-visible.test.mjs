import test from 'node:test';
import assert from 'node:assert/strict';
import {DecisionSettings} from '../src/decision-settings.ts';
import {createBridgeDecider,resolveDecisionConfig,runBrowserAct} from '../src/browser-act.ts';
const body={state:'Choose next',questions:{target:{type:'choice',instructions:'Choose Match',criteria:{e1:'Match',none:'None'}}}};
function harness({paired=true,enabled=true,env={},settings={},failure=false}={}) {
  let account='owner-a',current=structuredClone(settings),on=enabled;const posts=[],health=[],relays=[];
  const fetchImpl=async(url,init={})=>{
    if(url.endsWith('/health')) {health.push(url);return Response.json({max_input_tokens:4096});}
    const b=JSON.parse(init.body);posts.push({url,body:b,headers:init.headers});
    if(failure) return Response.json({detail:'Engine refused FAKE_KEY'},{status:401});
    return Response.json({answers:Object.fromEntries(Object.entries(b.questions).map(([name,q])=>{const choice=Object.keys(q.criteria).find(k=>k!=='none');return [name,{choice,confidence:0.99,probabilities:{[choice]:0.99}}];}))});
  };
  const controller=new DecisionSettings({env,readSettings:()=>current,enabled:()=>on,account:()=>({paired,key:account}),
    saveModel:model=>{if(model===null)delete current.decisionModel;else current.decisionModel=model;},saveEngine:engine=>current.lastDecisionEngine=engine,
    relay:async b=>{relays.push(b);return {success:true,answers:{target:{choice:'e1',confidence:0.99}},engine:{model:'typesafe/jev-1.13',provider:'openrouter'},backupUsed:false};},fetchImpl});
  return {controller,posts,health,relays,settings:()=>current,setEnabled:x=>on=x,setAccount:x=>account=x};
}
test('disabled Decisions refuse before any local or paired request',async()=>{
  for(const settings of [{},{decisionModel:{url:'http://engine.test',apiKey:'FAKE_KEY'}}]) {
    const h=harness({enabled:false,settings});assert.equal(h.controller.state().enabled,false);
    const r=await h.controller.dispatch(body);assert.equal(r.code,'TOOL_DISABLED');assert.equal(r.decisionCalls,0);
    assert.equal(h.health.length+h.posts.length+h.relays.length,0);
    await assert.rejects(h.controller.testAndSave({url:'http://engine.test'}),/disabled locally/);
    assert.equal(h.health.length+h.posts.length,0);
  }
});
test('status never bills; a real account decision supplies displayed engine metadata',async()=>{
  const h=harness();assert.equal(h.controller.state().sourceLabel,"Empir3 (your plan's engine)");assert.equal(h.relays.length,0);
  await h.controller.dispatch(body);assert.equal(h.controller.state().empir3.engine.name,'Jev 1.13');
  h.setAccount('owner-b');assert.equal(h.controller.state().empir3.engine,null);
});
test('an unchecked configured engine falls back to Empir3 and an unpaired one becomes unavailable',async()=>{
  for(const paired of [true,false]) {const h=harness({paired,settings:{decisionModel:{url:'http://engine.test',enabled:false}}});
    assert.equal(h.controller.state().source,paired?'empir3':'unavailable');await h.controller.dispatch(body);
    assert.equal(h.posts.length,0);assert.equal(h.relays.length,paired?1:0);
  }
});
test('environment source is visible and its checkbox can stop the override',async()=>{
  const h=harness({env:{EMPIR3_DECISION_URL:'http://env.test',EMPIR3_DECISION_API_KEY:'ENV_FAKE_KEY'},settings:{decisionModel:{name:'Other',url:'http://stored.test'}}});
  assert.match(h.controller.state().sourceLabel,/from environment/);assert.equal(h.controller.state().local.url,'http://env.test');
  assert.doesNotMatch(JSON.stringify(h.controller.state()),/ENV_FAKE_KEY/);
  h.controller.toggleLocal(false);assert.equal(h.controller.state().source,'empir3');await h.controller.dispatch(body);assert.equal(h.posts.length,0);
  await assert.rejects(h.controller.testAndSave({url:'http://engine.test'}),/environment/);
});

test('an invalid environment override stays visible and cannot silently use a stored engine',()=>{
  const h=harness({env:{EMPIR3_DECISION_URL:'file:///engine'},settings:{decisionModel:{url:'http://stored.test'}}});
  assert.equal(h.controller.state().source,'unavailable');assert.equal(h.controller.state().local.source,'env');
  assert.equal(h.controller.state().local.url,'file:///engine');assert.equal(h.controller.state().local.valid,false);
  h.controller.toggleLocal(false);assert.equal(h.controller.state().source,'empir3');
});

test('blank environment values do not hide a stored engine, and credentials belong in the separate key field',async()=>{
  const h=harness({env:{EMPIR3_DECISION_URL:'  '},settings:{decisionModel:{url:'http://engine.test'}}});
  assert.equal(h.controller.state().local.configured,true);assert.equal(h.controller.state().local.source,'settings');assert.equal(h.controller.state().local.editable,true);
  await h.controller.testAndSave({url:'http://engine.test'});
  for(const url of ['https://user:PRIVATE_PASS@engine.test','http://engine.test?key=PRIVATE_PASS']){
    const bad=harness({env:{EMPIR3_DECISION_URL:url}});assert.equal(bad.controller.state().source,'unavailable');
    assert.doesNotMatch(JSON.stringify(bad.controller.state()),/PRIVATE_PASS/);assert.equal((await bad.controller.dispatch(body)).decisionCalls,0);
  }
});
test('adding an engine validates a decision before saving and never publishes its key',async()=>{
  const h=harness();const r=await h.controller.testAndSave({name:'Nimble',url:'http://engine.test/',model:'nimble-latest',apiKey:'FAKE_KEY'});
  assert.equal(r.testPassed,true);assert.equal(h.settings().decisionModel.apiKey,'FAKE_KEY');
  assert.doesNotMatch(JSON.stringify(r),/FAKE_KEY/);assert.equal(r.decisions.source,'settings');
  assert.equal(h.posts[0].body.state,'Connection test. The correct answer is READY.');
  assert.equal(h.posts[0].headers.Authorization,'Bearer FAKE_KEY');
  h.controller.toggleLocal(false);await h.controller.dispatch(body);assert.equal(h.relays.length,1);
});
test('invalid address, failed test and engine errors preserve existing settings and redact keys',async()=>{
  const h=harness({failure:true,settings:{decisionModel:{url:'http://old.test',enabled:false}}});
  for(const url of ['file:///engine','https://user:pass@engine.test','http://engine.test?key=abc']) await assert.rejects(h.controller.testAndSave({url}),/HTTP or HTTPS/);
  assert.equal(h.posts.length,0);
  await assert.rejects(h.controller.testAndSave({url:'http://engine.test',apiKey:'FAKE_KEY'}),error=>/\[(redacted|key omitted)\]/.test(error.message)&&!error.message.includes('FAKE_KEY'));
  assert.equal(h.settings().decisionModel.url,'http://old.test');assert.equal(h.settings().decisionModel.enabled,false);
});
test('daemon dispatch sends no client metadata or entered text and health stays cached across calls',async()=>{
  const h=harness({settings:{decisionModel:{url:'http://engine.test'}}});
  for(let i=0;i<2;i++) {const r=await h.controller.dispatch({...body,type:'decision_dispatch',text:'PRIVATE_ENTERED_TEXT'});assert.equal(r.success,true);assert.equal(r.decisionCalls,1);}
  assert.equal(h.health.length,1);assert.equal(h.posts.length,2);assert.doesNotMatch(JSON.stringify(h.posts),/PRIVATE_ENTERED_TEXT|decision_dispatch/);
});
test('remote decider preserves actual attempts including failure without double counting',async()=>{
  let calls=0;const failed=createBridgeDecider(async()=>({success:false,error:'failed',decisionCalls:3}));
  await assert.rejects(failed(body,()=>calls++),/failed/);assert.equal(calls,3);
  const good=createBridgeDecider(async()=>({success:true,answers:{},decisionCalls:2}));await good(body,()=>calls++);assert.equal(calls,5);
});
test('removing a configured engine restores the account source without widening permission',()=>{
  const h=harness({enabled:false,settings:{decisionModel:{url:'http://engine.test',apiKey:'FAKE_KEY'}}});
  const state=h.controller.removeLocal();assert.equal(state.source,'empir3');assert.equal(state.enabled,false);assert.equal(h.settings().decisionModel,undefined);
});

test('console edits retain the input budget, timeout and stricter confidence floor',async()=>{
  const h=harness({settings:{decisionModel:{url:'http://engine.test',maxInputTokens:2048,minConfidence:0.85,timeoutMs:15000}}});
  await h.controller.testAndSave({url:'http://engine.test',name:'My engine',model:'nimble-latest'});
  assert.equal(h.controller.config().maxInputTokens,2048);assert.equal(h.controller.config().timeoutMs,15000);
  h.controller.toggleLocal(false);assert.equal(h.controller.config().minConfidence,0.85);
});

test('MCP-to-daemon decisions still pack small-engine requests and report every actual POST',async()=>{
  const h=harness({settings:{decisionModel:{url:'http://engine.test'}}});
  const nodes=Array.from({length:120},(_,i)=>({ref:`e${i}`,role:'link',name:`${i+1} comments`,context:`Story ${i+1}: a descriptive news headline for this item`,itemOrder:i+1,itemTotal:120}));
  for(let round=0;round<2;round++) {
    const before=h.posts.length;
    const result=await runBrowserAct({goal:'open the comments of the third story',dryRun:true},h.controller.config(),{
      command:async cmd=>cmd.type==='snapshot'?{nodes}:{success:true,title:'News'},decide:createBridgeDecider(body=>h.controller.dispatch(body))});
    assert.equal(result.success,true,result.error);assert.equal(result.decisionCalls,h.posts.length-before);assert.ok(result.decisionCalls>2);
  }
  assert.equal(h.health.length,1);assert.ok(h.posts.every(p=>JSON.stringify(p.body).length/2<=4096*0.85));
  assert.deepEqual(Object.keys(h.posts.at(-1).body.questions),['target']);
});
test('local-engine disable applies to direct config resolution, including environment precedence',()=>{
  assert.equal(resolveDecisionConfig({EMPIR3_DECISION_URL:'http://engine.test'},{decisionModel:{enabled:false}},true).source,'empir3');
  assert.equal(resolveDecisionConfig({}, {decisionModel:{url:'http://engine.test',enabled:false}},false),null);
});
