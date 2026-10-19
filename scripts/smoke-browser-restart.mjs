// Real isolated Chromium restart. Never uses the installed profile or user tabs.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=process.env.EMPIR3_TEST_RUNTIME_ROOT?resolve(process.env.EMPIR3_TEST_RUNTIME_ROOT):root;
const state=mkdtempSync(join(tmpdir(),'empir3-restart-acceptance-'));
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Restart fixture</title><textarea id="draft" name="draft"></textarea><script>const field=document.querySelector("#draft");field.value=sessionStorage.getItem("draft")||"";field.addEventListener("input",()=>sessionStorage.setItem("draft",field.value));</script>');});
await new Promise(ok=>fixture.listen(0,'127.0.0.1',ok));
const fixturePort=fixture.address().port;
async function freePort(){const s=createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
const bridgePort=await freePort(),cdpPort=await freePort();
const base=`http://127.0.0.1:${bridgePort}`;
const env={...process.env,BRIDGE_PORT:String(bridgePort),PW_PORT:String(fixturePort),CDP_PORT:String(cdpPort),BRIDGE_PROFILE:join(state,'chrome-profile'),EMPIR3_CHROME_HEADLESS:'1',EMPIR3_BRIDGE_FRESH:'0',EMPIR3_BRIDGE_NONCE:'restart-fixture',EMPIR3_WS_URL:'',EMPIR3_AUTH_TOKEN:''};
let child,logs='',generation=0,passed=false;
const results=[];
function start(){generation++;child=spawn(process.execPath,runtimeRoot===root?['--import','tsx','src/bridge.ts']:['bundle-bridge.js'],{cwd:runtimeRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);}
async function until(fn,description){for(let i=0;i<150;i++){try{const r=await fn();if(r)return r;}catch{}await delay(100);}throw Error(description);}
async function cdp(url){const ws=new WebSocket(url);await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});let seq=0;const pending=new Map();ws.on('message',b=>{const r=JSON.parse(String(b));const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error.message)):p.resolve(r.result);}});return {close:()=>ws.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));})};}
async function inventory(){return (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter(t=>t.type==='page');}
async function ready(){return until(async()=>{assert.equal(child.exitCode,null,logs.slice(-1000));const h=await(await fetch(base+'/health')).json();return h.cdpConnected;},'Isolated bridge readiness timed out');}
async function closeChrome(){try{const v=await(await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();const c=await cdp(v.webSocketDebuggerUrl);await c.send('Browser.close').catch(()=>{});c.close();}catch{}await until(async()=>{try{await fetch(`http://127.0.0.1:${cdpPort}/json/version`);return false;}catch{return true;}},'Isolated Chrome did not close');}
try{
 start();await ready();console.log('Initial isolated browser ready.');
 const urls=['a','b'].map(p=>`http://127.0.0.1:${fixturePort}/${p}`);
 for(const [index,url] of urls.entries()){
  const r=await(await fetch(base+'/create-tab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})).json();assert.ok(r.targetId,JSON.stringify(r));
  const t=await until(async()=> (await inventory()).find(t=>t.id===r.targetId&&t.url===url),'Fixture tab did not load');
  const c=await cdp(t.webSocketDebuggerUrl);
  await until(async()=> (await c.send('Runtime.evaluate',{expression:'!!document.querySelector("#draft")',returnByValue:true})).result?.value,'Fixture input missing');
  await c.send('Runtime.evaluate',{expression:'document.querySelector("#draft").focus()'});
  await c.send('Input.insertText',{text:`Draft ${index} — café ✓`});c.close();
 }
 console.log('Two isolated drafts entered; restarting.');
 await closeChrome();child.kill();await new Promise(ok=>child.exitCode!==null?ok():child.once('exit',ok));
 start();await ready();console.log('Relaunched; checking URLs and sessionStorage drafts.');
 const tabs=await until(async()=>{const rows=await inventory();return urls.every(u=>rows.some(t=>t.url===u))&&rows;},'Restart discarded a fixture URL');
 for(const [index,url] of urls.entries()){
  const c=await cdp(tabs.find(t=>t.url===url).webSocketDebuggerUrl);
  const value=await until(async()=>{const r=await c.send('Runtime.evaluate',{expression:'document.querySelector("#draft")?.value',returnByValue:true});return r.result?.value;},'Restored draft was not populated');c.close();
  assert.equal(value,`Draft ${index} — café ✓`);results.push({url,draftVerified:true});
 }
 const current=await(await fetch(base+'/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expression:'location.href'})})).json();
 assert.equal(typeof current.result,'string',JSON.stringify(current));
 assert.equal(new URL(current.result).pathname,'/welcome','Startup must select the console, not a restored user page');
 // Replay the reused tray's navigate-to-console then show sequence.
 await fetch(base+'/navigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:`http://127.0.0.1:${fixturePort}/welcome`})});
 await fetch(base+'/show',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const after=await inventory();assert.ok(urls.every(u=>after.some(t=>t.url===u)),'Tray relaunch replaced a restored user page');
 assert.equal(after.filter(t=>new URL(t.url).pathname==='/welcome').length,1,'Restart must reuse the console, not accumulate duplicates');
 passed=true;console.log(JSON.stringify({passed,state,runtimeRoot,generation,results,consoleTabs:after.filter(t=>new URL(t.url).pathname==='/welcome').length}));
}finally{
 await closeChrome().catch(()=>{});child?.kill();fixture.close();writeFileSync(join(state,'bridge.log'),logs);writeFileSync(join(state,'receipt.json'),JSON.stringify({passed,runtimeRoot,generation,results},null,2));console.log('Retained restart evidence: '+state);
}
