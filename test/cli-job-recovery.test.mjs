import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import journalModule from '../src/cli-turn-journal.ts';
import jobModule from '../src/cli-job-supervisor.ts';
const { CliTurnJournal, cliTurnHash } = journalModule;
const { recoverWindowsCliAttempts, openCliJobControl, createWindowsCliSupervisor } = jobModule;
const binding=cliTurnHash('original-enrollment'),payload={id:'recovery-turn',prompt:'PRIVATE-NOT-JOURNALED'},hash=cliTurnHash(payload);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'empir3-job-recovery-')),file=join(dir,'turns.sqlite'),stores=[];
  const open=()=>{const s=new CliTurnJournal(file);stores.push(s);return s;};
  const raw=()=>{const db=new DatabaseSync(file);stores.push(db);return db;};
  t.after(()=>{for(const s of stores)try{s.close();}catch{}
    const remove=p=>{for(const n of readdirSync(p)){const child=join(p,n),info=lstatSync(child);if(info.isDirectory()&&!info.isSymbolicLink())remove(child);else unlinkSync(child);}rmdirSync(p);};
    assert.equal(resolve(dir,'..'),resolve(tmpdir()));remove(dir);});
  return {dir,file,open,raw};
}
const admit=s=>s.prepare(binding,'codex',payload.id,payload,'windows-job-v1');
const evidence=s=>s.reconcile(binding,'codex',payload.id,hash);
const proof=nonce=>({version:1,nonce,mechanism:'windows-job-v1',started:true,pid:123,exitCode:0,cancelled:false,timedOut:false,activeProcesses:0});

test('all original attempts must be sealed and individually proven before stopped evidence survives reopen',t=>{
  const f=fixture(t),s=f.open(),receipt=admit(s);s.issue(receipt);
  const first=s.registerAttempt(receipt),second=s.registerAttempt(receipt);s.issueAttempt(receipt,first);s.issueAttempt(receipt,second);
  assert.throws(()=>s.recordNativeStop(receipt,first,proof(first)),/not bound/);
  s.finish(receipt,'done');s.recordNativeStop(receipt,first,proof(first));assert.equal(evidence(s).phase,'uncertain');
  assert.throws(()=>s.recordNativeStop(receipt,second,proof(first)),/Invalid/);
  s.close();const reopened=f.open();assert.equal(evidence(reopened).phase,'uncertain');
  reopened.recordNativeStop(receipt,second,proof(second));assert.equal(evidence(reopened).phase,'stopped');
  assert.throws(()=>reopened.issueAttempt(receipt,second),/cannot start/);assert.throws(()=>reopened.registerAttempt(receipt),/closed/);
  assert.throws(()=>reopened.recordNativeStop(receipt,second,{...proof(second),exitCode:1}),/changed/);
  reopened.close();assert.equal(evidence(f.open()).phase,'stopped');
});

test('stop races atomically against prepared attempts, including the gap before the first attempt',t=>{
  const f=fixture(t),first=f.open(),second=f.open(),receipt=admit(first);first.issue(receipt);
  const nonce=first.registerAttempt(receipt);
  second.recovery(binding,'codex',payload.id,hash,true);
  assert.throws(()=>first.issueAttempt(receipt,nonce),/cannot start/);
  assert.equal(evidence(second).phase,'stopped');
  const another=first.prepare(binding,'codex','gap',{},'windows-job-v1');first.issue(another);
  second.recovery(binding,'codex','gap',cliTurnHash({}),true);
  assert.equal(second.reconcile(binding,'codex','gap',cliTurnHash({})).phase,'stopped');
  assert.throws(()=>first.registerAttempt(another),/closed/);
});

test('attempt deletion, count rollback, changed proof and removed guards cannot manufacture completion',t=>{
  const f=fixture(t),s=f.open(),receipt=admit(s);s.issue(receipt);const nonce=s.registerAttempt(receipt);s.issueAttempt(receipt,nonce);
  const db=f.raw();
  assert.throws(()=>db.exec('DELETE FROM cli_turn_attempts'),/retained/);
  assert.throws(()=>db.exec('UPDATE cli_turn_containment SET attempt_count=0'),/binding/);
  db.exec("CREATE TRIGGER fail_proof BEFORE UPDATE ON cli_turn_attempts WHEN NEW.phase='stopped' BEGIN SELECT RAISE(ABORT,'proof write fault'); END;");
  s.finish(receipt,'done');assert.throws(()=>s.recordNativeStop(receipt,nonce,proof(nonce)),/proof write fault/);assert.equal(evidence(s).phase,'uncertain');
  db.exec('DROP TRIGGER fail_proof; DROP TRIGGER cli_attempt_retained');assert.throws(()=>evidence(s),/guards/);
});

