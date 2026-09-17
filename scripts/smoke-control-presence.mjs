// Isolated attended candidate only. Never targets the installed Bridge port.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const state=process.argv.find(a=>a.startsWith('--state='))?.slice(8);
if(!state?.includes('empir3-browser-acceptance-'))throw Error('Pass the disposable browser acceptance --state path.');
const base='http://127.0.0.1:13006';
const {nonce}=await(await fetch(base+'/api/identity')).json();
async function command(body){const e=await(await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)})).json();assert.notEqual(e.ok,false,JSON.stringify(e));return e.result;}
const region={x:160,y:160,width:720,height:560};
await command({type:'desktop_screenshot',region});
let presence=(await command({type:'control_status'})).presence;
assert.equal(presence.visible,true);assert.equal(presence.regions.length,1);for(const key of Object.keys(region))assert.equal(presence.regions[0][key],region[key]);
await new Promise(r=>setTimeout(r,500));
const screenshot=await command({type:'desktop_screenshot',region});
await fetch(base+'/api/control/pause',{method:'POST',headers:{'X-Empir3-Nonce':nonce}});
assert.equal((await command({type:'control_status'})).presence.visible,false);
await fetch(base+'/api/control/resume',{method:'POST',headers:{'X-Empir3-Nonce':nonce}});
await command({type:'desktop_screenshot',region});
await new Promise(r=>setTimeout(r,6200));
assert.equal((await command({type:'control_status'})).presence.visible,false);
const receipt={passed:true,exactRegion:true,pauseHidesImmediately:true,snapshotExpires:true,screenshot:screenshot.captures[0].path};
writeFileSync(join(state,'presence-receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
