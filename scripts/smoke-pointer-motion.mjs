// Exercise real pointer travel repeatedly inside the disposable Accuracy Lab.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const state=process.argv.find(a=>a.startsWith('--state='))?.slice(8);
if(!state?.includes('empir3-browser-acceptance-'))throw Error('Pass the disposable browser acceptance --state path.');
const base='http://127.0.0.1:13006';
const {nonce}=await(await fetch(base+'/api/identity')).json();
const timings=[];
async function command(body){const start=performance.now();const e=await(await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)})).json();assert.notEqual(e.ok,false,JSON.stringify(e));assert.notEqual(e.result?.success,false,JSON.stringify(e));timings.push(Math.round(performance.now()-start));return e.result;}
const snap=await command({type:'desktop_snapshot'});
const window=snap.windows[0];assert.match(window.title,/Bridge Accuracy Lab/);assert.equal(window.processName,'chrome');
const target={surface:'desktop',windowHandle:window.handle},b=window.bounds;
const points=[{x:Math.round(b.x+b.width*.32),y:Math.round(b.y+b.height*.61)},{x:Math.round(b.x+b.width*.52),y:Math.round(b.y+b.height*.50)}];
try{
 for(let i=0;i<120;i++)await command({type:'desktop_hover',target,...points[i%2]});
 const warm=timings.slice(2).sort((a,b)=>a-b);
 const receipt={passed:true,moves:120,medianMs:warm[Math.floor(warm.length*.5)],p95Ms:warm[Math.floor(warm.length*.95)],maxMs:Math.max(...warm),timings};
 writeFileSync(join(state,'motion-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}catch(error){writeFileSync(join(state,'motion-refusal.json'),JSON.stringify({completed:timings.length-1,error:error.message},null,2));throw error;}
