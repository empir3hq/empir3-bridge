import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import concurrency from '../src/provider-concurrency.ts';
const {ProviderConcurrencyGate}=concurrency;
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
// runProcess lives in its own module since the detached-child fix (24fafb79);
// the contract still evaluates the ACTUAL production function.
const runProcessSource=readFileSync(new URL('../src/run-process.ts',import.meta.url),'utf8');
const runProcessAst=ts.createSourceFile('run-process.ts',runProcessSource,ts.ScriptTarget.Latest,true);
function functions(names){return names.map(name=>{
 const tree=name==='runProcess'?runProcessAst:ast;
 const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
 assert.ok(node,`Missing actual function ${name}`);
 return transformSync(node.getText(tree).replace(/^export\s+/,''),{loader:'ts',format:'cjs'}).code;
}).join('\n');}
function context(values,names){const c=vm.createContext(values);vm.runInContext(functions(names),c);return c;}

test('other lifecycle actions refuse a pending update and track their terminal completion',async()=>{
 const gate=new ProviderConcurrencyGate();let busy=true,receiptState='running',poll,launches=0;
 const c=context({Map,cliLifecycleActivity:new Map(),cliRestartCoordinator:{status:()=>busy?{pending:true}:null},cliRestartHasActiveWork:()=>busy,
  providerConcurrencyGate:gate,readCliActionReceipt:()=>({status:receiptState}),join:(...s)=>s.join('/'),homedir:()=>'/synthetic',
  setInterval:fn=>{poll=fn;return {unref(){}};},clearInterval:()=>{},
 },['cliLifecycleIsBusy','runCliLifecycleAction']);
 const launch=async()=>{launches++;return {ok:true,actionId:'owned-update'};};
 assert.equal((await c.runCliLifecycleAction('claude',launch)).ok,false);assert.equal(launches,0);
 busy=false;await c.runCliLifecycleAction('claude',launch);assert.equal(launches,1);
 assert.equal(c.cliLifecycleIsBusy('claude'),true);
 const releaseRestart=gate.pause('cli:claude');
 receiptState='completed';poll();
 assert.equal(c.cliLifecycleActivity.size,0);
 assert.equal(gate.tryAcquire('cli:claude','new',10),null);
 releaseRestart();assert.ok(gate.tryAcquire('cli:claude','new',10));
});

test('actual next-session preparation joins stale discovery and replaces only the selected version row',async()=>{
 let finishOld,probeCalls=0;
 const ids=['claude','codex','gemini','grok','agy','higgsfield','github'];
 const c=context({CLI_RESTART_IDS:ids,resolveProviderActionBinary:async()=>'/synthetic/claude',normalizeCliShim:s=>s,
  runSpawnedCliForText:async(_bin,args)=>{assert.deepEqual(Array.from(args),['--version']);return {code:0,stdout:'3.0.0',stderr:'',timedOut:false,outputLimited:false};},
  extractSemanticVersion:s=>/\d+\.\d+\.\d+/.exec(s)?.[0],
  _cliProbeInFlight:new Promise(r=>{finishOld=r;}),_cliLatestInFlight:null,
  _cliProbeCache:{at:1,value:ids.map(()=>({version:'2.0.0'}))},_cliLatestCache:{value:{claude:{latestVersion:'3.0.0',source:'test'}}},
  probeClaudeCli:async()=>{probeCalls++;return {available:true,version:'installed',device_opted_in:true};},
  probeCodexCli:()=>assert.fail('other provider probe'),probeGeminiCli:()=>{},probeGrokCli:()=>{},probeAgyCli:()=>{},probeHiggsfieldCli:()=>{},probeGithubCli:()=>{},
  claudeAuthSignal:()=>({authenticated:true}),codexAuthSignal:()=>{},geminiAuthSignal:()=>{},grokAuthSignal:()=>{},agyAuthSignal:()=>{},
  latestRow:(installedVersion,latestVersion,source)=>({installedVersion,latestVersion,source,status:installedVersion===latestVersion?'current':'update_available'}),
  checkOneCliLatest:async(provider,probe)=>{assert.equal(provider,'claude');return {installedVersion:probe.version,latestVersion:'3.0.0',status:'current'};},Date,
  companionCapabilityCache:{old:true},companionCapabilityCacheTime:1,
 },['prepareNextCliSession']);
 const pending=c.prepareNextCliSession('claude');await new Promise(r=>setImmediate(r));assert.equal(probeCalls,0);
 finishOld();const result=await pending;
 assert.equal(result.ready,true);assert.equal(result.version,'3.0.0');assert.equal(probeCalls,1);
 assert.equal(c._cliProbeCache.value[0].version,'3.0.0');assert.equal(c._cliProbeCache.value[1].version,'2.0.0');
 assert.equal(c._cliLatestCache.value.claude.status,'current');
 assert.equal(c.companionCapabilityCache,null);
 c.runSpawnedCliForText=async()=>({code:1,stdout:'3.0.0',stderr:'',timedOut:false,outputLimited:false});
 await assert.rejects(c.prepareNextCliSession('claude'),/version check/);
 c.runSpawnedCliForText=async()=>({code:0,stdout:'installed',stderr:'',timedOut:false,outputLimited:false});
 await assert.rejects(c.prepareNextCliSession('claude'),/version check/);
});

