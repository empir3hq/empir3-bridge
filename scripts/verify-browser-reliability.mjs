// Real Chrome + daemon regression proofs in an isolated profile. No relay or keys.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import act from '../src/browser-act.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=process.env.EMPIR3_TEST_RUNTIME_ROOT || root;
const args=name=>runtime===root?['--import','tsx',`src/${name}.ts`]:[`bundle-${name}.js`];
const state=mkdtempSync(join(tmpdir(),'empir3-reliability-'));
const port=13206,cdpBridge=13207,cdp=19346,base=`http://127.0.0.1:${port}`,direct=`http://127.0.0.1:${cdpBridge}`,nonce=randomBytes(24).toString('hex');
mkdirSync(join(state,'roaming','Empir3'),{recursive:true});mkdirSync(join(state,'.empir3-bridge'),{recursive:true});
writeFileSync(join(state,'roaming','Empir3','bridge-settings.json'),JSON.stringify({globalSafety:{read:true,write:true,execute:true},empir3Permissions:{read:true,write:true,execute:true}}));
writeFileSync(join(state,'.empir3-bridge','config.json'),JSON.stringify({mode:'api',apiKeys:{},enabledTools:{browser_act:true,browser_click:true,browser_click_ref:true,browser_type:true,browser_type_ref:true,browser_press:true,browser_evaluate:true,browser_snapshot:true,browser_navigate:true}}));
const env={...process.env,PW_PORT:String(port),EMPIR3_BRIDGE_PORT:String(cdpBridge),BRIDGE_PORT:String(cdpBridge),CDP_PORT:String(cdp),BRIDGE_PROFILE:join(state,'chrome'),BRIDGE_HEADLESS:'true',EMPIR3_CHROME_HEADLESS:'1',EMPIR3_BRIDGE_NONCE:nonce,APPDATA:join(state,'roaming'),USERPROFILE:state,LOCALAPPDATA:join(state,'local'),EMPIR3_BRIDGE_CONFIG_DIR:join(state,'.empir3-bridge'),EMPIR3_BRIDGE_RUNTIME_DATA_DIR:join(state,'data'),EMPIR3_BRIDGE_NO_RELAY:'1',EMPIR3_WS_URL:'',EMPIR3_AUTH_TOKEN:''};
let logs='';
// Chrome uses its ordinary OS environment with only a disposable profile;
// provider/daemon state remains isolated by the explicit directories above.
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[`--remote-debugging-port=${cdp}`,`--user-data-dir=${join(state,'chrome')}`,'--headless=new','--no-first-run','--no-default-browser-check','--disable-popup-blocking','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
chrome.stderr.on('data',d=>logs+=d);
const children=[chrome,...['bridge','server'].map(name=>{const p=spawn(process.execPath,args(name),{cwd:runtime,windowsHide:true,env:{...env,EMPIR3_CHROME_AUTOLAUNCH:'0'},stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>logs+=d);p.stderr.on('data',d=>logs+=d);return p;})];
const proofs=[];
async function directCall(route,body){const r=await fetch(direct+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,result:await r.json()};}
async function command(cmd){const r=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(cmd)});const e=await r.json();assert.equal(r.status,200,JSON.stringify(e));if(e.ok===false)throw Error(e.error);return e.result;}
async function evaluate(script){const r=await command({type:'evaluate',script});assert.notEqual(r.success,false,JSON.stringify(r));return r.result;}
async function fixture(html,script=''){await evaluate(`document.body.innerHTML=${JSON.stringify('<main style="padding:40px;font:20px sans-serif">'+html+'</main>')};${script};true`);}
async function snap(){return (await command({type:'snapshot'})).snapshot;}
async function foreground(targetId){
 const tabs=await fetch(`http://127.0.0.1:${cdp}/json`).then(r=>r.json());
 const tab=tabs.find(t=>t.id===targetId);assert.ok(tab?.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{const ws=new WebSocket(tab.webSocketDebuggerUrl);const timer=setTimeout(()=>{ws.terminate();reject(Error('Activation timed out'));},3000);ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Page.bringToFront'})));ws.on('message',data=>{const r=JSON.parse(data);if(r.id===1){clearTimeout(timer);ws.close();r.error?reject(Error(r.error.message)):resolve();}});ws.on('error',reject);});
}
const config={url:'http://fixture.invalid',model:'deterministic regression oracle',minConfidence:.6,timeoutMs:8000,source:'env'};
async function run(goal,text,pick,opts={}){let calls=0;const r=await act.runBrowserAct({goal,...(text!==undefined?{text}:{}),...opts},config,{command,decide:async body=>{calls++;return {answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>{const selected=pick(key,q,calls);return [key,{choice:selected,confidence:.95,probabilities:{[selected]:.95,none:.05}}];}))};}});return r;}
const byName=text=>(key,q)=>Object.entries(q.criteria).find(([k,v])=>k!=='none'&&v.includes(text))?.[0] || 'none';
async function proof(item,fn){try{const receipt=await fn();proofs.push({item,ok:true,receipt});console.log(`${item}: passed`);}catch(e){proofs.push({item,ok:false,error:e.message});throw e;}}
try{
 for(let i=0;i<120;i++){try{if((await fetch(base+'/api/status')).ok&&(await fetch(`http://127.0.0.1:${cdp}/json/version`)).ok)break;}catch{}if(i===119)throw Error('Startup failed: '+JSON.stringify(await directCall('/health')));await delay(500);}
 await command({type:'navigate',url:base+'/desktop-test'});
 await proof('A',async()=>{
  await fixture('<input id="replace" aria-label="Replacement" style="width:300px;height:40px"><input id="other" aria-label="Different field" style="display:block;margin-top:100px">',`document.querySelector('#replace').addEventListener('focus',function(){const n=this.cloneNode();this.replaceWith(n);n.focus()},{once:true})`);
  let s=await snap(),ref=s.nodes.find(n=>n.name==='Replacement').ref;
  const good=await command({type:'type_ref',ref,text:'Event horizon'});assert.equal(good.verified,true);assert.equal(await evaluate('document.querySelector("#replace").value'),'Event horizon');
  await fixture('<input id="replace" aria-label="Replacement" style="width:300px;height:40px"><input id="other" aria-label="Different field" style="display:block;margin-top:100px">',`document.querySelector('#replace').onfocus=()=>document.querySelector('#other').focus()`);
  s=await snap();ref=s.nodes.find(n=>n.name==='Replacement').ref;const refused=await command({type:'type_ref',ref,text:'Must not leak'});assert.equal(refused.code,'focus_not_confirmed');assert.equal(await evaluate('document.querySelector("#other").value'),'');return {good,refused};
 });
 await proof('B',async()=>{await fixture('<select aria-label="Menu"><option value="1">One</option></select>');const ref=(await snap()).nodes.find(n=>n.tag==='select').ref;const r=await command({type:'type_ref',ref,text:'One'});assert.equal(r.success,false);assert.equal(r.verified,false);assert.equal(r.code,'select_not_text_field');const d=await directCall('/action',{kind:'type',ref,text:'One'});assert.equal(d.http,200);assert.equal(d.result.code,r.code);return {wrapper:r,direct:d};});
 await proof('C',async()=>{await evaluate(`window.loading=true;Object.defineProperty(document,'readyState',{get:()=>window.loading?'loading':'complete',configurable:true});const body=document.body;body.remove();setTimeout(()=>{document.documentElement.append(body);window.loading=false},700);true`);const began=Date.now();const s=await snap();assert.ok(Date.now()-began>=500);assert.ok(s.nodes.length);await evaluate(`window.loading=true;true`);const r=await snap();assert.equal(r.code,'page_loading');await directCall('/evaluate-on-target',{targetId:(await directCall('/tabs')).result.currentTargetId,expression:'window.loading=false;true'});return {waitedMs:Date.now()-began,refusal:r};});
 await proof('D',async()=>{await fixture('<label for="menu">Dropdown</label><select id="menu"><option disabled value="">Please select</option><option value="1">Option 1</option><option value="2">Option 2</option></select>');const r=await run('choose Option 2',undefined,(key,q)=>byName(key.startsWith('select_')?'Option 2':'Dropdown')(key,q));assert.equal(r.operation,'select');assert.equal(r.acted,true);assert.equal(await evaluate('document.querySelector("#menu").value'),'2');return r;});
 await proof('E',async()=>{await fixture('<input type="checkbox"> Checkbox 1<br><input type="checkbox" checked> Checkbox 2');const s=await snap();assert.equal(s.nodes.filter(n=>n.role==='checkbox').length,2);const r=await run('tick checkbox 1',undefined,byName('Checkbox 1'));assert.equal(r.acted,true);assert.equal(await evaluate('document.querySelector("input").checked'),true);return {snapshot:s,act:r};});
 await proof('F',async()=>{await fixture([1,2,3].map(i=>`<article><h2>Story ${i}</h2><a href="#story-${i}">comments</a></article>`).join(''));const s=await snap();const links=s.nodes.filter(n=>n.role==='link');assert.equal(links.length,3);assert.equal(links[2].order,3);const r=await run('third story comments',undefined,byName('Story 3'));assert.equal(await evaluate('location.hash'),'#story-3');return r;});
 await proof('G',async()=>{await fixture('<input type="checkbox" checked> Checkbox 2<button disabled>Disabled</button>');const s=await snap();assert.equal(s.nodes.find(n=>n.role==='checkbox').checked,true);const r=await run('tick checkbox 2',undefined,byName('Checkbox 2'));assert.equal(r.reason,'already_done');assert.equal(await evaluate('document.querySelector("input").checked'),true);return r;});
 await proof('H',async()=>{await fixture(Array.from({length:49},(_,i)=>`<button style="font:10px sans-serif;padding:1px" onclick="window.clicked=${i}">Control ${i}</button>`).join(''));const r=await run('control 24',undefined,(key,q,call)=>call===2?Object.entries(q.criteria).find(([k,v])=>k!=='none'&&v.includes('Control 24'))?.[0]||'none':Object.keys(q.criteria).find(k=>k!=='none'));assert.equal(r.decisionCalls,2);assert.equal(await evaluate('window.clicked'),24);return r;});
 await proof('I',async()=>{await fixture('<a href="'+base+'/desktop-test?new-window=1" target="_blank">New window</a>');const r=await run('open new window',undefined,byName('New window'));assert.ok(r.newTab?.targetId);assert.match(r.newTab.url,/new-window/);assert.equal(await evaluate('document.visibilityState'),'visible');await directCall('/close-target',{targetId:r.newTab.targetId});return r;});
 await proof('J',async()=>{await fixture('<button onclick="alert(\'Fixture alert\')">JS alert</button>');const r=await run('open JS alert',undefined,byName('JS alert'));assert.equal(r.needsDialogResponse,true);assert.ok(r.dialog?.id);await directCall('/dialog',{targetId:r.dialog.targetId,action:'accept',dialogId:r.dialog.id});return r;});
 await proof('K',async()=>{const original=(await directCall('/tabs')).result.currentTargetId;const opened=await directCall('/create-tab',{url:base+'/desktop-test?hidden-test=1'});await directCall('/activate-target',{targetId:original});await foreground(opened.result.targetId);await delay(100);assert.equal(await evaluate('document.visibilityState'),'hidden');let billed=0;const r=await act.runBrowserAct({goal:'continue'},config,{command,decide:async()=>{billed++;throw Error('Must not bill');}});assert.equal(r.reason,'browser_tab_not_visible');assert.equal(billed,0);await directCall('/close-target',{targetId:opened.result.targetId});await directCall('/show',{});return r;});
 await proof('L',async()=>{await fixture('<iframe srcdoc="<input aria-label=editor>" style="width:600px;height:300px"></iframe>');const r=await run('editor body','Text stays local',()=> 'none');assert.match(r.error,/frames/);assert.match(r.error,/browser_click_xy/);return r;});
 await proof('M',async()=>{await fixture('<a href="#stains">How to remove stains</a><a href="#logout">Log out</a><input type="submit" value="Submit order" aria-label="Submit order">');const good=await run('open help',undefined,byName('How to remove stains'));assert.equal(good.acted,true);const logout=await run('log out',undefined,byName('Log out'));assert.equal(logout.reason,'irreversible');const submit=await run('submit order',undefined,byName('Submit order'));assert.equal(submit.reason,'irreversible');return {good,logout,submit};});
 const pairedUrl=process.argv.find(a=>a.startsWith('--paired-bridge-url='))?.split('=').slice(1).join('=');
 if(pairedUrl)await proof('F-H-public',async()=>{
  const url=new URL(pairedUrl);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Use an explicitly selected local paired Bridge');
  const id=await fetch(pairedUrl+'/api/identity').then(r=>r.json());
  await command({type:'navigate',url:'https://news.ycombinator.com/'});
  const expected=await evaluate(`(()=>{const story=document.querySelectorAll('tr.athing')[2];const link=Array.from(story.nextElementSibling.querySelectorAll('a')).find(a=>/comments?|discuss/i.test(a.textContent));return {title:story.querySelector('.titleline').innerText,url:link?.href}})()`);
  const s=await snap();const comment=s.nodes.find(n=>n.itemOrder===3 && /comments?|discuss/.test(n.name));assert.ok(comment,JSON.stringify(s));
  const decide=act.createEmpir3Decider(async body=>{const r=await fetch(pairedUrl+'/api/command',{method:'POST',headers:{Origin:pairedUrl,'Content-Type':'application/json','X-Empir3-Nonce':id.nonce},body:JSON.stringify({...body,channel:'mcp'})});const result=await r.json();return result.result;});
  const result=await act.runBrowserAct({goal:'open the comments of the third story'}, {...config,source:'empir3',model:'Empir3'}, {command,decide});
  assert.equal(result.acted,true,JSON.stringify(result));assert.equal(result.decisionCalls,2);const actual=await evaluate('location.href');assert.equal(actual,expected.url,JSON.stringify({expected,actual,result}));return {expected,actual,thirdStoryControl:comment,result};
 });
}catch(e){console.error(e.stack);console.error(logs.slice(-3000));process.exitCode=1;}finally{
 const receipt={at:new Date().toISOString(),runtime,state,proofs,ok:proofs.length>=13&&proofs.every(p=>p.ok)};
 writeFileSync(join(state,'receipt.json'),JSON.stringify(receipt,null,2));console.log('Receipt: '+join(state,'receipt.json'));
 for(const p of children)if(p.pid)spawnSync('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{stdio:'ignore'});
}
