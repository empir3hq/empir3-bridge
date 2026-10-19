// Real owner-monitor transport acceptance with its own profile and ports.
// Native input uses only a disposable window when --run-interactive is passed.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {nativeMonitorFixture} from './monitor-native-fixture.mjs';

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
const enabledTools=Object.fromEntries(['desktop_hover','desktop_screenshot','desktop_click','desktop_drag','desktop_type','desktop_key','desktop_scroll','browser_click_xy','browser_navigate','browser_snapshot','browser_evaluate','browser_click','browser_type','browser_click_ref','browser_type_ref','browser_tab_open','browser_tab_close','browser_record_start','browser_record_stop','browser_play'].map(key=>[key,true]));
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
async function cdp(url){
  const ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});
  let seq=0;const pending=new Map();const errors=[];
  ws.on('message',data=>{const r=JSON.parse(String(data));if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails.text);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);clearTimeout(p.timer);r.error?p.fail(Error(r.error.message)):p.ok(r.result);}});
  return {errors,close:()=>ws.close(),send:(method,params={})=>new Promise((ok,fail)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);fail(Error(`CDP timeout: ${method}`));},15000);pending.set(id,{ok,fail,timer});ws.send(JSON.stringify({id,method,params}));})};
}

async function command(body){const r=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)});const data=await r.json();if(!r.ok||data.ok===false||data.result?.success===false)throw new Error(JSON.stringify(data));return data.result;}
let fixture;
const sessionId='monitor-test-123456789012345';
const monitor=(surface,action,params={})=>command({type:surface==='desktop'?'desktop:gui':'desktop:browse',action,params:{sessionId,...params}});
try{
 let ready=false;
 for(let i=0;i<300;i++){try{ready=(await fetch(base+'/api/status')).ok&&(await(await fetch(bridgeBase+'/health')).json()).cdpConnected;}catch{}if(ready)break;assert.equal(server.exitCode,null,logs.server.slice(-1000));assert.equal(browser.exitCode,null,logs.bridge.slice(-1000));await delay(200);}
 assert.ok(ready,'isolated runtime ready');
 await command({type:'navigate',url:base+'/control-lab'});
 await command({type:'evaluate',script:`window.monitorEvents=[];document.addEventListener('contextmenu',e=>{e.preventDefault();monitorEvents.push('right')});document.addEventListener('dblclick',()=>monitorEvents.push('double'));document.addEventListener('mousedown',e=>monitorEvents.push('down'));document.addEventListener('mouseup',e=>monitorEvents.push('up'));`});
 const geometry=await command({type:'evaluate',script:`JSON.stringify({w:innerWidth,h:innerHeight,name:document.querySelector('#name').getBoundingClientRect().toJSON(),save:document.querySelector('#save').getBoundingClientRect().toJSON()})`});
 const g=typeof geometry.result==='string'?JSON.parse(geometry.result):geometry.result;
 const at=rect=>({x:(rect.x+rect.width/2)/g.w,y:(rect.y+rect.height/2)/g.h});
 const inputs=[];
 const input=async value=>{const frame=await monitor('browser','monitor_frame');assert.ok(frame.base64.length>1000);const t=performance.now();const r=await monitor('browser','monitor_input',{frameId:frame.frameId,input:value});inputs.push({kind:value.kind,ms:Math.round(performance.now()-t)});return r;};
 await input({kind:'move',...at(g.name)});
 assert.equal((await command({type:'evaluate',script:'monitorEvents.length'})).result,0);
 await input({kind:'click',...at(g.name)});
 await input({kind:'type',text:'Monitor café ✓'});
 await input({kind:'key',key:'a',modifiers:['Control']});
 await input({kind:'type',text:'Monitor final ✓'});
 await input({kind:'click',...at(g.save)});
 await input({kind:'click',...at(g.name),button:'right'});
 await input({kind:'doubleclick',...at(g.name)});
 await input({kind:'drag',x:0.4,y:0.8,toX:0.7,toY:0.8});
 await input({kind:'scroll',x:0.5,y:0.8,deltaY:120});
 const observed=await command({type:'evaluate',script:`JSON.stringify({value:document.querySelector('#name').value,status:document.querySelector('#status').textContent,events:monitorEvents})`});
 const result=typeof observed.result==='string'?JSON.parse(observed.result):observed.result;
 assert.equal(result.value,'Monitor final ✓');assert.equal(result.status,'Saved 1');assert.ok(result.events.includes('right'));assert.ok(result.events.includes('double'));
 const stale=await monitor('browser','monitor_frame');await command({type:'tab_open',url:base+'/control-lab?second=1'});
 await assert.rejects(monitor('browser','monitor_input',{frameId:stale.frameId,input:{kind:'click',x:0.5,y:0.5}}),/tab changed/);
 const agentId='monitor-handoff-fixture';
 const login=await command({type:'desktop:browse',action:'open',params:{agentId,url:base+'/control-lab?handoff=1'}});
 await command({type:'desktop:browse',action:'tab_focus',params:{targetId:login.targetId,tabAction:'user_focus'}});
 await assert.rejects(command({type:'desktop:browse',action:'screenshot',params:{agentId}}),/user.s focus/);
 const handoff=await monitor('browser','monitor_frame',{agentId});
 assert.equal(handoff.targetId,login.targetId);
 await monitor('browser','monitor_input',{agentId,frameId:handoff.frameId,input:{kind:'click',...at(g.name)}});
 await monitor('browser','monitor_input',{agentId,frameId:handoff.frameId,input:{kind:'type',text:'Private handoff ✓'}});
 const handoffProof=await command({type:'evaluate',script:'document.querySelector("#name").value'});assert.equal(handoffProof.result,'Private handoff ✓');
 await command({type:'record_start'});
 await assert.rejects(monitor('browser','monitor_frame'),/Stop browser recording/);
 await assert.rejects(monitor('browser','monitor_input',{frameId:handoff.frameId,input:{kind:'type',text:'must-not-record'}}),/Stop browser recording/);
 const recording=await command({type:'record_stop',text:'monitor-empty-private-check'});
 assert.ok(!JSON.stringify(recording).includes('must-not-record'));
 let native=null;
 if(process.argv.includes('--run-interactive')){
  fixture=await nativeMonitorFixture(state);
  let matches=[];
  for(let i=0;i<30&&!matches.length;i++){
    const windows=await command({type:'desktop:window',action:'list',params:{title:'Empir3 Monitor Acceptance'}});
    matches=windows.windows.filter(w=>w.title==='Empir3 Monitor Acceptance');if(!matches.length)await delay(100);
  }
  assert.equal(matches.length,1,'Disposable fixture must be visible before input');
  await command({type:'control_activate',target:{surface:'desktop',windowHandle:matches[0].handle}});
  const timings=[];let frame;
  for(let i=0;i<4;i++){const t=performance.now();frame=await monitor('desktop','monitor_frame');timings.push(Math.round(performance.now()-t));assert.ok(frame.base64.length>1000);}
  console.log('Native frame timings: '+JSON.stringify(timings));
  const waitProof=async(key,value)=>{for(let i=0;i<100;i++){try{if(fixture.proof()[key]===value)return;}catch{}await delay(50);}assert.equal(fixture.proof()[key],value);};
  const b=frame.bounds,p=fixture.proof();
  const xy=(x,y)=>({x:(x-b.x)/b.width,y:(y-b.y)/b.height});
  const center=r=>xy(r.x+r.width/2,r.y+r.height/2);
  const dispatch=async value=>{const f=await monitor('desktop','monitor_frame');return monitor('desktop','monitor_input',{frameId:f.frameId,input:value});};
  await dispatch({kind:'move',...xy(p.panel.x+20,p.panel.y+20)});
  await dispatch({kind:'move',...center(p.panel)});
  await delay(100);const hover=fixture.proof();
  assert.ok(hover.hovers>p.hovers,'standalone native movement reaches the fixture: '+JSON.stringify({before:p,after:hover}));
  assert.equal(hover.clicks,p.clicks,'standalone native movement never clicks');
  await dispatch({kind:'click',...center(p.field)});
  await dispatch({kind:'type',text:'Native monitor café ✓'});
  await waitProof('text','Native monitor café ✓');
  await dispatch({kind:'key',key:'a',modifiers:['Control']});
  await dispatch({kind:'type',text:'Native final ✓'});
  await waitProof('text','Native final ✓');
  await dispatch({kind:'click',...center(p.button)});
  await dispatch({kind:'doubleclick',...center(p.button)});
  await dispatch({kind:'click',...center(p.panel),button:'right'});
  const end=xy(p.panel.x+450,p.panel.y+40);
  await dispatch({kind:'drag',...xy(p.panel.x+30,p.panel.y+40),toX:end.x,toY:end.y});
  await dispatch({kind:'scroll',...center(p.panel),deltaY:-240});
  await delay(100);const proof=fixture.proof();
  assert.equal(proof.text,'Native final ✓');assert.equal(proof.clicks,3);assert.equal(proof.right,1);assert.equal(proof.wheels,240);
  assert.ok(Math.abs(proof.down.x-30)<=2&&Math.abs(proof.up.x-450)<=2&&proof.moves>=5,'continuous native drag');
  native={frameMs:timings,bounds:b,width:frame.width,height:frame.height,monitors:frame.monitors,proof};
  const secondary=frame.monitors.find(m=>!m.primary);
  if(secondary){
    const second=await monitor('desktop','monitor_frame',{monitor:secondary.id});
    await command({type:'desktop:window',action:'resize',params:{title:'Empir3 Monitor Acceptance',x:second.bounds.x+180,y:second.bounds.y+180}});
    await delay(200);const before=fixture.proof(),r=before.button;
    const secondFrame=await monitor('desktop','monitor_frame',{monitor:secondary.id});
    await monitor('desktop','monitor_input',{frameId:secondFrame.frameId,input:{kind:'click',x:(r.x+r.width/2-second.bounds.x)/second.bounds.width,y:(r.y+r.height/2-second.bounds.y)/second.bounds.height}});
    await waitProof('clicks',before.clicks+1);native.secondary={passed:true,bounds:second.bounds};
    await command({type:'desktop:window',action:'resize',params:{title:'Empir3 Monitor Acceptance',x:b.x+180,y:b.y+180}});
    await delay(200);
  }
  writeFileSync(join(state,'desktop-frame.jpg'),Buffer.from(frame.base64,'base64'));
 }
 const receipt={passed:true,state,inputs,result,native,wrongTabRefused:true,userFocusHandoffPassed:true,recordingPrivacyPassed:true};writeFileSync(join(state,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
 if(process.env.EMPIR3_MONITOR_TEST_READY){
   writeFileSync(process.env.EMPIR3_MONITOR_TEST_READY,JSON.stringify({base,nonce,state,bridgeBase,cdpPort}));
   for(let i=0;i<1800&&!existsSync(join(state,'finish'));i++)await delay(1000);
 }
}finally{
 fixture?.stop();
 try{const version=await(await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();const connection=await cdp(version.webSocketDebuggerUrl);await connection.send('Browser.close').catch(()=>{});connection.close();}catch{}
 browser.kill();server.kill();for(const [name,text]of Object.entries(logs))writeFileSync(join(state,name+'.log'),text);console.log('Retained test state: '+state);
}
