// Attended advanced browser/native recovery against a disposable acceptance runtime.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
const state=process.argv.find(a=>a.startsWith('--state='))?.slice(8);
assert.ok(state?.includes('empir3-browser-acceptance-'),'Choose a disposable browser acceptance state');
const base='http://127.0.0.1:13006',{nonce}=await(await fetch(base+'/api/identity')).json();
const configPath=join(state,'.empir3-bridge','config.json'),original=readFileSync(configPath,'utf8');
const receipts=[];
async function command(body){
 const start=performance.now();const e=await(await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})).json();const r=e.result??e;
 receipts.push({type:body.type,ms:Math.round(performance.now()-start),success:e.ok!==false&&r.success!==false});
 if(e.ok===false||r.success===false)throw Error(r.error||e.error||JSON.stringify(r));return r;
}
let target,downloadSocket;
async function evaluate(script){const r=await command({type:'evaluate',script,target});if(typeof r.result==='string'){try{return JSON.parse(r.result);}catch{return r.result;}}return r.result;}
async function waitValue(script,expected){for(let i=0;i<30;i++){const r=await evaluate(script);if(r===expected)return;await delay(100);}throw Error('Expected observed value: '+expected);}
try{
 const cfg=JSON.parse(original);Object.assign(cfg.enabledTools,{browser_click:true,browser_press:true,browser_tab_close:true});writeFileSync(configPath,JSON.stringify(cfg));
 target=(await command({type:'tab_open',url:base+'/desktop-test?extended=1'})).target;
 await evaluate(`document.title='Empir3 extended browser acceptance';document.body.innerHTML='<main style="padding:40px;font:20px sans-serif"><h1>Extended acceptance</h1><input id="upload" type="file"><p id="fileResult"></p><button id="counter">Count</button><p id="count">0</p><a id="download">Download fixture</a><iframe id="frame" title="Fixture frame" style="display:block;width:500px;height:180px"></iframe></main>';document.querySelector('#counter').onclick=e=>{if(e.isTrusted)document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)};document.querySelector('#upload').onchange=async e=>document.querySelector('#fileResult').textContent=await e.target.files[0].text();true`);
 await evaluate(`document.querySelector('#frame').srcdoc=${JSON.stringify('<button style="width:200px;height:80px" onclick="if(event.isTrusted)parent.document.getElementById(\'count\').textContent=\'frame trusted\'">Frame target</button>')};true`);
 await command({type:'desktop:window',action:'focus',params:{title:'Empir3 extended browser acceptance'}});
 // Longer sequential input checks retain exact target and observed state.
 for(let i=1;i<=25;i++){await command({type:'click',selector:'#counter',target});await waitValue('Number(document.querySelector("#count").textContent)',i);}
 const frame=await evaluate(`(()=>{const f=document.querySelector('#frame'),b=f.contentDocument.querySelector('button');if(!b)throw Error('Frame not ready');const r=f.getBoundingClientRect(),c=b.getBoundingClientRect();return {x:r.x+f.clientLeft+c.x+c.width/2,y:r.y+f.clientTop+c.y+c.height/2};})()`);
 await command({type:'click_xy',...frame,target});await waitValue('document.querySelector("#count").textContent','frame trusted');
 // Inspect the native dialog before using its exact foreground window.
 await evaluate('setTimeout(()=>{window.confirmResult=confirm("Empir3 disposable dialog test")},150);true');await delay(250);
 let dialog;
 for(let i=0;i<20;i++){dialog=await command({type:'desktop_snapshot',scope:'foreground',maxElements:80});if(dialog.elements.some(e=>e.name==='OK')&&dialog.elements.some(e=>e.name==='Cancel'))break;await delay(100);}
 writeFileSync(join(state,'extended-dialog.json'),JSON.stringify(dialog,null,2));
 assert.match(dialog.windows[0].title,/Empir3 extended browser acceptance/);
 assert.ok(dialog.elements.some(e=>e.name==='OK')&&dialog.elements.some(e=>e.name==='Cancel'));
 const dialogTarget={surface:'desktop',windowHandle:dialog.windows[0].handle};
 await command({type:'desktop_key',keys:['ESC'],target:dialogTarget});await waitValue('window.confirmResult',false);
 const upload=join(state,'upload-fixture.txt');writeFileSync(upload,'Empir3 real local file ✓');
 // The native chooser is a supported recovery path; retain any click timeout.
 let chooserClickError=null;try{await command({type:'click',selector:'#upload',target});}catch(error){chooserClickError=error.message;}
 let chooser;
 for(let i=0;i<15;i++){chooser=await command({type:'desktop_snapshot',scope:'foreground',maxElements:100});if(chooser.windows?.some(w=>w.title==='Open'))break;await delay(100);}
 writeFileSync(join(state,'extended-chooser.json'),JSON.stringify(chooser,null,2));
 assert.ok(chooser.windows?.some(w=>w.title==='Open'),'Native chooser absent; click result: '+chooserClickError);
 const chooserTarget={surface:'desktop',windowHandle:chooser.windows[0].handle};
  await command({type:'desktop_key',keys:['ALT','N'],target:chooserTarget});
 // Shell autocomplete can replace its edit HWND during raw path typing.
 // Observe the current filename field and fill it with a verified ValuePattern
 // action, so recovery never blindly appends to a partially typed path.
 const filenameObservation=await command({type:'control_observe',target:chooserTarget,maxElements:300});
 const filename=filenameObservation.observation.elements.find(e=>e.role==='Edit'&&e.automationId==='1148');
 assert.ok(filename,'Observed filename edit is required before entering a path');
 await command({type:'control_run',target:chooserTarget,steps:[{action:'fill',locator:{role:'Edit',automationId:filename.automationId},value:upload,expect:{kind:'value',locator:{role:'Edit',automationId:filename.automationId},equals:upload}}]});
 await command({type:'desktop_key',keys:['ENTER'],target:chooserTarget});
 await waitValue('document.querySelector("#fileResult").textContent','Empir3 real local file ✓');
 // Only the fixture browser's download destination is configured out-of-band.
 const downloads=join(state,'downloads');mkdirSync(downloads,{recursive:true});
 const version=await(await fetch('http://127.0.0.1:19222/json/version')).json();
 const ws=downloadSocket=new WebSocket(version.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Download setup timeout')),5000);ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.setDownloadBehavior',params:{behavior:'allow',downloadPath:downloads}})));ws.on('message',b=>{const r=JSON.parse(b);if(r.id===1){clearTimeout(timer);r.error?reject(Error(r.error.message)):resolve();}});ws.on('error',reject);});
 const downloadName=basename(state)+'-download.txt';
 await evaluate(`const a=document.querySelector('#download');a.href=URL.createObjectURL(new Blob(['Empir3 download verified'],{type:'text/plain'}));a.download=${JSON.stringify(downloadName)};true`);
 await command({type:'click',selector:'#download',target});
 const downloaded=join(downloads,downloadName);for(let i=0;i<100&&!existsSync(downloaded);i++)await delay(100);
 assert.equal(readFileSync(downloaded,'utf8'),'Empir3 download verified');
 await command({type:'tab_close',target});target=null;
 const receipt={passed:true,sequentialTrustedClicks:25,frameTrustedClick:true,nativeDialogDismissed:true,realLocalFileUploaded:true,downloadBytesVerified:true,chooserClickError,receipts};
 writeFileSync(join(state,'extended-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{downloadSocket?.close();writeFileSync(configPath,original);}
