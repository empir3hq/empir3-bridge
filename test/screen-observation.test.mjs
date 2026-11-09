import test from 'node:test';
import assert from 'node:assert/strict';
import {isPassiveGuiObservation} from '../src/gui-observation.js';
import {captureOptions} from '../src/windows-screen-observation.js';
import {screenHarness} from './helpers/screen-observation-harness.mjs';

const image = Buffer.from('/9j/2Q==', 'base64');
function fixture() {
  const h = screenHarness();
  h.takePassiveDesktopScreenshot = async () => ({shot:{captures:[{path:'fixture.jpg',bounds:{x:0,y:0,width:3840,height:2160}}]},
    prepared:{buffer:image,mimeType:'image/jpeg',width:1280,height:720}});
  h.getDesktopMonitors = async () => ({monitors:[{primary:true}]});
  h.desktopCursorPosition = async () => ({x:120,y:200});
  return h;
}

test('only passive GUI observations bypass the lease, including explicit regions during focus', () => {
  const focus = {x:1,y:2,width:500,height:400};
  for (const action of ['position','monitors','screenshot']) assert.equal(isPassiveGuiObservation(action),true);
  for (const action of ['click','type','move','select_region','release_focus','unknown']) assert.equal(isPassiveGuiObservation(action),false);
  for (const params of [{marker:{x:1,y:2}},{grid:true},{grid:{}},{marker:[]}]) assert.equal(isPassiveGuiObservation('screenshot',params),false);
  assert.equal(isPassiveGuiObservation('screenshot',{},focus),false);
  assert.equal(isPassiveGuiObservation('screenshot',{grid:false},focus),false);
  assert.equal(isPassiveGuiObservation('screenshot',{monitor:'  '},focus),false);
  for (const params of [{monitor:'primary'},{region:focus},{noFocus:true}]) assert.equal(isPassiveGuiObservation('screenshot',params,focus),true);
});

test('relay and HTTP screenshots return an image while a long exclusive action runs; clicks stay refused', async () => {
  const h = fixture(); let finish;
  const running = h.controlRuntime.exclusive({owner:'long action'},()=>new Promise(r=>finish=r));
  try {
    for (const request of [()=>h.handleGuiCommand('screenshot',{monitor:'primary'}),()=>h.executeCommand({type:'desktop:gui:screenshot',params:{monitor:'primary'}})]) {
      const result = await request();
      assert.equal(result.success,true); assert.equal(result.thumbnail,image.toString('base64'));
      assert.equal(result.screenshot,result.thumbnail); assert.equal(result.base64,result.thumbnail);
      assert.equal(result.width,1280); assert.equal(result.height,720);
      assert.equal(h.controlRuntime.status().owner,'long action');
    }
    await h.handleGuiCommand('position'); await h.handleGuiCommand('monitors');
    await assert.rejects(h.handleGuiCommand('click',{x:1,y:1}),/control_busy/);
    await assert.rejects(h.executeCommand({type:'desktop:gui:click',params:{x:1,y:1}}),/control_busy/);
    for (const params of [{grid:true},{marker:{x:1,y:1}}]) await assert.rejects(h.handleGuiCommand('screenshot',params),/control_busy/);
    h.desktopFocus={x:0,y:0,width:400,height:400};
    await assert.rejects(h.handleGuiCommand('screenshot'),/control_busy/);
    assert.equal((await h.handleGuiCommand('screenshot',{monitor:'primary'})).success,true);
  } finally {finish();await running;}
});

test('paused control allows Read observations, still refuses actions and respects Read denial', async () => {
  const h = fixture(); h.controlRuntime.pause();
  assert.equal((await h.handleGuiCommand('screenshot',{monitor:'primary'})).success,true);
  await h.handleGuiCommand('position');await h.handleGuiCommand('monitors');
  for (const action of ['click','select_region','overlay','pointer_show']) await assert.rejects(h.handleGuiCommand(action),/control_paused/);
  h.hasBridgePermission = () => false;
  for (const action of ['screenshot','position','monitors']) assert.equal((await h.handleGuiCommand(action)).error,'read disabled');
});

test('passive observations reject mismatched targets before capture', async () => {
  const h=fixture();
  await assert.rejects(h.handleGuiCommand('screenshot',{target:{surface:'browser',tabId:'other'}}),/target_mismatch/);
});

test('a focus region created during target validation cannot turn a passive read into a focus action', async () => {
  const h=fixture();
  h.runScreenObservationPowerShellJson=async()=>{h.desktopFocus={x:1,y:2,width:300,height:200};};
  h.touchDesktopFocus=()=>assert.fail('passive observation must not touch focus');
  const result=await h.handleGuiCommand('screenshot',{target:{surface:'desktop',windowHandle:123}});
  assert.equal(result.success,true);
  assert.equal(result.width,1280);
});

test('capture options preserve physical bounds, reject invalid geometry and bound encoding', () => {
  const options=captureOptions({region:{x:-2560,y:569,width:1400,height:900},maxDimension:1280,quality:62});
  assert.deepEqual(options.region,{x:-2560,y:569,width:1400,height:900});
  assert.equal(options.maxDimension,1280);assert.equal(options.quality,62);
  for (const region of [{x:0,y:0,width:0,height:1},{x:'bad',y:0,width:10,height:10},{x:0,y:0,width:1e6,height:1e6}]) assert.throws(()=>captureOptions({region}),/region requires/);
  assert.equal(captureOptions({quality:Infinity}).quality,70);
  assert.equal(captureOptions({maxDimension:1280}).maxDimension,1280);
});
