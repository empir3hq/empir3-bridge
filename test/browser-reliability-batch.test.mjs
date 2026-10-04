import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import act from '../src/browser-act.ts';
import point from '../src/browser-action-point.ts';
import page from '../src/browser-page.ts';
import refusal from '../src/browser-refusal.ts';
const config={url:'http://localhost:12345',model:'fixture',minConfidence:.6,timeoutMs:8000,source:'env'};
const node=(ref,name,extra={})=>({ref,role:'button',name,...extra});
const answer=(choice,confidence=.9)=>({choice,confidence,probabilities:{[choice]:confidence,none:1-confidence}});
function harness(nodes, replies, extra={}) {
 const sent=[],requests=[];
 const deps={command:async cmd=>{sent.push(cmd);if(extra.command){const r=await extra.command(cmd);if(r!==undefined)return r;}
  if(cmd.type==='act_preflight')return {success:true,targetId:'tab-1'};
  if(cmd.type==='snapshot')return {snapshot:{nodes,...extra.snapshot}};
  if(cmd.type==='status')return {currentTargetId:'tab-1',title:'Fixture'};
  return {success:true,verified:true};},decide:async body=>{requests.push(body);const r=replies[requests.length-1];return typeof r==='function'?r(body):r;}};
 return {sent,requests,run:params=>act.runBrowserAct(params,config,deps)};
}
test('A: accept only a visible editable in-place replacement, including after selection',()=>{
 const old={isConnected:false,getBoundingClientRect:()=>({left:10,top:10,width:100,height:30,right:110,bottom:40})};
 const active={isConnected:true,tagName:'INPUT',type:'text',disabled:false,readOnly:false,getBoundingClientRect:old.getBoundingClientRect,getClientRects:()=>[1],getAttribute:()=>null};
 const store={token:{el:old,box:{left:10,top:10,width:100,height:30,right:110,bottom:40}}};
 const context={window:{__empir3ActionReceipts:store},document:{activeElement:active},innerWidth:800,innerHeight:600,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};
 assert.equal(vm.runInNewContext(point.retargetEditableExpression('token'),context),'true');assert.equal(store.token.el,active);
 store.token.el=old;active.getBoundingClientRect=()=>({left:250,top:10,width:100,height:30,right:350,bottom:40});
 assert.equal(vm.runInNewContext(point.retargetEditableExpression('token'),context),'false');assert.equal(store.token.el,old);
});
test('B: known input refusals are structured; real faults remain faults; act maps refusal',async()=>{
 const r=refusal.browserRefusal(Object.assign(new Error('focus refused'),{actionFailure:true,code:'focus_not_confirmed',inputMayHaveOccurred:true}));
 assert.deepEqual(r,{success:false,verified:false,code:'focus_not_confirmed',error:'focus refused',inputMayHaveOccurred:true});
 assert.equal(refusal.browserRefusal(new Error('socket crashed')),null);
 const h=harness([node('r','Continue')],[{answers:{target:answer('r')}}],{command:cmd=>cmd.type==='click_ref'?r:undefined});
 const result=await h.run({goal:'continue'});assert.equal(result.acted,false);assert.equal(result.reason,'focus_not_confirmed');
});
test('C: loading waits are bounded and return page_loading without snapshotting a null body',async()=>{
 let clock=0,calls=0;
 const result=await page.waitForBrowserPage(async()=>{calls++;return {body:false,readyState:'loading',visible:true};},{now:()=>clock,sleep:async ms=>{clock+=ms},timeoutMs:5000});
 assert.equal(result.success,false);assert.equal(result.code,'page_loading');assert.ok(clock<=5000);assert.ok(calls>1);
});
test('D: select asks options, uses verified select step and refuses unverified completion',async()=>{
 const n=node('s','Dropdown',{role:'combobox',tag:'select',options:[{value:'',label:'Please select',disabled:true},{value:'2',label:'Option 2'}]});
 const replies=[{answers:{target:answer('s')}},body=>({answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>[key,answer(Object.keys(q.criteria).find(k=>k!=='none'))]))})];
 const h=harness([n],replies);const result=await h.run({goal:'choose Option 2'});
 assert.equal(result.operation,'select');assert.equal(result.acted,true);assert.equal(h.requests.length,2);
 const selection=h.sent.find(c=>c.type==='control_run');assert.equal(selection.steps[0].action,'select');assert.equal(selection.steps[0].value,'2');
 const failed=harness([n],replies,{command:cmd=>cmd.type==='control_run'?{success:true,verified:false}:undefined});
 assert.equal((await failed.run({goal:'choose Option 2'})).acted,false);
});
test('E: unnamed controls use adjacent description rather than disappearing',()=>{
 const nodes=act.snapshotNodes({nodes:[node('c','',{role:'checkbox',description:'Checkbox 1'})]});
 assert.equal(act.actionableNodes(nodes).length,1);assert.match(act.describeNode(nodes[0]),/Checkbox 1/);
});
test('F: distinct same-label refs survive and descriptions identify item and order',()=>{
 const nodes=act.snapshotNodes({nodes:[node('a','comments',{role:'link',context:'First story',order:1,total:3}),node('b','comments',{role:'link',context:'Second story',order:2,total:3}),node('c','comments',{role:'link',context:'Third story',order:3,total:3})]});
 assert.equal(act.actionableNodes(nodes).length,3);assert.match(act.describeNode(nodes[2]),/Third story/);assert.match(act.describeNode(nodes[2]),/3rd of 3/);
});
test('F: story position stays distinct from comments-link order when a story has no comments',()=>{
 const n=act.snapshotNodes({nodes:[node('third','43 comments',{role:'link',context:'Third story headline',itemOrder:3,itemTotal:30,order:2,total:29})]})[0];
 assert.match(act.describeNode(n),/item 3 of 30/);assert.match(act.describeNode(n),/2nd of 29/);
});
test('G: state is described, disabled skipped, already checked goal does not untick',async()=>{
 const n=node('c','Checkbox 2',{role:'checkbox',checked:true,expanded:false});
 assert.equal(act.actionableNodes([node('d','Disabled',{disabled:true}),n]).length,1);assert.match(act.describeNode(n),/checked=true/);
 const h=harness([n],[{answers:{target:answer('c')}}]);const r=await h.run({goal:'tick checkbox 2'});
 assert.equal(r.reason,'already_done');assert.equal(r.acted,false);assert.ok(!h.sent.some(c=>c.type==='click_ref'));
});
test('H: all groups share one request; final winner beats higher group confidence',async()=>{
 const nodes=Array.from({length:49},(_,i)=>node('r'+i,'Control '+i));
 const h=harness(nodes,[body=>({answers:Object.fromEntries(Object.keys(body.questions).map((key,i)=>[key,answer('r'+(i*24),i===0?.99:.7)]))}),{answers:{target:answer('r24',.85)}}]);
 const r=await h.run({goal:'control 24'});assert.equal(r.pick.ref,'r24');assert.equal(r.decisionCalls,2);assert.equal(h.requests.length,2);
 assert.equal(Object.keys(h.requests[0].questions).length,3);assert.equal(Object.keys(h.requests[1].questions).length,1);
 for(const body of h.requests)for(const q of Object.values(body.questions))assert.ok(Object.keys(q.criteria).length<=25);
});
test('I: act exposes a newly opened tab',async()=>{
 const h=harness([node('l','New window',{role:'link'})],[{answers:{target:answer('l')}}],{command:cmd=>cmd.type==='click_ref'?{success:true,verified:true,newTab:{targetId:'tab-2',url:'https://example.test/new'}}:undefined});
 assert.deepEqual((await h.run({goal:'open new window'})).newTab,{targetId:'tab-2',url:'https://example.test/new'});
});
test('J: act exposes a pending website dialog',async()=>{
 const dialog={id:'dialog-1',type:'alert',message:'Fixture'};
 const h=harness([node('a','JS alert')],[{answers:{target:answer('a')}}],{command:cmd=>cmd.type==='click_ref'?{success:true,verified:true,needsDialogResponse:true,dialog}:undefined});
 const r=await h.run({goal:'open JS alert'});assert.equal(r.needsDialogResponse,true);assert.deepEqual(r.dialog,dialog);
});
test('K: hidden/loading preflight stops before snapshot and any billed decision',async()=>{
 for(const code of ['browser_tab_not_visible','page_loading']){
  const h=harness([node('r','Continue')],[],{command:cmd=>cmd.type==='act_preflight'?{success:false,verified:false,code,error:code,inputMayHaveOccurred:false}:undefined});
  const r=await h.run({goal:'continue'});assert.equal(r.acted,false);assert.equal(r.reason,code);assert.equal(h.requests.length,0);assert.equal(h.sent.length,1);
 }
});
test('L: iframe-only fields explain the screenshot and focused typing fallback',async()=>{
 const h=harness([],[],{snapshot:{visibleFrames:1}});const r=await h.run({goal:'editor body',text:'caller-only-text'});
 assert.match(r.error,/frames/);assert.match(r.error,/browser_screenshot/);assert.match(r.error,/browser_click_xy/);assert.match(r.error,/browser_type/);
});
test('M: help links can be followed; explicit logout links and submit buttons refuse',async()=>{
 for(const [name,role,expected] of [['How to remove stains','link',true],['Log out','link',false],['Delete account','link',false],['Submit order','button',false]]){
  const h=harness([node('r',name,{role})],[{answers:{target:answer('r')}}]);assert.equal((await h.run({goal:'open '+name})).acted,expected,name);
 }
});
test('typed values echoed by a page stay out of decisions, including escaped multiline text',async()=>{
 const secret='private "value"\nsecond line';
 const h=harness([node('field','Name',{role:'textbox',context:secret})],[{answers:{target:answer('field')}}]);
 assert.equal((await h.run({goal:'name field',text:secret})).acted,true);
 const strings=Object.values(h.requests[0].questions.target.criteria);assert.ok(strings.every(s=>!s.includes(secret)));
 assert.equal(h.sent.at(-1).text,secret);assert.equal(h.sent.at(-1).ref,'field');
});
test('dense-page select still needs only two calls and verifies its value',async()=>{
 const nodes=Array.from({length:26},(_,i)=>node('r'+i,'Control '+i));
 nodes[24]=node('s','Dropdown',{role:'combobox',tag:'select',options:[{value:'2',label:'Option 2'}]});
 const h=harness(nodes,[{answers:{group_0:answer('r0',.99),group_1:answer('s',.7)}},body=>({answers:{target:answer('s',.95),select_s:answer('option_0',.95)}})]);
 const r=await h.run({goal:'choose Option 2'});assert.equal(r.acted,true);assert.equal(r.operation,'select');assert.equal(r.decisionCalls,2);
});
test('select none/low-confidence and missing verification never claim goal completion',async()=>{
 const nodes=[node('s','Menu',{role:'combobox',tag:'select',options:[{value:'2',label:'Option 2'}]})];
 for(const a of [answer('none'),answer('option_0',.2)]){
  const h=harness(nodes,[{answers:{target:answer('s')}},{answers:{select_s:a}}]);
  const r=await h.run({goal:'choose Option 2'});assert.equal(r.acted,false);assert.ok(!h.sent.some(c=>c.type==='control_run'));
 }
});
test('no Enter follows a refused type or a pending dialog',async()=>{
 for(const receipt of [{success:false,code:'focus_not_confirmed',error:'Focus lost'},{success:true,needsDialogResponse:true,dialog:{id:'d'}}]){
  const h=harness([node('t','Name',{role:'textbox'})],[{answers:{target:answer('t')}}],{command:c=>c.type==='type_ref'?receipt:undefined});
  await h.run({goal:'name field',text:'hello',submit:true});assert.ok(!h.sent.some(c=>c.type==='press'));
 }
});
test('large select shortlists options in call one and compares winners in call two',async()=>{
 const options=Array.from({length:30},(_,i)=>({value:String(i),label:'Option '+i}));
 const n=node('s','Menu',{role:'combobox',tag:'select',options});
 const first={answers:{target:answer('s'),options_s_0:answer('option_0',.99),options_s_1:answer('option_27',.7)}};
 const h=harness([n],[first,{answers:{select_s:answer('option_27',.95)}}]);
 const r=await h.run({goal:'choose Option 27'});assert.equal(r.acted,true);assert.equal(r.decisionCalls,2);assert.equal(h.sent.at(-1).steps[0].value,'27');
 const invalid=harness([n],[first,{answers:{select_s:answer('option_26',.99)}}]);
 assert.equal((await invalid.run({goal:'choose Option 27'})).acted,false);
 for(const request of h.requests){assert.ok(Object.keys(request.questions).length<=64);for(const q of Object.values(request.questions))assert.ok(Object.keys(q.criteria).length<=25);}
});
