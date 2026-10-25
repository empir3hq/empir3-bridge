import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpDecider, resolveDecisionConfig, runBrowserAct} from '../src/browser-act.ts';

const config={url:'http://engine.test',model:'nimble-latest',minConfidence:0.6,timeoutMs:1000,source:'env'};
const nodes=Array.from({length:120},(_,i)=>({ref:`e${i}`,role:'link',name:`${i+1} comments`,context:`Story ${i+1}: A sufficiently descriptive news headline for this item`,itemOrder:i+1,itemTotal:120}));
const bodyFor=(count=5)=>({model:config.model,state:'Goal: open the comments of the third story.',questions:Object.fromEntries(Array.from({length:count},(_,i)=>[`group_${i}`,{type:'choice',instructions:'Choose the matching control.',criteria:{[`e${i}`]:'Comments for '+('item context '.repeat(60)),none:'None'}}]))});
const answer=body=>({answers:Object.fromEntries(Object.entries(body.questions).map(([name,q])=>{const choice=Object.hasOwn(q.criteria,'e50')?'e50':Object.keys(q.criteria).find(k=>k!=='none');return [name,{choice,confidence:0.99,probabilities:{[choice]:0.99}}];}))});
function engine({healthLimit=4096,limit=healthLimit,reject,healthStatus=200}={}){
  const posts=[],health=[];
  const fetcher=async(url,init={})=>{
    if(url.endsWith('/health')){health.push({url,init});return Response.json(healthLimit?{max_input_tokens:healthLimit}:{},{status:healthStatus});}
    const body=JSON.parse(init.body);posts.push(body);
    const failure=reject?.(body,posts.length) || (limit&&JSON.stringify(body).length/2>limit?{status:400,detail:`Longest prompt is too long; limit is ${limit}`} : null);
    return failure?Response.json({detail:failure.detail,error:failure.error},{status:failure.status}):Response.json(answer(body));
  };
  return {fetcher,posts,health};
}
async function act(fake,cfg=config){
  const commands=[];
  const result=await runBrowserAct({goal:'open the comments of the third story'},cfg,{decide:createHttpDecider(cfg,fake.fetcher),command:async cmd=>{commands.push(cmd);if(cmd.type==='snapshot')return {nodes};if(cmd.type==='status')return {title:'News'};return {success:true};}});
  return {result,commands};
}

