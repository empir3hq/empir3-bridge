import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createControlRuntime} from '../src/control-runtime.js';

const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const start=source.indexOf("  if (url.pathname.startsWith('/api/control/')) {");
const end=source.indexOf("  if (url.pathname === '/'",start);
assert.ok(start>0&&end>start);
const code=ts.transpileModule('async function handler(){'+source.slice(start,end)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(){
  let paused=false,cleanups=0,hidden=0;
  const runtime=createControlRuntime({isPaused:()=>paused,setPaused:value=>paused=value});
  return {runtime,get cleanups(){return cleanups},get hidden(){return hidden},async request({nonce=true,path='release',method='POST'}={}){
    let status,body;
    const context=vm.createContext({
      req:{method},url:{pathname:'/api/control/'+path},
      requestHasBridgeNonce:()=>nonce,controlRuntime:runtime,
      controlPresence:{hide(){hidden++}},
      desktopReleaseFocus:async()=>{assert.equal(runtime.status().paused,true);cleanups++;return {released:true,cleaned:{focus:true,pointer:true}}},
      executeCommand:()=>{throw Error('A local stop must bypass the agent action queue')},
      res:{writeHead:value=>status=value,end:value=>body=JSON.parse(value)},
    });
    vm.runInContext(code,context);await context.handler();return {status,body};
  }};
}

test('trusted local release works during a busy action, repeats while paused and leaves permissions untouched',async()=>{
  const f=fixture();let complete;
  const running=f.runtime.exclusive({owner:'fixture'},async()=>{await new Promise(resolve=>complete=resolve);f.runtime.check()});
  const result=await f.request();
  assert.equal(result.status,200);assert.equal(result.body.success,true);assert.equal(result.body.paused,true);assert.equal(result.body.busy,true);
  assert.equal(f.cleanups,1);assert.equal(f.hidden,1);
  assert.equal((await f.request()).status,200);assert.equal(f.cleanups,2);
  await f.request({path:'resume'});complete();await assert.rejects(running,/control_cancelled/);
  await f.runtime.exclusive({owner:'new'},async()=>f.runtime.check());
});

test('untrusted or non-POST release requests cannot pause or clear anything',async()=>{
  for(const options of [{nonce:false},{method:'GET'}]){
    const f=fixture(),result=await f.request(options);
    assert.equal(result.status,400);assert.match(result.body.error,/trusted local/);
    assert.equal(f.runtime.status().paused,false);assert.equal(f.cleanups,0);assert.equal(f.hidden,0);
  }
});
