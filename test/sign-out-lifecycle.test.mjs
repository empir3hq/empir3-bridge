import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const start=source.indexOf("  if (url.pathname === '/api/install/sign-out'");
const code=transformSync(`async function route(){${source.slice(start,source.indexOf("  if (url.pathname === '/api/install/pair-status'",start))}}`,{loader:'ts'}).code;
async function run(retirement){
 const events=[];const queued=[];let status,body;
 const context=vm.createContext({url:{pathname:'/api/install/sign-out'},req:{method:'POST'},console:{log(){},warn(){}},
  res:{writeHead:n=>{status=n},end:s=>{body=JSON.parse(s)}},
  revokeCurrentDeviceCredential:async()=>{events.push('retire');return retirement},
  queuePendingRetire:entry=>{events.push('queue');queued.push(entry);return true},
  stopPairPoll:()=>events.push('stop-pairing'),clearBridgeAuth:()=>events.push('clear'),restartAfterPairing:()=>events.push('restart')});
 vm.runInContext(code,context);await context.route();return {events,queued,status,body};
}

// Card 8c9c2aab. On 2026-10-24 the owner could not sign out of any Bridge: the
// server answered 429, and this route used to keep the sign-in on anything but a
// confirmed retirement. A Bridge signed in to a development server that is down
// had the same trap. Sign-out now always completes on the computer; the server
// credential is queued for retirement and the reply says it is not yet retired.
test('a server that cannot confirm (429, 5xx, unreachable) no longer blocks sign-out; the credential is queued and the reply is honest',async()=>{
 for(const outcome of [
  {attempted:true,revoked:false,status:429,pending:{deviceToken:'e3dt_a',serverUrl:'https://app.empir3.com'}},
  {attempted:true,revoked:false,status:503,pending:{deviceToken:'e3dt_b',serverUrl:'https://app.empir3.com'}},
  {attempted:true,revoked:false,reason:'service-unavailable',pending:{deviceToken:'e3dt_c',serverUrl:'http://localhost:3005'}},
 ]){
  const result=await run(outcome);
  assert.deepEqual(result.events,['retire','queue','stop-pairing','clear','restart']);
  assert.equal(result.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.serverRetired,false);
  assert.match(result.body.message,/Signed out on this computer/);assert.match(result.body.message,/retired automatically/);
  assert.equal(result.queued[0].deviceToken,outcome.pending.deviceToken);
 }
});
test('the reply names why the server did not confirm',async()=>{
 assert.match((await run({attempted:true,revoked:false,status:429,pending:{deviceToken:'x'}})).body.message,/answered 429/);
 assert.match((await run({attempted:true,revoked:false,reason:'service-unavailable',pending:{deviceToken:'x'}})).body.message,/could not be reached/);
});
test('successful or unnecessary retirement stops pending pairing before clearing auth and queues nothing',async()=>{
 for(const outcome of [{attempted:true,revoked:true},{attempted:false},{attempted:true,revoked:true,alreadyRevoked:true}]){
  const result=await run(outcome);assert.deepEqual(result.events,['retire','stop-pairing','clear','restart']);assert.equal(result.status,200);assert.equal(result.body.ok,true);
  assert.equal(result.body.serverRetired,true);assert.match(result.body.message,/retired on the server/);
 }
});
