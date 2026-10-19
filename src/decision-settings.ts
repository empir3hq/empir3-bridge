import {createHttpDecider, parseAnswer, resolveDecisionConfig, type DecisionConfig} from './browser-act.js';

interface Dependencies {
  env: Record<string,string|undefined>;
  readSettings: () => any;
  enabled: () => boolean;
  account: () => {paired:boolean; key:string};
  saveModel: (model:any|null) => void;
  saveEngine: (engine:any) => void;
  relay: (body:any) => Promise<any>;
  fetchImpl?: typeof fetch;
}
const clean = (value:any,max=160) => String(value??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);
function publicUrl(value:any) {
  try {const u=new URL(value);u.username='';u.password='';u.search='';u.hash='';return u.href.replace(/\/+$/,'');} catch {return clean(value);}
}
function engineName(model:string) {
  if (/nimble/i.test(model)) {
    const size=model.match(/nimble[- ](\d+b)\b/i)?.[1];
    return size ? `Nimble ${size.toUpperCase()}` : 'Nimble';
  }
  const jev=model.match(/jev[- ]([\d.]+)/i);return jev ? `Jev ${jev[1]}` : model;
}

/** The daemon owns the displayed source and all CLI/MCP decision transport. */
export class DecisionSettings {
  private readonly fetchImpl: typeof fetch;
  constructor(private deps:Dependencies) {
    // Stable transport identity preserves once-per-endpoint health discovery.
    this.fetchImpl=async (url,init) => {
      this.requireEnabled();
      return (this.deps.fetchImpl||fetch)(url,init);
    };
  }
  private requireEnabled() {
    if (!this.deps.enabled()) throw Object.assign(new Error('MCP tool disabled locally: browser_act'),{code:'TOOL_DISABLED'});
  }
  config():DecisionConfig|null {return resolveDecisionConfig(this.deps.env,this.deps.readSettings(),this.deps.account().paired);}
  state() {
    const settings=this.deps.readSettings(), account=this.deps.account(),config=this.config();
    const localConfig=resolveDecisionConfig(this.deps.env,{...settings,decisionModel:{...settings.decisionModel,enabled:true}},false);
    const envUrl=String(this.deps.env.EMPIR3_DECISION_URL||'').trim();
    const explicit=!!(envUrl||String(settings.decisionModel?.url||'').trim());
    const last=settings.lastDecisionEngine?.accountKey===account.key ? settings.lastDecisionEngine : null;
    const engine=last ? {model:clean(last.model),provider:clean(last.provider),name:engineName(clean(last.model)),backupUsed:last.backupUsed===true,reportedAt:last.reportedAt} : null;
    return {
      enabled:this.deps.enabled(),source:config?.source||'unavailable',
      sourceLabel:config?.source==='empir3' ? "Empir3 (your plan's engine)" : config ? `${config.source==='env' ? 'Local engine (from environment)' : clean(settings.decisionModel?.name)||engineName(config.model)}, ${publicUrl(config.url)}` : 'Not available',
      config:config ? {...config,url:publicUrl(config.url),apiKey:undefined} : null,
      empir3:{available:account.paired,engine,billing:'billed to your Empir3 account'},
      local:{configured:explicit,enabled:settings.decisionModel?.enabled!==false,source:envUrl?'env':'settings',
        name:envUrl ? engineName(localConfig?.model||'Local engine') : clean(settings.decisionModel?.name)||engineName(localConfig?.model||'Local engine'),url:publicUrl(localConfig?.url||envUrl||settings.decisionModel?.url||''),
        model:localConfig?.model||clean(settings.decisionModel?.model),keySet:!!localConfig?.apiKey,editable:!envUrl,
        valid:!!localConfig},
    };
  }
  toggleLocal(enabled:boolean) {this.deps.saveModel({...this.deps.readSettings().decisionModel,enabled});return this.state();}
  removeLocal() {this.deps.saveModel(null);return this.state();}
  async testAndSave(body:any) {
    this.requireEnabled();
    if (String(this.deps.env.EMPIR3_DECISION_URL||'').trim()) throw new Error('This local engine comes from the Bridge environment. Change that environment to edit it, or uncheck the local engine to use Empir3.');
    let url:URL;try {url=new URL(String(body?.url||'').trim());}catch {throw new Error('Enter an HTTP or HTTPS engine address.');}
    if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('Use an HTTP or HTTPS address without credentials, query or fragment. Enter a key separately.');
    const base=url.href.replace(/\/+$/,''),previous=this.deps.readSettings().decisionModel||{};
    const apiKey=String(body?.apiKey||'').trim() || (previous.url===base ? String(previous.apiKey||'') : '');
    if (apiKey.length>8192) throw new Error('The API key is too long.');
    // Editing the visible fields must preserve operator-set input limits,
    // confidence floors and timeouts from the existing engine settings.
    const model={...previous,name:clean(body?.name,80),url:base,model:clean(body?.model,160)||'nimble-latest',apiKey:apiKey||undefined,enabled:true};
    const config=resolveDecisionConfig({}, {decisionModel:model})!;
    try {
      const reply=await createHttpDecider(config,this.fetchImpl)({model:config.model,state:'Connection test. The correct answer is READY.',questions:{test:{type:'choice',instructions:'Choose the option named READY.',criteria:{ready:'READY',none:'No matching option'}}}});
      const answer=parseAnswer(reply,'test');
      if (!answer || answer.choice!=='ready' || answer.confidence<config.minConfidence) throw new Error('The engine answered, but did not pass the READY test. Check the model and address.');
      this.requireEnabled();this.deps.saveModel(model);
      return {ok:true,testPassed:true,model:config.model,decisions:this.state()};
    } catch(error:any) {
      const message=String(error?.message||'The test failed.');
      throw new Error(clean(apiKey ? message.split(apiKey).join('[redacted]') : message,400));
    }
  }
  async dispatch(body:any) {
    let decisionCalls=0;
    try {
      this.requireEnabled();const config=this.config();
      if (!config) return {success:false,code:'NO_ENGINE',error:'No decision engine is available. Check Decisions in API & CLIs.',decisionCalls};
      if (config.source==='empir3') {
        const accountKey=this.deps.account().key;
        decisionCalls++;
        const result=await this.deps.relay({state:body.state,questions:body.questions});
        if (result?.success && result.engine?.model) this.deps.saveEngine({accountKey,model:clean(result.engine.model),provider:clean(result.engine.provider),backupUsed:result.backupUsed===true,reportedAt:new Date().toISOString()});
        return {...result,decisionCalls};
      }
      const result=await createHttpDecider(config,this.fetchImpl)({state:body.state,questions:body.questions,model:config.model},()=>decisionCalls++);
      return {...result,success:true,decisionCalls};
    } catch(error:any) {return {success:false,code:error?.code||'ENGINE_UNAVAILABLE',error:clean(error?.message||'The decision engine could not answer.',400),decisionCalls};}
  }
}