test('attempt admission storage failure rolls back the inventory and cannot reach issue',t=>{
  const f=fixture(t),s=f.open(),receipt=admit(s);s.issue(receipt);const db=f.raw();
  db.exec("CREATE TRIGGER fail_count BEFORE UPDATE ON cli_turn_containment BEGIN SELECT RAISE(ABORT,'count fault'); END;");
  assert.throws(()=>s.registerAttempt(receipt),/count fault/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM cli_turn_attempts').get().n,0);
  assert.equal(db.prepare('SELECT attempt_count FROM cli_turn_containment').get().attempt_count,0);
});

test('whole journal loss and identity-marker loss cannot silently reset admitted history',t=>{
  const f=fixture(t),s=f.open();admit(s);s.close();
  const marker=readFileSync(f.file+'.identity');unlinkSync(f.file+'.identity');assert.throws(()=>f.open(),/marker is missing/);
  writeFileSync(f.file+'.identity',marker);unlinkSync(f.file);assert.throws(()=>f.open(),/history is missing/);
  assert.equal(existsSync(f.file),false);
});

test('exact version-one journal upgrades retain old uncertainty and never invent an attempt inventory',t=>{
  const f=fixture(t),s=f.open(),receipt=s.prepare(binding,'codex',payload.id,payload);s.issue(receipt);s.finish(receipt,'done');s.close();
  const db=new DatabaseSync(f.file);
  for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all())db.exec('DROP TRIGGER '+row.name);
  db.exec('DROP TABLE cli_turn_attempts; DROP TABLE cli_turn_containment; PRAGMA user_version=1');db.close();unlinkSync(f.file+'.identity');
  const reopened=f.open();assert.equal(evidence(reopened).phase,'uncertain');assert.equal(reopened.generation,receipt.generation);
  assert.equal(reopened.recovery(binding,'codex',payload.id,hash,true).contained,false);
  assert.equal(evidence(reopened).phase,'uncertain');assert.throws(()=>reopened.registerAttempt(receipt),/closed/);
});

