import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {controlPanelHtml} from '../src/control-panel.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const html=controlPanelHtml('test-only'),elements=new Map(),requests=[];let poll;
  for(const [,id] of html.matchAll(/id="([^"]+)"/g))elements.set(id,{textContent:'',dataset:{},disabled:id==='bridge-control-pause',setAttribute(key,value){this[key]=value}});
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script,{
    document:{getElementById:id=>elements.get(id)},
    setInterval:fn=>{poll=fn},
    fetch:(path,options)=>new Promise(resolve=>requests.push({
      path,options,reply(data,ok=true){resolve({ok,json:async()=>data})},
    })),
  });
  return {html,requests,poll:()=>poll(),button:elements.get('bridge-control-pause'),panel:elements.get('bridge-control-panel'),status:elements.get('bridge-control-state')};
}
test('confirmed pause persists across polls and page reload; resume restores normal state',async()=>{
  const f=fixture();assert.equal(f.button.disabled,true);
  f.requests[0].reply({paused:true});await settle();
  assert.equal(f.panel.dataset.paused,'true');assert.equal(f.button.textContent,'Resume control');
  f.poll();f.requests[1].reply({paused:true,busy:false});await settle();assert.equal(f.panel.dataset.paused,'true');
  const click=f.button.onclick();assert.equal(f.button.disabled,true);assert.equal(f.button.textContent,'Resuming…');
  assert.equal(f.requests[2].path,'/api/control/resume');f.requests[2].reply({paused:false});await click;
  assert.equal(f.panel.dataset.paused,'false');assert.equal(f.button.textContent,'Pause control');assert.equal(f.button.disabled,false);
});
test('late status response cannot undo confirmed pause and repeated clicks send only one mutation',async()=>{
  const f=fixture();f.requests[0].reply({paused:false});await settle();
  f.poll();const click=f.button.onclick();await f.button.onclick();f.poll();
  assert.equal(f.requests.length,3);assert.equal(f.requests[2].path,'/api/control/pause');
  assert.notEqual(f.panel.dataset.paused,'true','A pending request must not claim confirmed pause');
  f.requests[2].reply({paused:true});await click;
  f.requests[1].reply({paused:false});await settle();
  assert.equal(f.panel.dataset.paused,'true');assert.equal(f.button.textContent,'Resume control');
  f.poll();f.requests[3].reply({paused:false});await settle();assert.equal(f.panel.dataset.paused,'false','A later external resume must still appear');
});
test('uncertain mutation disables stale action until a fresh status confirms the actual state',async()=>{
  const f=fixture();f.requests[0].reply({paused:true});await settle();
  const click=f.button.onclick();f.requests[1].reply({error:'Connection interrupted'},false);await click;
  assert.equal(f.button.disabled,true);assert.equal(f.panel.dataset.online,'false');assert.equal(f.panel.dataset.paused,'true');assert.match(f.status.textContent,/Cannot confirm/);
  await f.button.onclick();assert.equal(f.requests.length,2);
  f.poll();f.requests[2].reply({paused:false});await settle();
  assert.equal(f.button.disabled,false);assert.equal(f.panel.dataset.online,'true');assert.equal(f.panel.dataset.paused,'false');
});
