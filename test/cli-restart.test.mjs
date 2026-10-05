import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(file) {
  const built = await build({entryPoints:[new URL(file,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],bundle:true,platform:'node',format:'esm',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
const {ProviderConcurrencyGate}=await load('../src/provider-concurrency.ts');
const {CliRestartCoordinator}=await load('../src/cli-restart.ts');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('restart queues, preserves active work, blocks new work only on that provider, and restores admission',async()=>{
 const gate=new ProviderConcurrencyGate();
 const active=gate.tryAcquire('cli:claude','existing',10);
 let continueWait,prepared=0;
 const restart=new CliRestartCoordinator({supported:p=>p==='claude',pause:p=>gate.pause('cli:'+p),busy:p=>gate.snapshot('cli:'+p,10).active>0,wait:()=>new Promise(r=>{continueWait=r;}),prepare:async()=>{prepared++;return {version:'2.0.0',ready:true,message:'Next session prepared.'};}});
 const queued=restart.request('claude');assert.equal(queued.state,'queued');
 assert.equal(restart.request('claude').requestedAt,queued.requestedAt);
 assert.equal(gate.snapshot('cli:claude',10).active,1);assert.equal(prepared,0);
 assert.equal(gate.tryAcquire('cli:claude','new',10),null);
 assert.ok(gate.tryAcquire('cli:grok','other',10));
 active.release();continueWait();await tick();
 assert.equal(prepared,1);assert.equal(restart.status('claude').state,'restarted');
 assert.ok(gate.tryAcquire('cli:claude','after',10));
});

test('queue expiry does not terminate work or claim restart and releases its admission pause',async()=>{
 const gate=new ProviderConcurrencyGate();gate.tryAcquire('cli:grok','existing',10);let time=0;
 const restart=new CliRestartCoordinator({supported:()=>true,pause:p=>gate.pause('cli:'+p),busy:()=>true,now:()=>time,drainTimeoutMs:1000,wait:async()=>{time+=500;},prepare:async()=>{assert.fail('must not prepare while busy');}});
 restart.request('grok');await tick();
 assert.equal(restart.status('grok').state,'needs_user_action');
 assert.equal(gate.snapshot('cli:grok',10).active,1);
 assert.ok(gate.tryAcquire('cli:grok','new-after-expiry',10));
});

test('failed fresh probe and missing auth produce needs-user-action with admission restored',async()=>{
 for(const fails of [true,false]){
  const gate=new ProviderConcurrencyGate();
  const restart=new CliRestartCoordinator({supported:()=>true,pause:p=>gate.pause('cli:'+p),busy:()=>false,prepare:async()=>{if(fails)throw Error('Version probe failed.');return {version:'3.0.0',ready:false,message:'Sign in before using the next session.'};}});
  restart.request('codex');await tick();
  assert.equal(restart.status('codex').state,'needs_user_action');
  assert.ok(gate.tryAcquire('cli:codex','later',10));
 }
});

test('configured ten-channel Bridge pool remains independent of any app borrower limit',()=>{
 const gate=new ProviderConcurrencyGate();
 for(let n=0;n<10;n++)assert.ok(gate.tryAcquire('cli:claude','user-'+n,10));
 assert.equal(gate.tryAcquire('cli:claude','eleventh',10),null);
 assert.deepEqual(gate.snapshot('cli:claude',10),{isolated_sessions:true,max_active:10,active:10});
 assert.ok(gate.tryAcquire('cli:grok','separate-provider',10));
});

test('unsupported restart never pauses anything',()=>{
 const restart=new CliRestartCoordinator({supported:()=>false,pause:()=>{assert.fail('must not pause');},busy:()=>false,prepare:async()=>{assert.fail('must not prepare');}});
 assert.throws(()=>restart.request('arbitrary-command'),/Unsupported/);
});

test('a queued restart cannot release the updater admission pause when its own queue expires',()=>{
 const gate=new ProviderConcurrencyGate();
 const updateRelease=gate.pause('cli:claude');
 const restartRelease=gate.pause('cli:claude');
 restartRelease();restartRelease();
 assert.equal(gate.tryAcquire('cli:claude','new',10),null);
 updateRelease();assert.ok(gate.tryAcquire('cli:claude','new',10));
});

test('busy update drains then updates and automatically prepares under one admission pause with no browser',async()=>{
 const gate=new ProviderConcurrencyGate();const active=gate.tryAcquire('cli:claude','existing',10);
 const events=[];let drain,updated,prepared;
 const coordinator=new CliRestartCoordinator({supported:()=>true,pause:p=>gate.pause('cli:'+p),busy:()=>gate.snapshot('cli:claude',10).active>0,
  wait:()=>new Promise(resolve=>{drain=resolve;}),
  update:async()=>{events.push('update');await new Promise(resolve=>{updated=resolve;});return {warnings:['cleanup warning']};},
  prepare:async()=>{events.push('prepare');await new Promise(resolve=>{prepared=resolve;});return {version:'3.0.0',ready:true,message:'verified'};},
 });
 const receipt=coordinator.request('claude','update');assert.equal(receipt.state,'queued');assert.deepEqual(events,[]);
 assert.equal(coordinator.request('claude','update').requestedAt,receipt.requestedAt);
 assert.throws(()=>coordinator.request('claude'),/pending/);
 assert.equal(gate.tryAcquire('cli:claude','new',10),null);assert.ok(gate.tryAcquire('cli:grok','other',10));
 active.release();drain();await tick();assert.deepEqual(events,['update']);
 assert.equal(gate.tryAcquire('cli:claude','during-update',10),null);
 updated();await tick();assert.deepEqual(events,['update','prepare']);
 assert.equal(gate.tryAcquire('cli:claude','during-prepare',10),null);
 prepared();await tick();assert.equal(coordinator.status('claude').state,'restarted');
 assert.deepEqual(coordinator.status('claude').warnings,['cleanup warning']);assert.equal(coordinator.status('claude').pending,false);
 assert.ok(gate.tryAcquire('cli:claude','after',10));
});

test('failed update never prepares; uncertain probe cleanup retains the pause until the exact process exits',async()=>{
 const gate=new ProviderConcurrencyGate();let closed;
 const cleanupPending=new Promise(resolve=>{closed=resolve;});
 const coordinator=new CliRestartCoordinator({supported:()=>true,pause:p=>gate.pause('cli:'+p),busy:()=>false,
  update:async()=>{throw Error('Update failed; prior version restored.');},
  prepare:async()=>{throw Object.assign(Error('Probe cleanup needs attention'),{cleanupPending});},
 });
 coordinator.request('claude','update');await tick();assert.equal(coordinator.status('claude').state,'needs_user_action');
 coordinator.request('claude');await tick();assert.equal(coordinator.status('claude').pending,true);
 assert.equal(gate.tryAcquire('cli:claude','during-cleanup',10),null);
 closed();await tick();assert.equal(coordinator.status('claude').pending,false);
 assert.ok(gate.tryAcquire('cli:claude','after-cleanup',10));
});
