'use strict';
const {WebSocket}=require('ws');
const {randomUUID}=require('node:crypto');
function recorderScript(binding) {
  // Runs in an isolated CDP world. Page scripts receive no Bridge nonce,
  // network endpoint, command listener, or privileged transport.
  return `(()=>{if(window.top!==window)return;const key=${JSON.stringify(binding)};if(globalThis.__empir3Recorder)return;
    const listeners=[],timers=new Map();let count=0;
    const send=a=>{if(count++<2000)globalThis[key](JSON.stringify({...a,at:Date.now()}))};
    const selector=e=>{if(e.id&&document.querySelectorAll('#'+CSS.escape(e.id)).length===1)return '#'+CSS.escape(e.id);const parts=[];while(e&&e.nodeType===1){let i=1,s=e;while((s=s.previousElementSibling))if(s.tagName===e.tagName)i++;parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+i+')');e=e.parentElement}return parts.join(' > ')};
    const listen=(name,fn)=>{document.addEventListener(name,fn,true);listeners.push([name,fn])};
    const flush=()=>{for(const [e,p] of timers){clearTimeout(p.timer);p.send()}timers.clear()};
    listen('click',event=>{if(!event.isTrusted)return;flush();const e=event.target.closest('button,a,input,select,textarea,[role],summary')||event.target;if(['INPUT','TEXTAREA','SELECT'].includes(e.tagName))return;send({action:'click',locator:{selector:selector(e)}})});
    listen('input',event=>{if(!event.isTrusted)return;const e=event.target;if(!['INPUT','TEXTAREA'].includes(e.tagName)||['checkbox','radio'].includes(e.type))return;const loc={selector:selector(e)};const action=e.type==='password'?{action:'fill',locator:loc,value:'{{PASSWORD}}',sensitive:true}:{action:'fill',locator:loc,value:e.value,expect:{kind:'value',locator:loc,equals:e.value}};send(action)});
    listen('change',event=>{if(!event.isTrusted)return;const e=event.target,loc={selector:selector(e)};if(e.tagName==='SELECT')send({action:'select',locator:loc,value:e.value,expect:{kind:'value',locator:loc,equals:e.value}});else if(e.type==='checkbox'||e.type==='radio')send({action:'check',locator:loc,value:e.checked,expect:{kind:'checked',locator:loc,equals:e.checked}})});
    listen('keydown',event=>{if(!event.isTrusted||!['Enter','Tab','Escape'].includes(event.key))return;flush();send({action:'press',key:event.key})});
    let scrollTimer;listen('scroll',event=>{if(!event.isTrusted)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>send({action:'scroll',x:scrollX,y:scrollY,absolute:true}),200)});
    globalThis.__empir3Recorder={stop(){flush();clearTimeout(scrollTimer);for(const [n,f]of listeners)document.removeEventListener(n,f,true);delete globalThis.__empir3Recorder}};
    send({action:'navigate',url:location.href});return {ready:true};
  })()`;
}
class BrowserRecorder {
  constructor(){this.ws=null;this.actions=[];this.pending=new Map();this.contexts=new Set();this.next=1;this.scriptId=null;this.error=null;}
  async send(method,params={}) {
    if(this.ws?.readyState!==WebSocket.OPEN)throw new Error('Recorder disconnected.');
    const id=this.next++;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Recorder command timeout'));},5000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});
  }
  async start(wsUrl,targetId) {
    if(this.ws)throw new Error('A recording is already active.');
    this.actions=[];this.error=null;this.contexts.clear();this.targetId=targetId;this.binding='empir3_record_'+randomUUID().replaceAll('-','');this.world=this.binding;
    this.ws=new WebSocket(wsUrl);const connection=this.ws;
    this.ws.on('message',data=>{try{const m=JSON.parse(data.toString());if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}return}
      if(m.method==='Runtime.executionContextCreated'&&m.params.context.name===this.world)this.contexts.add(m.params.context.id);
      if(m.method==='Runtime.bindingCalled'&&m.params.name===this.binding&&this.contexts.has(m.params.executionContextId)){
        if(m.params.payload.length>200000||this.actions.length>=2000){this.error='Recording limit reached; stop and save.';return}
        const a=JSON.parse(m.params.payload);if(['click','fill','select','check','press','scroll','navigate'].includes(a.action)){
          const last=this.actions.at(-1);
          // Coalesce in the daemon, after receipt: navigation cannot discard
          // the last field value held in a page-side debounce timer.
          if(a.action==='fill'&&last?.action==='fill'&&last.locator?.selector===a.locator?.selector&&a.at-last.at<500)this.actions[this.actions.length-1]=a;
          else this.actions.push(a);
        }
      }
    }catch{this.error='An invalid recording event was ignored.'}});
    this.ws.on('close',()=>{if(this.ws!==connection)return;this.error=this.error||'Recording tab disconnected.';for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(this.error))}this.pending.clear()});
    this.ws.on('error',e=>{if(this.ws===connection)this.error=e.message});
    try {
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recorder connection timeout')),5000);this.ws.once('open',()=>{clearTimeout(timer);resolve()});this.ws.once('error',e=>{clearTimeout(timer);reject(e)})});
      await this.send('Page.enable');await this.send('Runtime.enable');
      const frame=(await this.send('Page.getFrameTree')).frameTree.frame.id;
      await this.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world});
      const source=recorderScript(this.binding);
      this.scriptId=(await this.send('Page.addScriptToEvaluateOnNewDocument',{source,worldName:this.world})).identifier;
      const context=(await this.send('Page.createIsolatedWorld',{frameId:frame,worldName:this.world})).executionContextId;
      this.contexts.add(context);
      const init=await this.send('Runtime.evaluate',{expression:source,contextId:context,returnByValue:true});
      if(init.exceptionDetails||!init.result?.value?.ready)throw new Error('Recorder could not attach to this page.');
      return {recording:true,targetId,mode:'isolated-world',limitations:['Main page DOM only; cross-origin frames and closed shadow roots require separate recording.','Password fields use a PASSWORD variable. Review saved actions before replay.']};
    }catch(e){await this.stop().catch(()=>{});throw e;}
  }
  async stop() {
    if(!this.ws)return {actions:[],error:'No recording is active.'};
    try{
      if(this.scriptId)await this.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:this.scriptId});
      for(const contextId of this.contexts)await this.send('Runtime.evaluate',{contextId,expression:'globalThis.__empir3Recorder?.stop()'}).catch(()=>{});
      await this.send('Runtime.removeBinding',{name:this.binding}).catch(()=>{});
    } finally {this.ws.close();this.ws=null;this.scriptId=null;}
    return {actions:this.actions,targetId:this.targetId,error:this.error};
  }
}
module.exports={BrowserRecorder,recorderScript};
