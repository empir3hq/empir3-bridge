import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/bridge.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('bridge.ts',source,ts.ScriptTarget.Latest,true);
function extracted(name,context){
 const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(node);
 return vm.runInNewContext(ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+`;${name};`,context);
}
const user={id:'user',type:'page',url:'https://example.test/unsaved',webSocketDebuggerUrl:'ws://user'};
const welcome={id:'console',type:'page',url:'http://localhost:3006/welcome?bridgeNonce=old',webSocketDebuggerUrl:'ws://console'};
function selection(pages,currentTargetId='',created={id:'new-console',webSocketDebuggerUrl:'ws://new'}){
 const calls=[];
 const pick=extracted('pickInitialTarget',{URL,process:{env:{EMPIR3_BRIDGE_NONCE:'new nonce'}},CDP_PORT:9222,WRAPPER_PORT:3006,PORT:9867,currentTargetId,
  fetchJSON:async(url,method)=>{calls.push({url,method});return method==='PUT'?created:pages;},
 });return {pick,calls};
}
test('reconnect preserves the exact selected page even when a console exists',async()=>{
 const {pick,calls}=selection([welcome,user],'user');assert.equal(await pick(),user);assert.equal(calls.length,1);
});
test('new connection selects the restored console rather than the first user page',async()=>{
 const {pick,calls}=selection([user,welcome]);assert.equal(await pick(),welcome);assert.equal(calls.length,1);
});
test('missing console is created separately without navigating a restored user page',async()=>{
 const pages=[user];const before=JSON.stringify(pages);const {pick,calls}=selection(pages);
 assert.equal((await pick()).id,'new-console');assert.equal(JSON.stringify(pages),before);
 const create=calls.find(c=>c.method==='PUT');assert.equal(decodeURIComponent(new URL(create.url).search.slice(1)),'http://localhost:3006/welcome?bridgeNonce=new%20nonce');
});
test('another bridge port or foreign welcome page cannot be selected as our console',async()=>{
 const {pick}=selection([{...welcome,url:'http://localhost:3007/welcome'},{...user,url:'https://example.test/welcome'}]);
 assert.equal((await pick()).id,'new-console');
});
test('console creation failure refuses rather than replacing a restored page',async()=>{
 const {pick}=selection([user],'',{});await assert.rejects(pick(),/without replacing a restored page/);
});
test('incoming browser work waits for the existing launch gate before trusting page metadata',async()=>{
 let release,probes=0;
 const launchPromise=new Promise(resolve=>{release=resolve;});
 const ready=extracted('ensureChromeReady',{launchPromise,CHROME_LAUNCH_TIMEOUT_MS:30000,chromeClosedByUser:false,hasReachablePageTarget:async()=>{probes++;return true;},startTargetPolling:()=>{}});
 const work=ready();await Promise.resolve();assert.equal(probes,0);
 release();await work;assert.equal(probes,1);
});
