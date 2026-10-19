import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

// Exercise the actual shipping background poll, with time and network under
// test control. No account or credential is created by these tests.
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const code=transformSync(source.slice(source.indexOf('function stopPairPoll('),source.indexOf('// Cache last snapshot')), {loader:'ts'}).code;
function harness(request, save=()=>{}) {
  const timers=[];let calls=0,saves=0,restarts=0;
  const ctx=vm.createContext({activePairPoll:null,EMPIR3_SERVER:'https://example.com',
    normalizeEmpir3Server:s=>s,classifyEmpir3Server:()=> 'production',normalizeEmpir3WsUrl:()=> 'wss://example.com',
    requestJson:async(...args)=>{calls++;assert.equal(args[4],5000);return request(...args)},
    revokePriorDeviceCredential:async()=>({attempted:false}),saveBridgeAuth:a=>{saves++;save(a)},clearStandaloneMode:()=>{},
    setInterval:fn=>{timers.push(fn);return timers.length},clearInterval:()=>{},setTimeout:()=>0,console});
  vm.runInContext(code+'\nrestartAfterPairing=()=>onRestart();',ctx);
  ctx.onRestart=()=>{restarts++};
  return {start:()=>ctx.startPairPoll('test-code'),tick:()=>timers.at(-1)(),state:()=>ctx.activePairPoll,stats:()=>({calls,saves,restarts})};
}
for(const [name,response] of [['pending',{status:200,body:{status:'pending'}}],['server error',{status:503,body:null}],['unknown response',{status:200,body:{status:'surprise'}}],['network error',null]]) {
  test(`pairing ${name} stops at the same bounded attempt limit`,async()=>{
    const h=harness(async()=>{if(!response)throw Error('network');return response});h.start();
    for(let i=0;i<305;i++)await h.tick();
    assert.deepEqual(h.stats(),{calls:300,saves:0,restarts:0});
    assert.equal(h.state().lastStatus,'timed_out');assert.equal(h.state().timer,null);
  });
}
test('save failure is terminal and can never be reported as claimed or retried',async()=>{
  const h=harness(async()=>({status:200,body:{status:'claimed',token:'test-only',userId:'test-user'}}),()=>{throw Error('disk denied')});
  h.start();await h.tick();await h.tick();
  assert.equal(h.state().lastStatus,'save_failed');assert.equal(h.state().timer,null);
  assert.deepEqual(h.stats(),{calls:1,saves:1,restarts:0});
});
test('a malformed claim does not persist auth or restart',async()=>{
  const h=harness(async()=>({status:200,body:{status:'claimed'}}));h.start();await h.tick();
  assert.equal(h.state().lastStatus,'invalid_response');assert.deepEqual(h.stats(),{calls:1,saves:0,restarts:0});
});
test('an expired link replaces an earlier retrying message with terminal recovery',async()=>{
  let expired=false;const h=harness(async()=>expired?{status:404,body:null}:{status:503,body:null});
  h.start();await h.tick();assert.equal(h.state().lastStatus,'retrying');
  expired=true;await h.tick();assert.equal(h.state().lastStatus,'expired');
  assert.match(h.state().lastError,/expired.*Start sign-in again/);assert.doesNotMatch(h.state().lastError,/Retrying/);
  assert.equal(h.state().timer,null);assert.deepEqual(h.stats(),{calls:2,saves:0,restarts:0});
});
test('successful claim saves and restarts exactly once',async()=>{
  const h=harness(async()=>({status:200,body:{status:'claimed',token:'test-only',userId:'test-user'}}));h.start();await h.tick();await h.tick();
  assert.equal(h.state().lastStatus,'claimed');assert.deepEqual(h.stats(),{calls:1,saves:1,restarts:1});
});
test('slow requests never overlap and a replaced attempt cannot save old auth',async()=>{
  let release;const h=harness(()=>new Promise(r=>{release=r}));h.start();const old=h.state();
  const first=h.tick();await h.tick();assert.equal(h.stats().calls,1);
  h.start();release({status:200,body:{status:'claimed',token:'old-test-only',userId:'old-user'}});await first;
  assert.equal(old.stopped,true);assert.equal(h.state().lastStatus,'pending');assert.equal(h.stats().saves,0);
});
test('pair status reports active polling from its timer, retaining terminal state',()=>{
  const endpoint=source.slice(source.indexOf("if (url.pathname === '/api/install/pair-status')"),source.indexOf("if (url.pathname === '/api/reliability')"));
  assert.match(endpoint,/polling: !!activePairPoll\?\.timer/);
});