test('real creator-process crash recovers and stops every recorded native attempt without replay', {skip:process.platform!=='win32',timeout:30_000}, async t=>{
  const f=fixture(t),root=join(f.dir,'jobs'),pids=join(f.dir,'pids.json');
  const worker=join(f.dir,'worker.cjs');writeFileSync(worker,`const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const script=`const {CliTurnJournal,cliTurnHash}=require(${JSON.stringify(resolve('src/cli-turn-journal.ts'))});const {CliTurnLifecycle}=require(${JSON.stringify(resolve('src/cli-turn-lifecycle.ts'))});const {createWindowsCliSupervisor}=require(${JSON.stringify(resolve('src/cli-job-supervisor.ts'))});const {spawn}=require('child_process'),fs=require('fs');
    const store=new CliTurnJournal(process.argv[1]),life=new CliTurnLifecycle(()=>({store,binding:process.argv[2]}),createWindowsCliSupervisor({helperPath:process.argv[3],root:process.argv[4]}));
    const scope=life.begin('codex',${JSON.stringify(payload.id)},${JSON.stringify(payload)});scope.run(()=>life.spawn(process.execPath,[process.argv[5]],{cwd:process.argv[6],stdio:'ignore',windowsHide:true,env:process.env},spawn));
    setInterval(()=>{if(fs.existsSync(process.argv[7]))process.exit(9)},10);`;
  const launched=spawnSync(process.execPath,['--import','tsx','-e',script,f.file,binding,resolve('native/cli-job/bin',`win32-${process.arch}`,'empir3-cli-job.exe'),root,worker,f.dir,pids],{encoding:'utf8',timeout:10000,windowsHide:true});
  const recovered=f.open();
  // Register before assertions so even a failed fixture is stopped only by its
  // exact persisted identity, never a PID/name scan.
  const saved=recovered.recovery(binding,'codex',payload.id,hash,true);
  const controls=saved.attempts.filter(a=>a.phase==='issued').map(a=>openCliJobControl(root,saved.receipt,a.nonce));
  try {
    assert.equal(launched.status,9,launched.stderr);assert.equal(controls.length,1);
    assert.equal(evidence(recovered).phase,'uncertain','crash itself supplies no native stop proof');
    recoverWindowsCliAttempts(recovered,root,binding,'codex',payload.id,hash,true);
    await Promise.all(controls.map(c=>c.waitForStop()));
    recoverWindowsCliAttempts(recovered,root,binding,'codex',payload.id,hash,true);
    assert.equal(evidence(recovered).phase,'stopped');
    for(const pid of JSON.parse(readFileSync(pids)))assert.throws(()=>process.kill(pid,0));
    assert.throws(()=>admit(recovered),/already admitted/);
    recovered.close();assert.equal(evidence(f.open()).phase,'stopped');
  } finally {for(const c of controls)c.cancel();await Promise.all(controls.map(c=>c.waitForStop()));}
});

test('real creator crash between issue and helper spawn recovers without ever launching the provider', {skip:process.platform!=='win32',timeout:30_000}, async t=>{
  const f=fixture(t),root=join(f.dir,'jobs'),marker=join(f.dir,'must-not-execute');
  const helper=resolve('native/cli-job/bin',`win32-${process.arch}`,'empir3-cli-job.exe');
  const script=`const {CliTurnJournal}=require(${JSON.stringify(resolve('src/cli-turn-journal.ts'))});const {CliTurnLifecycle}=require(${JSON.stringify(resolve('src/cli-turn-lifecycle.ts'))});const {createWindowsCliSupervisor}=require(${JSON.stringify(resolve('src/cli-job-supervisor.ts'))});
    const store=new CliTurnJournal(process.argv[1]),life=new CliTurnLifecycle(()=>({store,binding:process.argv[2]}),createWindowsCliSupervisor({helperPath:process.argv[3],root:process.argv[4]}));
    const scope=life.begin('codex',${JSON.stringify(payload.id)},${JSON.stringify(payload)});scope.run(()=>life.spawn(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'executed')`)}],{cwd:process.argv[5],env:process.env},()=>process.exit(9)));`;
  const launched=spawnSync(process.execPath,['--import','tsx','-e',script,f.file,binding,helper,root,f.dir],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(launched.status,9,launched.stderr);
  const recovered=f.open(),saved=recovered.recovery(binding,'codex',payload.id,hash,true);
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].phase,'issued');assert.equal(evidence(recovered).phase,'uncertain');
  const control=openCliJobControl(root,saved.receipt,saved.attempts[0].nonce);
  recoverWindowsCliAttempts(recovered,root,binding,'codex',payload.id,hash,true,helper);
  await control.waitForStop();
  recoverWindowsCliAttempts(recovered,root,binding,'codex',payload.id,hash,true,helper);
  assert.equal(evidence(recovered).phase,'stopped');assert.equal(control.readStop().started,false);assert.equal(control.readStop().pid,0);
  const config=join(root,`${saved.receipt.generation}-${saved.receipt.nonce}`,`cli-job-${saved.attempts[0].nonce}.json`);
  const late=spawnSync(helper,[config],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(late.status,125);
  assert.equal(existsSync(marker),false);assert.equal(existsSync(config),false);
  recovered.close();assert.equal(evidence(f.open()).phase,'stopped');
});

test('cancel-only recovery refuses absent and wrong markers, and never turns missing config into proof', {skip:process.platform!=='win32'}, t=>{
  const f=fixture(t),s=f.open(),receipt=admit(s);s.issue(receipt);const nonce=s.registerAttempt(receipt);
  const helper=resolve('native/cli-job/bin',`win32-${process.arch}`,'empir3-cli-job.exe'),root=join(f.dir,'jobs');
  createWindowsCliSupervisor({helperPath:helper,root})(process.execPath,['-e','process.exit(99)'],{cwd:f.dir},receipt,nonce);s.issueAttempt(receipt,nonce);
  const config=join(root,`${receipt.generation}-${receipt.nonce}`,`cli-job-${nonce}.json`);
  assert.equal(spawnSync(helper,['--recover-cancelled',config],{windowsHide:true}).status,125);assert.equal(existsSync(config),true);
  writeFileSync(config+'.cancel','0'.repeat(64));
  assert.equal(spawnSync(helper,['--recover-cancelled',config],{windowsHide:true}).status,125);assert.equal(existsSync(config),true);
  unlinkSync(config+'.cancel');unlinkSync(config);
  recoverWindowsCliAttempts(s,root,binding,'codex',payload.id,hash,true,helper);
  assert.equal(evidence(s).phase,'uncertain');assert.equal(existsSync(config+'.result'),false);
});
