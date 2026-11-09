import { randomUUID } from 'node:crypto';

type Session = {targetId:string;send(method:string,params?:any):Promise<any>;onEvent(fn:(e:any)=>void):()=>void;close():void};
type Observer = {session:Session;prompt:any;capabilities:Record<string,boolean>};

/** Browser-owned UI only. No DOM scripts, permission overrides, virtual
 * authenticators, credentials, or automatic account selection. */
export function createBrowserPrompts(openSession:(id:string)=>Promise<Session>) {
  const observers = new Map<string,Promise<Observer>>();
  const requests = new Map<string,any>();
  function pruneRequests() {
    for (const [id, request] of requests) if (request.expiresAt <= Date.now()) requests.delete(id);
  }
  async function ensure(targetId:string) {
    if (!targetId) throw new Error('Choose an exact browser target.');
    if (!observers.has(targetId)) {
      if (observers.size >= 32) throw new Error('Prompt observer limit reached. Close unused browser tabs.');
      const pending = (async () => {
        const session = await openSession(targetId);
        const state:Observer = {session,prompt:null,capabilities:{fedcm:false,deviceAccess:false}};
        session.onEvent(event => {
          const p=event.params || {};
          if (event.method==='FedCm.dialogShown') {
            state.prompt={id:randomUUID(),cdpId:p.dialogId,kind:'fedcm',type:p.dialogType,title:p.title,subtitle:p.subtitle || '',
              accounts:(p.accounts || []).map((a:any,index:number)=>({index,name:a.name,email:a.email,provider:a.idpConfigUrl,loginState:a.loginState})),
              actions:p.dialogType==='AccountChooser'?['select_account','dismiss']:['dismiss']};
          } else if (event.method==='FedCm.dialogClosed' && state.prompt?.cdpId===p.dialogId) state.prompt=null;
          else if(event.method==='DeviceAccess.deviceRequestPrompted') {
            state.prompt={id:randomUUID(),cdpId:p.id,kind:'device',title:'Choose a browser device',devices:p.devices,actions:['dismiss']};
          } else if (event.method==='Page.frameNavigated' && !p.frame?.parentId) state.prompt=null;
          else if (event.method==='Bridge.sessionClosed') {
            observers.delete(targetId);
            for(const [id,r] of requests) if(r.targetId===targetId) requests.delete(id);
          }
        });
        try { await session.send('Page.enable'); } catch(error) { session.close(); throw error; }
        try {await session.send('FedCm.enable');state.capabilities.fedcm=true;} catch {}
        try {await session.send('DeviceAccess.enable');state.capabilities.deviceAccess=true;} catch {}
        return state;
      })();
      observers.set(targetId,pending);
      pending.catch(()=>observers.delete(targetId));
    }
    return observers.get(targetId)!;
  }
  const publicPrompt=(prompt:any)=>{if(!prompt)return null;const {cdpId,...visible}=prompt;return visible;};
  async function status(targetId:string) {
    const state=await ensure(targetId);pruneRequests();
    return {success:true,target:{surface:'browser',tabId:targetId},prompts:state.prompt?[publicPrompt(state.prompt)]:[],capabilities:state.capabilities,
      coverage:'FedCM and device chooser events. Passkeys, HTTP authentication, permissions and download UI may require a native-window observation.',
      requests:[...requests.values()].filter(r=>r.targetId===targetId).map(({cdpId,...r})=>r)};
  }
  async function request(targetId:string,body:any) {
    const state=await ensure(targetId),prompt=state.prompt;pruneRequests();
    if(!prompt || body.promptId!==prompt.id)throw new Error('stale_prompt: observe the prompt again.');
    if(!prompt.actions.includes(body.choice))throw new Error('That prompt action is not supported.');
    if(body.choice==='select_account' && (!Number.isSafeInteger(body.accountIndex)||!prompt.accounts[body.accountIndex]))throw new Error('Choose an account index returned by this prompt.');
    const existing=[...requests.values()].find(r=>r.targetId===targetId&&r.promptId===prompt.id&&r.choice===body.choice&&r.accountIndex===body.accountIndex);
    if(existing)return {success:true,requestId:existing.id,approved:existing.approved,requiresOwnerApproval:!existing.approved};
    if(requests.size>=64)throw new Error('Too many pending prompt approvals.');
    const id=randomUUID();
    requests.set(id,{id,targetId,promptId:prompt.id,choice:body.choice,accountIndex:body.accountIndex,
      title:prompt.title,account:body.choice==='select_account'?prompt.accounts[body.accountIndex]:undefined,approved:false,expiresAt:Date.now()+120000});
    return {success:true,requestId:id,requiresOwnerApproval:true,approved:false};
  }
  async function approve(id:string) {
    pruneRequests();const request=requests.get(id);
    if(!request)throw new Error('Approval expired. Ask the agent to request the current prompt again.');
    const state=await ensure(request.targetId);
    if(state.prompt?.id!==request.promptId){requests.delete(id);throw new Error('stale_prompt: this prompt has changed.');}
    request.approved=true;return {success:true,requestId:id,approved:true};
  }
  async function respond(targetId:string,id:string) {
    pruneRequests();const request=requests.get(id);
    if(!request || request.targetId!==targetId || !request.approved)throw new Error('owner_approval_required: approve this exact action in the local Bridge panel first.');
    const state=await ensure(targetId),prompt=state.prompt;
    if(!prompt || prompt.id!==request.promptId){requests.delete(id);throw new Error('stale_prompt: observe the prompt again.');}
    requests.delete(id); // One use, even if Chrome loses the response.
    if(request.choice==='select_account')await state.session.send('FedCm.selectAccount',{dialogId:prompt.cdpId,accountIndex:request.accountIndex});
    else if(prompt.kind==='fedcm')await state.session.send('FedCm.dismissDialog',{dialogId:prompt.cdpId});
    else await state.session.send('DeviceAccess.cancelPrompt',{id:prompt.cdpId});
    if(state.prompt?.id===prompt.id)state.prompt=null;
    return {success:true,dispatched:true,verified:false,next:'Observe the page or browser prompts to verify the result.'};
  }
  return {ensure,status,request,approve,respond,pending:()=>{pruneRequests();return [...requests.values()];}};
}
