import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {stopInstalledProcesses}=require('../build/uninstall-processes.js');
const script=path.resolve('build/bootstrap-go/uninstall-processes.ps1');

test('uninstall test mode preserves owned processes; real cleanup stops only its installation', {skip:process.platform!=='win32',timeout:45000}, async()=>{
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-uninstall-isolation-'));
  const root=path.join(scratch,'.empir3-bridge'),app=path.join(scratch,'roaming','Empir3');
  const neighbor=path.join(scratch,'.empir3-bridge-neighbor');
  for(const dir of [root,app,neighbor])fs.mkdirSync(dir,{recursive:true});
  const children=[];
  const fixtureScript=path.join(scratch,'fixture.cjs');
  fs.writeFileSync(fixtureScript,"process.stdout.write('ready\\n');setInterval(()=>{},1000)");
  async function fixture(dir,name='node.exe',args=[]){
    const exe=path.join(dir,name);fs.copyFileSync(process.execPath,exe);
    const child=spawn(exe,[fixtureScript,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    children.push(child);await once(child.stdout,'data');return child;
  }
  function cleanup(env={}){
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{
      windowsHide:true,encoding:'utf8',timeout:20000,env:{...process.env,EMPIR3_UNINSTALL_BRIDGE_ROOT:root,EMPIR3_UNINSTALL_APP_ROOT:app,EMPIR3_UNINSTALL_CALLER_PID:String(process.pid),EMPIR3_UNINSTALL_TEST:'',EMPIR3_UNINSTALL_DRY_RUN:'',...env},
    });
    assert.equal(r.status,0,r.stderr||r.error?.message);return JSON.parse(r.stdout);
  }
  try{
    const owned=await fixture(root),other=await fixture(neighbor);
    const ownedTray=await fixture(app,'Empir3Tray.exe');
    const otherTray=await fixture(neighbor,'Empir3Tray.exe');
    const ownedChrome=await fixture(scratch,'chrome.exe',[`--user-data-dir=${path.join(app,'Chrome profile')}`]);
    const otherChrome=await fixture(neighbor,'chrome.exe',[`--user-data-dir=${path.join(neighbor,'Chrome profile')}`]);
    const installed=[owned,ownedTray,ownedChrome],neighbours=[other,otherTray,otherChrome];
    const dry=cleanup({EMPIR3_UNINSTALL_DRY_RUN:'1'});
    for(const child of installed)assert.ok(dry.candidates.some(p=>p.ProcessId===child.pid));
    for(const child of neighbours)assert.ok(!dry.candidates.some(p=>p.ProcessId===child.pid));
    const selfExcluded=cleanup({EMPIR3_UNINSTALL_DRY_RUN:'1',EMPIR3_UNINSTALL_CALLER_PID:String(owned.pid)});
    assert.ok(!selfExcluded.candidates.some(p=>p.ProcessId===owned.pid),'uninstaller never terminates itself');
    const isolated=cleanup({EMPIR3_UNINSTALL_TEST:'1'});
    assert.equal(isolated.testMode,true);assert.deepEqual(isolated.killed,[]);
    for(const child of [...installed,...neighbours])assert.doesNotThrow(()=>process.kill(child.pid,0));
    // Exercise the same JavaScript adapter shipped beside the payload entry.
    const count=stopInstalledProcesses(root,app);assert.equal(count,installed.length);
    for(const child of installed)assert.throws(()=>process.kill(child.pid,0));
    for(const child of neighbours)assert.doesNotThrow(()=>process.kill(child.pid,0));
    assert.equal(stopInstalledProcesses(root,app),0,'a settled repeat is harmless');
  }finally{
    for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
    const resolved=path.resolve(scratch);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('bridge-uninstall-isolation-'));
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('uninstall refuses an uncertain installation root before process cleanup', {skip:process.platform!=='win32'},()=>{
  assert.throws(()=>stopInstalledProcesses(os.tmpdir(),path.join(os.tmpdir(),'Empir3')),/Unexpected installation root/);
});
