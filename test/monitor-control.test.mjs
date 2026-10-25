import {createRequire} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {validateMonitorInput,monitorPoint,createMonitorControl,browserMonitorInput}=require('../src/monitor-control.js');
const {getControlLimits}=require('../src/control-limits.js');

test('monitor coordinates include negative desktop origins and exclude outside input',()=>{
  assert.deepEqual(monitorPoint({x:0.5,y:1},{x:-1920,y:-50,width:1920,height:1080}),{x:-960,y:1029});
  for(const x of [-1,1.01,NaN,Infinity,'0.5',null])assert.throws(()=>validateMonitorInput({kind:'click',x,y:0.5}));
  assert.throws(()=>validateMonitorInput({kind:'drag',x:0,y:0,toX:0.5,toY:Infinity}));
  assert.throws(()=>validateMonitorInput({kind:'key',key:'A',modifiers:['malicious']}));
});
test('frames bind session and surface while queued input survives refreshes',async()=>{
  const calls=[];
  const monitor=createMonitorControl({capture:async()=>({base64:'image',bounds:{x:0,y:0,width:100,height:100}}),input:async(...args)=>calls.push(args)});
  const sessionId='viewer-123456789012345';
  const first=await monitor('browser','monitor_frame',{sessionId});
  await assert.rejects(monitor('desktop','monitor_input',{sessionId,frameId:first.frameId,input:{kind:'click',x:0.5,y:0.5}}));
  await assert.rejects(monitor('browser','monitor_input',{sessionId:'another-123456789012345',frameId:first.frameId,input:{kind:'click',x:0.5,y:0.5}}));
  const second=await monitor('browser','monitor_frame',{sessionId});
  await monitor('browser','monitor_frame',{sessionId});
  await monitor('browser','monitor_input',{sessionId,frameId:first.frameId,input:{kind:'click',x:0.5,y:0.5}});
  const result=await monitor('browser','monitor_input',{sessionId,frameId:second.frameId,input:{kind:'type',text:'private-value'}});
  assert.equal(calls.length,2);assert.ok(!JSON.stringify(result).includes('private-value'));
});
test('browser input emits real coordinates, shortcuts, private text and releases failed drags',async()=>{
  const events=[];const bounds={x:0,y:0,width:1000,height:500};
  const session={send:async(method,params)=>{events.push({method,...params});}};
  await browserMonitorInput(session,{kind:'click',x:0.25,y:0.5,button:'right'},bounds);
  assert.deepEqual(events.filter(e=>e.type==='mousePressed')[0],{method:'Input.dispatchMouseEvent',type:'mousePressed',x:250,y:250,button:'right',buttons:2,clickCount:1});
  await browserMonitorInput(session,{kind:'key',key:'a',modifiers:['Control']},bounds);
  assert.equal(events.find(e=>e.type==='rawKeyDown').modifiers,2);
  await browserMonitorInput(session,{kind:'type',text:'café ✓'},bounds);
  assert.deepEqual(events.at(-1),{method:'Input.insertText',text:'café ✓'});
  let held=false,released=false;
  const failed={send:async(_method,p)=>{if(p.type==='mousePressed')held=true;if(p.type==='mouseMoved'&&held)throw new Error('disconnect');if(p.type==='mouseReleased')released=true;}};
  await assert.rejects(browserMonitorInput(failed,{kind:'drag',x:0,y:0,toX:1,toY:1},bounds));assert.equal(released,true);
});
test('standalone pointer movement cannot press a button and remains bounded',async()=>{
  const events=[];
  await browserMonitorInput({send:async(method,p)=>events.push({method,...p})},{kind:'move',x:1,y:0,button:'left'},{x:0,y:0,width:100,height:60});
  assert.deepEqual(events,[{method:'Input.dispatchMouseEvent',type:'mouseMoved',x:99,y:0,button:'none',buttons:0}]);
  for(const x of [-1,NaN,Infinity,1.1])assert.throws(()=>validateMonitorInput({kind:'move',x,y:0}));
});

test('expired frame never dispatches input',async()=>{
  let now=1000,calls=0;
  const monitor=createMonitorControl({now:()=>now,capture:async()=>({base64:'image',bounds:{x:0,y:0,width:100,height:100}}),input:async()=>calls++});
  const sessionId='viewer-123456789012345',frame=await monitor('browser','monitor_frame',{sessionId});
  now+=getControlLimits().snapshotLifetimeMs+1;
  await assert.rejects(monitor('browser','monitor_input',{sessionId,frameId:frame.frameId,input:{kind:'click',x:0.5,y:0.5}}),/expired/);
  assert.equal(calls,0);
});
