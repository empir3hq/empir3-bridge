import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

// Use an isolated profile and local form server; --wyoming adds a read-only
// public-site replay attempt and never bypasses its human-verification gate.
const root=fileURLToPath(new URL('..',import.meta.url));
const state=await mkdtemp(join(tmpdir(),'empir3-form-click-'));
const submissions=[];
const fixture=createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/result'){submissions.push(url.searchParams.get('name'));res.end('<h1>Search results: '+url.searchParams.get('name')+'</h1>');return;}
 const mode=url.searchParams.get('mode')||'plain';
 const capture=mode==='capture'?'document.addEventListener("pointerdown",e=>e.stopPropagation(),true);document.addEventListener("mousedown",e=>e.stopPropagation(),true);document.addEventListener("click",e=>e.stopPropagation(),true);':mode==='unobservable'?'["pointerdown","mousedown","click"].forEach(t=>window.addEventListener(t,e=>e.stopImmediatePropagation(),true));':'';
 res.setHeader('Content-Type','text/html');
 res.end(`<!doctype html><title>Form click fixture</title><style>body{padding:40px}input{padding:20px;margin:20px}</style><form action="/result"><label>Filing name<input id="searchValue" name="name"></label><input id="search" type="submit" value="Search"></form><script>${capture}</script>`);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),cdp=await freePort();
const log=[];
const child=spawn(process.execPath,['--import','tsx','src/bridge.ts'],{cwd:root,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,BRIDGE_TOKEN:'',BRIDGE_PORT:String(port),CDP_PORT:String(cdp),PW_PORT:String(port),BRIDGE_PROFILE:join(state,'profile'),BRIDGE_HEADLESS:'true',EMPIR3_CHROME_AUTOLAUNCH:'0'}});
child.stdout.on('data',x=>log.push(String(x)));child.stderr.on('data',x=>log.push(String(x)));
const results=[];
async function call(path,body){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(70000)});return {status:r.status,data:await r.json()};}
try{
 for(let i=0;i<100;i++){try{if((await call('/health')).status===200)break;}catch{}await delay(100);}
 for(const mode of ['plain','capture']){
  const nav=await call('/navigate',{url:`http://127.0.0.1:${fixture.address().port}/?mode=${mode}`});assert.equal(nav.status,200);
  const typed=await call('/action',{kind:'type',selector:'#searchValue',text:mode});
  const clicked=await call('/action',{kind:'click',selector:'#search'});
  const text=await call('/text');
  const result={mode,typed,clicked,text,submissions:[...submissions]};results.push(result);console.log(JSON.stringify(result));
  assert.equal(typed.status,200,mode+' typing');
  assert.equal(clicked.status,200,mode+' click');
  assert.equal(clicked.data.verified,true);
  assert.ok(clicked.data.receivedEvents.includes('click'));
  assert.equal(submissions.filter(x=>x===mode).length,1,'exactly one form submission');
  assert.equal(text.data.text,'Search results: '+mode);
 }
 await call('/navigate',{url:`http://127.0.0.1:${fixture.address().port}/?mode=unobservable`});
 const unconfirmed=await call('/action',{kind:'click',selector:'#search'});
 assert.equal(unconfirmed.status,409);
 assert.equal(unconfirmed.data.code,'click_not_confirmed');
 assert.equal(unconfirmed.data.inputMayHaveOccurred,true);
 assert.equal(submissions.length,3,'an unconfirmed input is never automatically retried');
 results.push({mode:'unobservable',unconfirmed});
 await call('/navigate',{url:`http://127.0.0.1:${fixture.address().port}/`});
 const missing=await call('/action',{kind:'click',selector:'#missing'});
 assert.equal(missing.status,404);assert.equal(missing.data.code,'element_not_found');
 assert.equal(missing.data.inputMayHaveOccurred,false);assert.equal(submissions.length,3);
 const snapshot=await call('/snapshot');assert.ok(snapshot.data.nodes.some(n=>n.role==='textbox'));
 const screenshot=await call('/screenshot?format=json');assert.ok(screenshot.data.data.length>1000);
 results.push({mode:'refusal-and-reads',missing,snapshotCount:snapshot.data.count,screenshotBytes:Buffer.from(screenshot.data.data,'base64').length});
 if(process.argv.includes('--wyoming')){
  const nav=await call('/navigate',{url:'https://wyobiz.wyo.gov/Business/FilingSearch.aspx'});
  let before;
  for(let i=0;i<30;i++){before=await call('/text');if(before.data.readyState==='complete'&&before.data.text)break;await delay(500);}
  let result={mode:'wyoming',nav,before};
  if(before.data.text?.includes('Filing Name')){
   result.typed=await call('/action',{kind:'type',selector:'#searchValue',text:'TEST'});
   result.clicked=await call('/action',{kind:'click',selector:'#search'});
   result.after=await call('/text');
  }
  results.push(result);console.log(JSON.stringify(result));
 }
}finally{
 if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 else {try{process.kill(-child.pid,'SIGTERM');}catch{}}
 await new Promise(r=>fixture.close(r));
 await writeFile(join(state,'receipt.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
 await writeFile(join(state,'bridge.log'),log.join(''));
 console.log(JSON.stringify({evidence:state}));
}
