// Browser fixture must be held on 13006. Native image consent is tested in UI.
import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import WebSocket from 'ws';
const base='http://127.0.0.1:13006';
const {nonce}=await(await fetch(base+'/api/identity')).json();
const output=mkdtempSync(join(tmpdir(),'empir3-control-panel-'));
async function command(body){const r=await(await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)})).json();if(r.ok===false||r.result?.success===false)throw Error(r.error||r.result.error);return r.result;}
// Inspect the disposable fixture directly: Bridge evaluate owns the control
// lock and can itself block the report's asynchronous image request.
let inspector,sequence=0;const pending=new Map();
async function evaluate(script){
 if(!inspector){
  const pages=await(await fetch('http://127.0.0.1:19222/json/list')).json();
  const page=pages.find(p=>p.type==='page'&&p.url.startsWith(base+'/welcome'));
  assert.ok(page,'Disposable console must be open');
  inspector=new WebSocket(page.webSocketDebuggerUrl);
  inspector.on('message',data=>{const r=JSON.parse(data);if(pending.has(r.id)){pending.get(r.id)(r);pending.delete(r.id);}});
  await new Promise((resolve,reject)=>{inspector.once('open',resolve);inspector.once('error',reject);});
 }
 const id=++sequence,r=await new Promise(resolve=>{pending.set(id,resolve);inspector.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:script,returnByValue:true,awaitPromise:true}}));});
 assert.ok(!r.error&&!r.result?.exceptionDetails,JSON.stringify(r));return r.result.result.value;
}
async function until(script){for(let i=0;i<40;i++){if(await evaluate(script))return;await new Promise(r=>setTimeout(r,100));}throw Error('Panel did not settle');}
try{
 await command({type:'emulate_device',preset:'iphone14'});
 await command({type:'navigate',url:base+'/welcome'});
 await until(`!!document.querySelector('#bridge-control-report')`);
 await evaluate(`document.querySelector('#bridge-control-report').click();true`);
 await until(`!document.querySelector('#bridge-report-download').disabled`);
 const layout=await evaluate(`(()=>{const d=document.querySelector('#bridge-report').getBoundingClientRect(),p=document.querySelector('#bridge-control-panel').getBoundingClientRect();return {width:innerWidth,dialog:{x:d.x,right:d.right},panel:{x:p.x,right:p.right},image:document.querySelector('#bridge-report-image').checked}})()`);
 assert.ok(layout.width<=430);assert.ok(layout.dialog.x>=0&&layout.dialog.right<=layout.width);assert.ok(layout.panel.x>=0&&layout.panel.right<=layout.width);assert.equal(layout.image,false);
 await evaluate(`document.querySelector('#bridge-report-image').click();true`);
 await until(`!document.querySelector('#bridge-report-download').disabled || document.querySelector('#bridge-report-status').textContent.includes('Turn off the image checkbox')`);
 const imageAvailable=await evaluate(`!document.querySelector('#bridge-report-picture').hidden`);
 if(imageAvailable)assert.equal(await evaluate(`document.querySelector('#bridge-report-download').disabled`),false);
 await evaluate(`document.querySelector('#bridge-report-image').click();true`);
 await until(`!document.querySelector('#bridge-report-download').disabled`);
 assert.equal(await evaluate(`document.querySelector('#bridge-report-picture').hidden`),true);
 const shot=await fetch(base+'/api/screenshot?maxWidth=800',{headers:{'X-Empir3-Nonce':nonce}});assert.ok(shot.ok);writeFileSync(join(output,'mobile-report.jpg'),Buffer.from(await shot.arrayBuffer()));
 await evaluate(`document.querySelector('#bridge-report-close').click();true`);
 const receipt={passed:true,output,viewport:layout.width,noHorizontalOverflow:true,imageAvailable,imageConsentRecovery:true};
 writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{inspector?.close();await command({type:'emulate_device',preset:'off'});}
