import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserPrompts} from '../src/browser-prompts.ts';

function fixture() {
  const listeners=new Map(),sent=[];
  const prompts=createBrowserPrompts(async targetId=>({targetId,close(){},onEvent(fn){listeners.set(targetId,fn);return ()=>{};},async send(method,params){sent.push({targetId,method,params});return {};}}));
  const event=(method,params={},target='tab')=>listeners.get(target)({method,params});
  const show=()=>event('FedCm.dialogShown',{dialogId:'cdp-id',dialogType:'AccountChooser',title:'Sign in to example.test',accounts:[{name:'Test Person',email:'person@example.test',idpConfigUrl:'https://idp.example.test/config',loginState:'SignIn'}]});
  return {prompts,sent,event,show};
}
test('browser-owned prompt observation is target-bound and never selects an account',async()=>{
  const f=fixture();await f.prompts.ensure('tab');f.show();
  const status=await f.prompts.status('tab');
  assert.equal(status.prompts[0].accounts[0].email,'person@example.test');
  assert.equal(status.capabilities.fedcm,true);
  assert.deepEqual((await f.prompts.status('other')).prompts,[]);
  assert.ok(f.sent.every(c=>['Page.enable','FedCm.enable','DeviceAccess.enable'].includes(c.method)));
});
test('response needs exact local approval, is one-use, and cannot be redirected to another tab',async()=>{
  const f=fixture();await f.prompts.ensure('tab');f.show();const prompt=(await f.prompts.status('tab')).prompts[0];
  const request=await f.prompts.request('tab',{promptId:prompt.id,choice:'select_account',accountIndex:0,approved:true});
  await assert.rejects(f.prompts.respond('tab',request.requestId),/owner_approval_required/);
  await f.prompts.approve(request.requestId);
  await assert.rejects(f.prompts.respond('other',request.requestId),/owner_approval_required/);
  const result=await f.prompts.respond('tab',request.requestId);assert.equal(result.dispatched,true);
  assert.deepEqual(f.sent.at(-1),{targetId:'tab',method:'FedCm.selectAccount',params:{dialogId:'cdp-id',accountIndex:0}});
  await assert.rejects(f.prompts.respond('tab',request.requestId),/owner_approval_required/);
});
test('replacement dialogs and closed sessions invalidate approvals; credentials are not actions',async()=>{
  const f=fixture();await f.prompts.ensure('tab');f.show();let prompt=(await f.prompts.status('tab')).prompts[0];
  const request=await f.prompts.request('tab',{promptId:prompt.id,choice:'dismiss'});await f.prompts.approve(request.requestId);
  f.show();await assert.rejects(f.prompts.respond('tab',request.requestId),/stale_prompt/);
  prompt=(await f.prompts.status('tab')).prompts[0];
  await assert.rejects(f.prompts.request('tab',{promptId:prompt.id,choice:'type',text:'password'}),/not supported/);
  await assert.rejects(f.prompts.request('tab',{promptId:prompt.id,choice:'select_account',accountIndex:2}),/account index/);
  const next=await f.prompts.request('tab',{promptId:prompt.id,choice:'dismiss'});f.event('Bridge.sessionClosed');
  await assert.rejects(f.prompts.approve(next.requestId),/expired/);
});
test('device chooser exposes only observed actions; dismissal still needs approval',async()=>{
  const f=fixture();await f.prompts.ensure('tab');f.event('DeviceAccess.deviceRequestPrompted',{id:'device',devices:[{id:'a',name:'Test device'}]});
  const prompt=(await f.prompts.status('tab')).prompts[0];assert.equal(prompt.kind,'device');
  const req=await f.prompts.request('tab',{promptId:prompt.id,choice:'dismiss'});await f.prompts.approve(req.requestId);await f.prompts.respond('tab',req.requestId);
  assert.equal(f.sent.at(-1).method,'DeviceAccess.cancelPrompt');
});

test('expired approval cannot answer a still-open prompt',async()=>{
  const f=fixture();await f.prompts.ensure('tab');f.show();
  const prompt=(await f.prompts.status('tab')).prompts[0];
  const req=await f.prompts.request('tab',{promptId:prompt.id,choice:'dismiss'});await f.prompts.approve(req.requestId);
  const now=Date.now;try{Date.now=()=>now()+120001;await assert.rejects(f.prompts.respond('tab',req.requestId),/owner_approval_required/);}finally{Date.now=now;}
  assert.ok(!f.sent.some(c=>c.method==='FedCm.dismissDialog'));
});

test('unsupported domains report coverage and failed initialization closes its session',async()=>{
  let closed=0;
  const prompts=createBrowserPrompts(async targetId=>({targetId,close(){closed++;},onEvent(){return ()=>{};},async send(method){if(targetId==='dead'||method!=='Page.enable')throw new Error('unsupported');}}));
  assert.deepEqual((await prompts.status('live')).capabilities,{fedcm:false,deviceAccess:false});
  await assert.rejects(prompts.ensure('dead'));assert.equal(closed,1);
});
