// Real browser + stdio MCP acceptance. Own profile/ports; no native input or clipboard.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=process.env.EMPIR3_TEST_RUNTIME_ROOT?resolve(process.env.EMPIR3_TEST_RUNTIME_ROOT):root;
const args=name=>runtimeRoot===root?['--import','tsx',`src/${name}.ts`]:[`bundle-${name}.js`];
const state=mkdtempSync(join(tmpdir(),'empir3-observation-acceptance-'));
const reservations=[];
for(let i=0;i<3;i++){
  const reservation=createServer();await new Promise((ok,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',ok);});reservations.push(reservation);
}
const [port,bridgePort,cdpPort]=reservations.map(server=>server.address().port);
await Promise.all(reservations.map(server=>new Promise(ok=>server.close(ok))));
const base=`http://127.0.0.1:${port}`,bridgeBase=`http://127.0.0.1:${bridgePort}`;
const nonce=randomBytes(24).toString('hex');
mkdirSync(join(state,'appdata','Empir3'),{recursive:true});mkdirSync(join(state,'.empir3-bridge'),{recursive:true});
writeFileSync(join(state,'appdata','Empir3','bridge-settings.json'),JSON.stringify({globalSafety:{read:true,write:true,execute:true},empir3Permissions:{read:true,write:true,execute:true}}));
const enabledTools=Object.fromEntries(['browser_navigate','browser_snapshot','browser_evaluate','browser_click','browser_type','browser_click_ref','browser_type_ref','browser_tab_open','browser_tab_close','browser_record_start','browser_record_stop','browser_play'].map(key=>[key,true]));
writeFileSync(join(state,'.empir3-bridge','config.json'),JSON.stringify({mode:'api',apiKeys:{},enabledTools}));
const env={...process.env,PW_PORT:String(port),BRIDGE_PORT:String(bridgePort),EMPIR3_BRIDGE_PORT:String(bridgePort),CDP_PORT:String(cdpPort),EMPIR3_BRIDGE_NONCE:nonce,EMPIR3_WS_URL:'',EMPIR3_AUTH_TOKEN:'',EMPIR3_SERVER:'http://127.0.0.1:1',APPDATA:join(state,'appdata'),LOCALAPPDATA:join(state,'localappdata'),USERPROFILE:state,EMPIR3_BRIDGE_RUNTIME_DATA_DIR:state,BRIDGE_PROFILE:join(state,'chrome-profile'),EMPIR3_CHROME_HEADLESS:'1'};
const logs={server:'',bridge:'',mcp:''};
const start=name=>{
  // Chrome needs the real Windows environment; BRIDGE_PROFILE isolates its data.
  // The daemon and MCP keep separate synthetic app/config directories.
  const childEnv=name==='bridge'?{...env,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,USERPROFILE:process.env.USERPROFILE}:env;
  const child=spawn(process.execPath,args(name),{cwd:runtimeRoot,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>logs[name]+=d);child.stderr.on('data',d=>logs[name]+=d);return child;
};
const server=start('server'),browser=start('bridge');
const client=new Client({name:'observation-acceptance',version:'1.0.0'});
let transport;
async function call(name,arguments_,expectError=false){
  const reply=await client.callTool({name,arguments:arguments_});
  const text=reply.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if(expectError){assert.ok(reply.isError,text);return text;}
  assert.ok(!reply.isError,text);
  if(name==='browser_record_start')return {text};
  if(name==='browser_record_stop'){
    const match=/^Saved: (.+) \((\d+) actions,/.exec(text);assert.ok(match,text);
    return {saved:match[1],actionCount:Number(match[2])};
  }
  return JSON.parse(text);
}
async function evaluate(target,script){const result=await call('browser_evaluate',{target,script:`JSON.stringify(${script})`});return typeof result.result==='string'?JSON.parse(result.result):result.result;}
async function cdp(url){
  const ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});
  let seq=0;const pending=new Map();const errors=[];
  ws.on('message',data=>{const r=JSON.parse(String(data));if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails.text);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);clearTimeout(p.timer);r.error?p.fail(Error(r.error.message)):p.ok(r.result);}});
  return {errors,close:()=>ws.close(),send:(method,params={})=>new Promise((ok,fail)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);fail(Error(`CDP timeout: ${method}`));},15000);pending.set(id,{ok,fail,timer});ws.send(JSON.stringify({id,method,params}));})};
}
try{
  let ready=false,lastHealth;
  for(let i=0;i<300;i++){try{lastHealth=await(await fetch(bridgeBase+'/health')).json();ready=(await fetch(base+'/api/status')).ok&&lastHealth.cdpConnected;}catch{}if(ready)break;assert.equal(server.exitCode,null,logs.server.slice(-2000));assert.equal(browser.exitCode,null,logs.bridge.slice(-2000));await delay(200);}
  assert.ok(ready,'Isolated runtime did not become ready: '+JSON.stringify(lastHealth));
  console.log('Isolated Chrome ready; checking the real MCP contract.');
  transport=new StdioClientTransport({command:process.execPath,args:args('mcp-server'),cwd:runtimeRoot,env:{...env,BRIDGE_URL:base},stderr:'pipe'});
  transport.stderr?.on('data',d=>logs.mcp+=d);await client.connect(transport);
  const tools=(await client.listTools()).tools;
  assert.match(tools.find(t=>t.name==='bridge_control_run').inputSchema.properties.steps.items.properties.expect.properties.locator.description,/Defaults to this step/);
  const {target}=await call('browser_tab_open',{url:base+'/control-lab'});
  const run=steps=>call('bridge_control_run',{target,steps});
  const read=()=>call('bridge_control_observe',{target,image:false});
  const initial=await read();assert.equal(initial.observation.controls.find(c=>c.id==='enabled').checked,false);
  const filled=await run([{action:'fill',locator:{selector:'#name'},value:'Inherited locator',when:{kind:'exists'},expect:{kind:'value',equals:'Inherited locator'}}]);
  console.log('Inherited locator dispatch returned; checking state and refusal.');
  assert.equal(filled.receipts[0].verified,true);
  // Real MCP + Chromium acceptance for bulk text, framework-driven DOM changes,
  // trusted input events, and a bounded long-value fill. No clipboard involved.
  const textTimings=[];
  await evaluate(target,'(() => {window.fillEvents=[];document.querySelector("#name").addEventListener("input",e=>window.fillEvents.push({trusted:e.isTrusted,value:e.target.value}));return true;})()');
  for(const value of ['Short test','Latency test. '.repeat(30),'Vincent — café ✓ 中文 😀 + {literal}','']){
    const started=performance.now();
    const result=await run([{action:'fill',locator:{selector:'#name'},value,expect:{kind:'value',equals:value}}]);
    const elapsedMs=Math.round(performance.now()-started);
    assert.equal(result.receipts[0].verified,true);
    textTimings.push({characters:value.length,elapsedMs});
    assert.ok(elapsedMs<5000,`Field fill took ${elapsedMs}ms for ${value.length} characters`);
  }
  assert.ok((await evaluate(target,'window.fillEvents')).every(event=>event.trusted),'Normal fills must produce trusted browser input');
  await evaluate(target,`(() => {
    const host=document.createElement('div');
    const field=document.createElement('textarea');field.setAttribute('aria-label','Moving editor');host.append(field);document.body.append(host);
    field.addEventListener('input',()=>{if(!host.previousElementSibling?.hasAttribute('data-popup-fixture')){const popup=document.createElement('div');popup.dataset.popupFixture='true';host.before(popup);}});
    const replacement=document.createElement('input');replacement.id='identity-replacement';replacement.value='original';document.body.append(replacement);
    replacement.addEventListener('input',()=>{if(replacement.value==='new'){const next=replacement.cloneNode();next.value='replacement must survive';replacement.replaceWith(next);}});
    const lost=document.createElement('input');lost.id='focus-lost';lost.value='original';document.body.append(lost);
    lost.addEventListener('input',()=>{if(lost.value==='')document.querySelector('#name').focus();});
    return true;
  })()`);
  const multiline='@Nemotron\nSecond line — 中文 😀';
  await run([{action:'fill',locator:{role:'textbox',name:'Moving editor'},value:multiline,expect:{kind:'value',equals:multiline}}]);
  const replaced=await call('browser_type',{target,selector:'#identity-replacement',text:'new'},true);
  assert.match(replaced,/disappeared while typing/);
  assert.equal(await evaluate(target,'document.querySelector("#identity-replacement").value'),'replacement must survive');
  const lost=await call('browser_type',{target,selector:'#focus-lost',text:'must not leak'},true);
  assert.match(lost,/lost focus before typing/);
  assert.equal(await evaluate(target,'document.querySelector("#focus-lost").value'),'original');
  assert.equal(await evaluate(target,'document.querySelector("#name").value'),'');
  assert.deepEqual(await evaluate(target,'Object.keys(window.__empir3ActionReceipts||{})'),[]);
  console.log('Bulk text acceptance: '+JSON.stringify(textTimings));
  await evaluate(target,'(() => {const el=document.createElement("div");el.id="editable";el.contentEditable="true";el.innerHTML="<b>Original</b><div>format</div>";document.body.append(el);return true;})()');
  const richCases=[
    ['First\\nSecond — 中文 😀','First<div>Second — 中文 😀</div>'],
    ['Trailing\\n','Trailing<div><br></div>'],
    ['\\nLeading','<br><div>Leading</div>'],
    ['\\n','<br><div><br></div>'],
    ['','<br>'],
    ['Blank\\n\\nline','Blank<div><br></div><div>line</div>'],
  ].map(([text,html])=>[text.replaceAll('\\n','\n'),html]);
  for(const [text,html] of richCases){
    await evaluate(target,'(document.querySelector("#editable").innerHTML="Original")');
    await call('browser_type',{target,selector:'#editable',text});
    assert.equal(await evaluate(target,'document.querySelector("#editable").innerHTML'),html);
  }
  await evaluate(target,'(() => {const el=document.querySelector("#editable");el.innerHTML="<b>Original</b><div>format</div>";el.addEventListener("input",()=>{if(el.textContent==="reject")el.innerHTML="<i>Rejected</i>";});return true;})()');
  assert.match(await call('browser_type',{target,selector:'#editable',text:'reject'},true),/verification failed/);
  assert.equal(await evaluate(target,'document.querySelector("#editable").innerHTML'),'<b>Original</b><div>format</div>');
  console.log('Rich-text blank/leading/trailing lines and formatted failure restoration passed.');
  const before=await evaluate(target,'document.querySelector("#status").textContent');
  const refusal=await call('bridge_control_run',{target,steps:[{action:'click',locator:{selector:'#save'}},{action:'wait',expect:{kind:'text',equals:'never'}}]},true);
  assert.match(refusal,/locator/i);assert.equal(await evaluate(target,'document.querySelector("#status").textContent'),before);
  await run([{action:'check',locator:{selector:'#enabled'},value:true,expect:{kind:'checked',equals:true}}]);assert.equal((await read()).observation.controls.find(c=>c.id==='enabled').checked,true);
  await run([{action:'check',locator:{selector:'#enabled'},value:false,expect:{kind:'checked',equals:false}}]);assert.equal((await read()).observation.controls.find(c=>c.id==='enabled').checked,false);
  await evaluate(target,'(() => {document.querySelector("#enabled").indeterminate=true;document.querySelector("#password").value="fixture-private";const host=document.createElement("section");host.innerHTML=\'<details open><summary id="expanded-fixture">Details</summary>Body</details><button id="aria-fixture" aria-expanded="false" aria-disabled="true">Disabled</button><div id="mixed-fixture" role="checkbox" aria-checked="mixed">Mixed</div>\';document.body.append(host);return true;})()');
  const observed=await read(),control=id=>observed.observation.controls.find(c=>c.id===id);
  assert.equal(control('enabled').checked,'mixed');assert.equal(control('mixed-fixture').checked,'mixed');assert.equal(control('expanded-fixture').expanded,true);assert.equal(control('aria-fixture').expanded,false);assert.equal(control('aria-fixture').disabled,true);assert.equal(control('password').value,null);assert.ok(!JSON.stringify(observed).includes('fixture-private'));
  await run([{action:'click',locator:{selector:'#save'},expect:{kind:'text',locator:{selector:'#status'},equals:'Saved 1'}},{action:'wait',expect:{kind:'url',contains:'/control-lab'}}]);
  await call('browser_record_start',{});
  await call('browser_type',{target,selector:'#name',text:'Recorded fast — 中文 😀'});
  await call('browser_click',{target,selector:'#save'});
  const recording=await call('browser_record_stop',{name:'bulk-fill-acceptance'});
  assert.ok(recording.actionCount>=3);
  const recordingPath=join(state,'recordings',recording.saved);
  const saved=JSON.parse(readFileSync(recordingPath,'utf8'));
  assert.ok(saved.controlSteps.filter(step=>step.action==='click').every(step=>step.expect===undefined));
  // Replay a real older v2 file as well as checking the new recorder format.
  for(const step of saved.controlSteps)if(step.action==='click')step.expect=null;
  writeFileSync(recordingPath,JSON.stringify(saved));
  const replay=await call('browser_play',{recording:recording.saved});assert.equal(replay.success,true);
  assert.equal(await evaluate(target,'document.querySelector("#name").value'),'Recorded fast — 中文 😀');
  assert.equal(await evaluate(target,'document.querySelector("#status").textContent'),'Saved 1');
  saved.controlSteps.push({action:'wait',expect:{kind:'text',equals:'never'}});
  writeFileSync(recordingPath,JSON.stringify(saved));
  await evaluate(target,'(window.recordingNavigationGuard="preserve")');
  assert.match(await call('browser_play',{recording:recording.saved},true),/locator/);
  assert.equal(await evaluate(target,'window.recordingNavigationGuard'),'preserve');
  assert.equal(await evaluate(target,'document.querySelector("#status").textContent'),'Saved 1');
  console.log('Recorded Unicode replay and whole-procedure preflight passed.');
  const surfaces=[];
  for(const surface of [{name:'console-light',url:base+'/welcome',theme:'light'},{name:'console-dark',url:base+'/welcome',theme:'dark'},{name:'control-limits',url:base+'/console'},{name:'browser-setup',url:bridgeBase+'/welcome'}]){
    console.log('Rendering '+surface.name);
    // Low-level setup is operator UI, outside normal MCP navigation policy.
    // Render its exact HTML in a disposable allowed tab; keep that guard intact.
    const setupHtml=surface.name==='browser-setup'?await(await fetch(surface.url)).text():null;
    const opened=await call('browser_tab_open',{url:setupHtml?base+'/control-lab':surface.url});
    const pages=await(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const connection=await cdp(pages.find(page=>page.id===opened.target.tabId).webSocketDebuggerUrl);
    try{
      await connection.send('Runtime.enable');await connection.send('Page.enable');
      await connection.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      if(setupHtml){const {frameTree}=await connection.send('Page.getFrameTree');await connection.send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:setupHtml});}
      if(surface.theme){await call('browser_click',{target:opened.target,selector:'.theme-toggle'});await call('browser_click',{target:opened.target,selector:'.theme-toggle'});await evaluate(opened.target,`(document.body.dataset.theme=${JSON.stringify(surface.theme)})`);}
      const assets=await connection.send('Runtime.evaluate',{expression:'Promise.all(Array.from(document.images).filter(img=>img.src.startsWith("data:image/svg+xml")).map(async img=>{await img.decode();const r=img.getBoundingClientRect();return {alt:img.alt,width:r.width,height:r.height,naturalWidth:img.naturalWidth,withinViewport:r.left>=0&&r.right<=innerWidth};}))',awaitPromise:true,returnByValue:true});
      assert.ok(!assets.exceptionDetails,JSON.stringify(assets.exceptionDetails));assert.ok(assets.result.value.length>0,`${surface.name}: logo absent`);assert.ok(assets.result.value.every(a=>a.naturalWidth>0&&a.withinViewport),JSON.stringify(assets.result.value));
      const shot=await connection.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(state,surface.name+'.png'),Buffer.from(shot.data,'base64'));
      assert.deepEqual(connection.errors,[],surface.name+' runtime errors');surfaces.push({name:surface.name,assets:assets.result.value,runtimeErrors:connection.errors});
    }finally{connection.close();}
  }
  const receipt={passed:true,runtimeRoot,state,ports:{port,bridgePort,cdpPort},toolCount:tools.length,textTimings,trustedInput:true,multilineUnicode:true,richTextLines:true,richFormattingRestored:true,recordingReplay:true,recordingWholePreflight:true,siblingInsertion:true,replacementPreserved:true,focusLossRefusedAndRestored:true,inheritedExpectation:true,inheritedWhen:true,malformedBatchNoInput:true,checkedTrueFalseMixed:true,expandedDisabled:true,passwordHidden:true,distinctConditionTarget:true,urlWait:true,surfaces};
  writeFileSync(join(state,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}finally{
  await client.close().catch(()=>{});
  // Only the unique CDP port belonging to this disposable profile is closed.
  try{const version=await(await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();const connection=await cdp(version.webSocketDebuggerUrl);await connection.send('Browser.close').catch(()=>{});connection.close();}catch{}
  browser.kill();server.kill();for(const [name,text] of Object.entries(logs))writeFileSync(join(state,name+'.log'),text);console.log('Retained test state: '+state);
}
