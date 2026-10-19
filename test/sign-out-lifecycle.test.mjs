import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const start=source.indexOf("  if (url.pathname === '/api/install/sign-out'");
const code=transformSync(`async function route(){${source.slice(start,source.indexOf("  if (url.pathname === '/api/install/pair-status'",start))}}`,{loader:'ts'}).code;
async function run(retirement){
 const events=[];let status,body;
 const context=vm.createContext({url:{pathname:'/api/install/sign-out'},req:{method:'POST'},
  res:{writeHead:n=>{status=n},end:s=>{body=JSON.parse(s)}},
  revokeCurrentDeviceCredential:async()=>{events.push('retire');return retirement},
  stopPairPoll:()=>events.push('stop-pairing'),clearBridgeAuth:()=>events.push('clear'),restartAfterPairing:()=>events.push('restart')});
 vm.runInContext(code,context);await context.route();return {events,status,body};
}
test('failed retirement retains the sign-in and offers retry without a false logout',async()=>{
 const result=await run({attempted:true,revoked:false,status:503});
 assert.deepEqual(result.events,['retire']);assert.equal(result.status,502);assert.equal(result.body.ok,false);assert.match(result.body.error,/try signing out again/);
});
test('successful or unnecessary retirement stops pending pairing before clearing auth',async()=>{
 for(const outcome of [{attempted:true,revoked:true},{attempted:false},{attempted:true,revoked:true,alreadyRevoked:true}]){
  const result=await run(outcome);assert.deepEqual(result.events,['retire','stop-pairing','clear','restart']);assert.equal(result.status,200);assert.equal(result.body.ok,true);
 }
});