test('actual update click never claims a verified rollback as a successful update',async()=>{
 const start=source.indexOf('  async function onCliUpdateClick('),end=source.indexOf('  async function onCliRestartClick(',start);
 assert.ok(start>0&&end>start);let restarts=0,refreshes=0;const messages=[];
 const c=vm.createContext({setStatus:(_id,message,kind)=>messages.push({message,kind}),loadCliState:async()=>{refreshes++;},
  postJson:async()=>({ok:false,verified:true,rolledBack:true,version:'2.0.0',error:'Update failed; prior version restored.'}),
  onCliRestartClick:async()=>{restarts++;},watchCliAction:()=>assert.fail('no launched terminal'),
 });
 vm.runInContext(source.slice(start,end),c);
 await c.onCliUpdateClick('claude');
 assert.equal(restarts,0);assert.equal(refreshes,1);assert.equal(messages.at(-1).kind,'err');
 c.postJson=async()=>({ok:true,restart:{pending:true,operation:'update',state:'queued'},warnings:['cleanup warning']});
 await c.onCliUpdateClick('claude');assert.equal(restarts,1);assert.equal(refreshes,2);
});

test('actual update completion verifies attached success and terminal exit without a browser',async()=>{
 let result={ok:true,verified:true,warnings:['cleanup warning']},terminal={status:'completed',success:true,warnings:['terminal warning']};
 let preflight={kind:'proceed'},launches=0;
 const c=context({launchProviderUpdate:async()=>{launches++;return result;},preflightCliUpdate:async()=>preflight,readCliActionReceipt:()=>terminal,Date,
  join:(...parts)=>parts.join('/'),homedir:()=>'/synthetic',setTimeout,Error,
 },['completeCliUpdate']);
 // Preflight (d980815c): already current → no installer runs; locked → refused with the holders named.
 preflight={kind:'current',message:'codex is already up to date (0.152.0); nothing was installed.'};
 assert.deepEqual(Array.from((await c.completeCliUpdate('codex',()=>{})).warnings),['codex is already up to date (0.152.0); nothing was installed.']);
 preflight={kind:'locked',message:'codex cannot be updated while its executable is in use: 3 Claude Code sessions still have codex open (PIDs 1, 2, 3). Close them, then click Update again. Nothing was changed.'};
 await assert.rejects(c.completeCliUpdate('codex',()=>{}),/3 Claude Code sessions still have codex open/);
 assert.equal(launches,0,'neither verdict launched the vendor updater');
 preflight={kind:'proceed'};
 assert.deepEqual(Array.from((await c.completeCliUpdate('claude',()=>{})).warnings),['cleanup warning']);
 result={ok:false,verified:true,rolledBack:true,error:'prior version restored'};
 await assert.rejects(c.completeCliUpdate('claude',()=>{}),/prior version restored/);
 result={ok:true,launched:true,actionId:'synthetic-terminal'};
 assert.deepEqual(Array.from((await c.completeCliUpdate('codex',()=>{})).warnings),['terminal warning']);
 terminal={status:'completed',success:false,error:'vendor failed'};
 await assert.rejects(c.completeCliUpdate('codex',()=>{}),/vendor failed/);
 assert.match(source,/cliRestartCoordinator\.request\(provider, 'update'\)/);
});

test('actual timeout and output-cap probes await their owned cleanup',async()=>{
 for(const capped of [false,true]){
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  let timeout,finishCleanup,settled=false;
  const cleanup=new Promise(resolve=>{finishCleanup=resolve;});
  const c=context({Buffer,spawnCli:()=>child,setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{},
   terminateCliProcessTree:async()=>{await cleanup;child.emit('close',-1);return {ok:true};},
  },['runSpawnedCliForText']);
  const pending=c.runSpawnedCliForText('synthetic',['--version'],45000,3).then(value=>{settled=true;return value;});
  if(capped)child.stdout.emit('data',Buffer.from('too much'));else timeout();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  finishCleanup();const value=await pending;
  assert.equal(value.outputLimited,capped);assert.equal(value.timedOut,!capped);assert.equal(value.cleanupPending,undefined);
 }
});

test('actual updater process helper awaits timeout and either output-stream cap cleanup',async()=>{
 for(const mode of ['timeout','stdout','stderr']){
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
  let timeout,finishCleanup,settled=false;
  const cleanup=new Promise(resolve=>{finishCleanup=resolve;});
  const c=context({Buffer,spawn:()=>child,registerOwnedCliProcess:c=>c,basename:s=>s,setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{},
   terminateCliProcessTree:async()=>{await cleanup;child.emit('close',-1);return {ok:true};},
  },['runProcess']);
  const pending=c.runProcess('synthetic',['install'],{timeoutMs:20,maxBytes:3}).then(value=>{settled=true;return value;});
  if(mode==='timeout')timeout();else child[mode].emit('data','too much');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  finishCleanup();const result=await pending;assert.notEqual(result.code,0);assert.equal(result.cleanupPending,undefined);
 }
});
