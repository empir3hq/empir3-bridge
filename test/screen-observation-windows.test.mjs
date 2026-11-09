import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {screenHarness} from './helpers/screen-observation-harness.mjs';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {SCREEN_CAPTURE_TYPES_PS} from '../src/windows-screen-observation.js';

// Opt in because this captures the operator's real display. Images live only
// in this temporary directory and are deleted even on a failed assertion.
test('Windows live GUI capture: real JPEG during native control, pause, bounds and timings', {
  skip: process.platform !== 'win32' || process.env.EMPIR3_TEST_SCREEN_OBSERVATION !== '1', timeout:60000,
}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'empir3-screen-observation-'));
  const h=screenHarness({FEEDBACK_DIR:dir});
  const reader=createWindowsControlWorker({initializeScript:h.desktopPreamble()+'\n'+SCREEN_CAPTURE_TYPES_PS});
  const input=createWindowsControlWorker();
  h.windowsObservationWorker=reader;
  const results=[];
  try {
    const start=performance.now();
    const monitors=await h.handleGuiCommand('monitors');
    const startupMs=Math.round(performance.now()-start);
    const primary=monitors.monitors.find(m=>m.primary);
    const region={x:primary.bounds.x,y:primary.bounds.y,width:1400,height:900};
    for(const params of [{monitor:'primary',maxDimension:1280,quality:62},{region}]) {
      for(let i=0;i<6;i++) {
        const began=performance.now();
        const r=await h.executeCommand({type:'desktop:gui:screenshot',params});
        const ms=Math.round(performance.now()-began);
        assert.equal(r.success,true);assert.equal(r.mimeType,'image/jpeg');
        const bytes=Buffer.from(r.thumbnail,'base64');
        assert.equal(bytes.readUInt16BE(0),0xffd8);
        const dimensions=h.getImageDimensions(bytes);
        assert.equal(dimensions.width,r.width);assert.equal(dimensions.height,r.height);
        assert.equal(r.base64,r.thumbnail);assert.equal(r.screenshot,r.thumbnail);
        assert.equal(r.data.width,r.width);assert.equal(r.data.height,r.height);
        if(params.region) {
          assert.equal(r.width,1400);assert.equal(r.height,900);
          assert.deepEqual(JSON.parse(JSON.stringify(r.region)),region);
        } else {
          assert.equal(r.width,1280);assert.equal(r.height,Math.round(primary.bounds.height*1280/primary.bounds.width));
          assert.deepEqual(r.captures[0].bounds,primary.bounds);
        }
        results.push({params,iteration:i,ms,width:r.width,height:r.height,bounds:r.captures[0].bounds,bytes:bytes.length});
      }
    }
    await input.run('[pscustomobject]@{ready=$true} | ConvertTo-Json -Compress');
    let controlFinished=false;
    const running=h.controlRuntime.exclusive({owner:'long-native-test'},()=>input.run('Start-Sleep -Milliseconds 3000; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress'));
    const tracked=running.finally(()=>{controlFinished=true;});
    try {
      const image=await h.handleGuiCommand('screenshot',{region});
      assert.equal(image.success,true);assert.equal(controlFinished,false,'image must arrive before native action finishes');
      await h.handleGuiCommand('position');await h.handleGuiCommand('monitors');
      await assert.rejects(h.handleGuiCommand('click',{x:0,y:0}),/control_busy/);
      await assert.rejects(h.executeCommand({type:'desktop:gui:click',params:{x:0,y:0}}),/control_busy/);
    } finally {await tracked;}
    h.controlRuntime.pause();
    assert.equal((await h.handleGuiCommand('screenshot',{region})).success,true);
    await assert.rejects(h.handleGuiCommand('click',{x:0,y:0}),/control_paused/);
    // Restart after a dead worker must recover safely without going through
    // the input worker or waking the desktop.
    reader.stop();
    assert.equal((await h.handleGuiCommand('screenshot',{region})).success,true);
    const receipt={at:new Date().toISOString(),startupMs,monitors:monitors.monitors,results,concurrentScreenshot:true,concurrentClickRefused:true,pausedRead:true,pausedClickRefused:true,workerRestart:true};
    mkdirSync('build',{recursive:true});writeFileSync('build/screen-observation-live.json',JSON.stringify(receipt,null,2));
    console.log(JSON.stringify(receipt));
  } finally {reader.stop();input.stop();rmSync(dir,{recursive:true,force:true});}
});