test('five HN-sized groups fit a discovered 4096 engine and preserve the unlimited final pick',async()=>{
  const small=engine(),unlimited=engine({healthLimit:null,limit:null});
  const a=await act(small),b=await act(unlimited);
  assert.equal(a.result.success,true,a.result.error);assert.equal(a.result.pick.ref,b.result.pick.ref);assert.equal(a.result.pick.ref,'e50');
  assert.ok(small.posts.length>2);assert.ok(small.posts.every(p=>JSON.stringify(p).length/2<=4096*0.85),'every packed request includes shared envelope in its budget');
  assert.equal(a.result.decisionCalls,small.posts.length);assert.deepEqual(Object.keys(small.posts.at(-1).questions),['target']);
  assert.equal(Object.keys(small.posts.at(-1).questions.target.criteria).length,6,'all five winners compared in one final question');
});
test('unknown limit keeps all groups in one request and one final round',async()=>{
  const f=engine({healthLimit:null,limit:null});const {result}=await act(f);assert.equal(result.success,true);assert.equal(f.posts.length,2);assert.equal(Object.keys(f.posts[0].questions).length,5);assert.equal(result.decisionCalls,2);
});
test('health is read once per endpoint and process across decider instances',async()=>{
  const f=engine({healthLimit:null,limit:null});await createHttpDecider(config,f.fetcher)(bodyFor());await createHttpDecider(config,f.fetcher)(bodyFor());assert.equal(f.health.length,1);
});
test('explicit env and settings limits override discovery, with env taking precedence',async()=>{
  const settings={decisionModel:{url:config.url,maxInputTokens:4096}};
  const s=resolveDecisionConfig({},settings);assert.equal(s.maxInputTokens,4096);
  const e=resolveDecisionConfig({EMPIR3_DECISION_MAX_INPUT_TOKENS:'2048'},settings);assert.equal(e.maxInputTokens,2048);
  const f=engine({limit:2048});await createHttpDecider(e,f.fetcher)(bodyFor());assert.equal(f.health.length,0);assert.ok(f.posts.every(p=>JSON.stringify(p).length/2<=2048*0.85));
  for(const value of ['0','-4','wat','Infinity'])assert.equal(resolveDecisionConfig({EMPIR3_DECISION_URL:config.url,EMPIR3_DECISION_MAX_INPUT_TOKENS:value},{}).maxInputTokens,undefined);
});
test('FastAPI too-long detail halves unknown-limit batches, keeps answer names and counts failed attempts',async()=>{
  const f=engine({healthLimit:null,limit:null,reject:body=>Object.keys(body.questions).length>2?{status:400,detail:'Longest prompt has 8260 tokens; limit is 4096'}:null});
  const {result}=await act(f);assert.equal(result.success,true,result.error);assert.equal(result.pick.ref,'e50');assert.equal(result.decisionCalls,f.posts.length);assert.equal(f.posts.length,6);
});
test('non-size 4xx and size-like 5xx never split or click',async()=>{
  for(const failure of [{status:401,error:'Invalid API key'},{status:400,detail:'Unknown model'},{status:503,detail:'context length service unavailable'}]){
    const f=engine({healthLimit:null,limit:null,reject:()=>failure});const {result,commands}=await act(f);assert.equal(result.reason,'decision_unavailable');assert.equal(result.decisionCalls,1);assert.equal(f.posts.length,1);assert.ok(!commands.some(c=>c.type==='click_ref'));assert.match(result.error,new RegExp(failure.error||failure.detail));
  }
});
test('an indivisible question still too long fails visibly and does not retry forever',async()=>{
  const f=engine({healthLimit:null,limit:null,reject:()=>({status:400,detail:'context length is too long; limit is 20'})});const {result,commands}=await act(f);assert.equal(result.reason,'decision_unavailable');assert.match(result.error,/limit is 20/);assert.ok(f.posts.length<=7);assert.equal(result.decisionCalls,f.posts.length);assert.ok(!commands.some(c=>c.type==='click_ref'));
});

test('engine error details cannot echo the configured API key into the action result',async()=>{
  const apiKey='private-engine-key';const f=engine({healthLimit:null,limit:null,reject:()=>({status:401,detail:'Rejected Bearer '+apiKey})});
  const {result}=await act(f,{...config,apiKey});assert.equal(result.decisionCalls,1);assert.match(result.error,/Rejected Bearer \[key omitted\]/);assert.ok(!JSON.stringify(result).includes(apiKey));
});
test('health failure is cached as unknown and leaves the direct decision available',async()=>{
  const f=engine({healthLimit:null,limit:null,healthStatus:404});await createHttpDecider(config,f.fetcher)(bodyFor());await createHttpDecider(config,f.fetcher)(bodyFor());assert.equal(f.health.length,1);assert.equal(f.posts.length,2);
});
test('split requests still omit entered text echoed into labels',async()=>{
  const secret='entered private text';const f=engine();const typedNodes=nodes.map(n=>({...n,role:'textbox',name:n.name+' '+secret}));
  const result=await runBrowserAct({goal:'the third field',text:secret},config,{decide:createHttpDecider(config,f.fetcher),command:async cmd=>cmd.type==='snapshot'?{nodes:typedNodes}:{success:true}});
  assert.equal(result.success,true,result.error);assert.ok(!JSON.stringify([...f.posts,...f.health]).includes(secret));assert.equal(result.decisionCalls,f.posts.length);
});
