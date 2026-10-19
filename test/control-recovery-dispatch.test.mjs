import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createControlRuntime} from '../src/control-runtime.js';

const source=ts.createSourceFile('server.ts',readFileSync(new URL('../src/server.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
function load(names,bindings) {
  const functions=names.map(name=>source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(source));
  assert.ok(functions.every(Boolean));
  const ctx=vm.createContext({setTimeout,clearTimeout,AbortController,...bindings});
  vm.runInContext(ts.transpileModule(functions.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  return ctx;
}

for(const stage of ['headers','body'])test(`stalled browser ${stage} times out without repeating uncertain input`,async()=>{
  let calls=0;
  const ctx=load(['cdpPost'],{BRIDGE_URL:'http://fixture',controlRuntime:createControlRuntime(),
    getControlLimits:()=>({browserCommandTimeoutMs:20}),updateCdpReachabilityFromBody:()=>assert.fail('no success receipt'),
    isBridgeNotReadyError:()=>false,fetch:async(_url,{signal})=>{
      calls++;
      const stalled=()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
      return stage==='headers'?stalled():{ok:true,json:stalled};
    }});
  await assert.rejects(ctx.cdpPost('/click',{}),/aborted/);
  assert.equal(calls,1);
});

test('local stop aborts an in-flight browser body and frees its lease',async()=>{
  let entered,paused=false;
  const runtime=createControlRuntime({isPaused:()=>paused,setPaused:v=>paused=v});
  const ctx=load(['cdpPost'],{BRIDGE_URL:'http://fixture',controlRuntime:runtime,
    getControlLimits:()=>({browserCommandTimeoutMs:5000}),updateCdpReachabilityFromBody:()=>assert.fail('no success receipt'),
    fetch:async(_url,{signal})=>({ok:true,json:()=>new Promise((_,reject)=>{
      entered=true;signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
    })})});
  const request=runtime.exclusive({owner:'stuck'},()=>ctx.cdpPost('/click',{}));
  while(!entered)await new Promise(r=>setImmediate(r));
  runtime.pause();await assert.rejects(request,/aborted/);
  assert.equal(runtime.status().busy,false);assert.equal(paused,true);
});

test('release and diagnostics bypass a busy GUI lease; ordinary input still waits',async()=>{
  const runtime=createControlRuntime();let finish;
  const running=runtime.exclusive({owner:'busy'},()=>new Promise(r=>finish=r));
  const ctx=load(['handleGuiCommand'],{controlRuntime:runtime,executeCommand:async cmd=>({type:cmd.type}),
    handleGuiCommandCore:()=>assert.fail('must not dispatch competing input')});
  assert.equal((await ctx.handleGuiCommand('release_focus')).type,'desktop_release_focus');
  assert.equal((await ctx.handleGuiCommand('control_status')).type,'control_status');
  await assert.rejects(ctx.handleGuiCommand('click'),/control_busy/);
  finish();await running;
});

test('permission toggles cannot block release but still block input',()=>{
  const ctx=load(['enforceCommandPolicy'],{requiredBridgePermission:()=> 'execute',hasBridgePermission:()=>false,
    permissionDenied:()=>({success:false,error:'disabled'})});
  for(const type of ['desktop_release_focus','safety_lockdown'])assert.equal(ctx.enforceCommandPolicy({type},'mcp'),null);
  assert.equal(ctx.enforceCommandPolicy({type:'desktop_click'},'mcp').success,false);
});
