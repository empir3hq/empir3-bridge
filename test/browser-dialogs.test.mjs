import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserDialogs} from '../src/browser-dialogs.js';
function fixture(){
 const listeners=new Set(),sent=[];let connections=0;
 const event=(method,params)=>{for(const f of listeners)f({method,params});};
 const dialogs=createBrowserDialogs(async()=>{connections++;return {targetId:'tab',onEvent:f=>listeners.add(f),close:()=>{},send:async(method,params)=>{sent.push({method,params});if(method==='Page.handleJavaScriptDialog')event('Page.javascriptDialogClosed',{result:params.accept});}}});
 return {dialogs,event,sent,connections:()=>connections};
}
test('pending dialog returns immediately while its triggering operation is suspended',async()=>{
 const f=fixture();let finish,calls=0;
 const result=await f.dialogs.run('tab',()=>{calls++;const p=new Promise(r=>finish=r);f.event('Page.javascriptDialogOpening',{type:'confirm',message:'Continue?',url:'https://example.test'});return p;});
 assert.equal(result.needsDialogResponse,true);assert.equal(result.verified,false);assert.equal(calls,1);
 const status=await f.dialogs.handle('tab');assert.equal(status.dialog.id,result.dialog.id);
 await assert.rejects(f.dialogs.run('tab',()=>calls++),/browser_dialog_pending/);assert.equal(calls,1);
 await assert.rejects(f.dialogs.handle('tab','accept','stale'),/stale_dialog/);
 await assert.rejects(f.dialogs.handle('tab','accept',status.dialog.id,'text'),/only valid/);
 assert.equal(f.sent.filter(x=>x.method==='Page.handleJavaScriptDialog').length,0);
 const done=await f.dialogs.handle('tab','dismiss',status.dialog.id);assert.equal(done.verified,true);assert.equal((await f.dialogs.handle('tab')).dialog,null);finish({success:true});
});
test('fresh ids protect replacement dialogs and prompt text remains literal',async()=>{
 const f=fixture();await f.dialogs.ensure('tab');
 f.event('Page.javascriptDialogOpening',{type:'prompt',message:'Text'});const old=f.dialogs.pending('tab');
 f.event('Page.javascriptDialogClosed',{result:false});f.event('Page.javascriptDialogOpening',{type:'prompt',message:'Text'});const fresh=f.dialogs.pending('tab');
 assert.notEqual(fresh.id,old.id);await assert.rejects(f.dialogs.handle('tab','accept',old.id),/stale_dialog/);
 assert.equal((await f.dialogs.handle('tab','accept',fresh.id,'café 日本語 $literal')).verified,true);
 assert.equal(f.sent.at(-1).params.promptText,'café 日本語 $literal');
 f.event('Bridge.sessionClosed');await f.dialogs.ensure('tab');assert.equal(f.connections(),2);
});
