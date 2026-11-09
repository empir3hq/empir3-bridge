import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import vm from 'node:vm';
import ts from 'typescript';
import journalModule from '../src/cli-turn-journal.ts';
import lifecycleModule from '../src/cli-turn-lifecycle.ts';
const {CliTurnJournal,cliTurnHash}=journalModule,{CliTurnLifecycle}=lifecycleModule;
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
const names=['cliJournalEnrollment','reconcileCliExecution','handleEmpir3Message',...['Claude','Codex','Gemini','Grok','Agy'].map(p=>'handle'+p+'CliCommand')];
const declarations=names.map(name=>{const declaration=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(declaration);return declaration.getText(tree);});
const compiled=ts.transpileModule(declarations.join('\n')+'\nglobalThis.receive=handleEmpir3Message;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(t,provider='codex'){
  const dir=mkdtempSync(join(tmpdir(),'empir3-cli-reconcile-')),file=join(dir,'turns.sqlite');
  let store=new CliTurnJournal(file);const db=new DatabaseSync(file),replies=[];
  let account='original';const server='https://fixture.invalid',deviceId='original-device';
  const binding=cliTurnHash({server,deviceId,subject:account}),payload={id:'original-turn',messages:[],system:'PRIVATE PROMPT'};
  const lifecycle=new CliTurnLifecycle(()=>({store,binding})),scope=lifecycle.begin(provider,payload.id,payload);
  const sandbox={process:{platform:'linux'},cliTurnJournal:store,CliTurnJournal,cliTurnHash,join,SETTINGS_DIR:dir,EMPIR3_SERVER:server,EMPIR3_AUTH_TOKEN:'',
    empir3RestartRequired:false,readBridgeAuth:()=>({user:{id:account}}),readBridgeSettings:()=>({deviceId}),
    READ_ONLY_CLI_ACTIONS:new Set(['probe']),hasEmpir3Permission:()=>false,empir3PermissionDenied:()=>({error:'Execute revoked'}),
    sendEmpir3:(type,result)=>replies.push({type,result})};
  sandbox.abortClaudeCliTurn=p=>lifecycle.cancel('claude',p.id);
  sandbox.abortCodexCliTurn=p=>lifecycle.cancel('codex',p.id);
  sandbox.abortPlainCliTurn=(p,emit,spec)=>lifecycle.cancel(spec.wirePrefix,p.id);
  sandbox.abortPtyCliTurn=sandbox.abortPlainCliTurn;
  sandbox.GEMINI_PLAIN_CLI_SPEC={wirePrefix:'gemini'};sandbox.GROK_PLAIN_CLI_SPEC={wirePrefix:'grok'};sandbox.AGY_PTY_CLI_SPEC={wirePrefix:'agy'};
  vm.runInNewContext(compiled,sandbox);
  const request=(mode='inspect',change={},target=deviceId)=>{
    const id=randomUUID();sandbox.receive({type:provider+':cli:execution:'+mode,_targetDeviceId:target,
      payload:{id,executionId:payload.id,requestHash:cliTurnHash(payload),...change}});
    return replies.find(r=>r.result.id===id)?.result;
  };
  t.after(()=>{store.close();db.close();for(const name of readdirSync(dir))unlinkSync(join(dir,name));rmdirSync(dir);});
  return {request,replies,db,scope,lifecycle,sandbox,binding,payload,
    changeAccount:()=>{account='replacement';},
    reopen:()=>{store.close();store=new CliTurnJournal(file);sandbox.cliTurnJournal=store;}};
}

for(const provider of ['claude','codex','gemini','grok','agy'])test(`${provider}: actual relay can inspect and fence original preparation after Execute revocation`,t=>{
  const f=fixture(t,provider),original=f.request();assert.equal(original.ok,true);assert.equal(original.evidence.phase,'preparing');
  assert.equal(f.request('fence',{},'other-device'),undefined);assert.equal(f.request().evidence.phase,'preparing');
  f.reopen();const fenced=f.request('fence');assert.equal(fenced.ok,true);assert.equal(fenced.evidence.phase,'not_started');
  assert.equal(fenced.evidence.cancelled,true);assert.equal(fenced.evidence.nonce,original.evidence.nonce);
  assert.throws(()=>f.scope.run(()=>f.lifecycle.assertCanSpawn()),/no longer allowed|identity changed/);
  assert.deepEqual(f.request('fence').evidence,fenced.evidence);
  assert.equal(JSON.stringify(f.replies).includes('PRIVATE PROMPT'),false);
});

for(const provider of ['claude','codex','gemini','grok','agy'])test(`${provider}: recovery Stop fences the original issued turn after Execute revocation`,t=>{
  const f=fixture(t,provider);f.scope.run(()=>f.lifecycle.assertCanSpawn());
  assert.equal(f.request('stop',{requestHash:'0'.repeat(64)}).ok,false);
  assert.equal(f.request().evidence.phase,'issued');
  const stopped=f.request('stop');assert.equal(stopped.ok,true);assert.equal(stopped.evidence.phase,'uncertain');
  assert.equal(stopped.evidence.cancelled,true);
  assert.throws(()=>f.scope.run(()=>f.lifecycle.assertCanSpawn()),/cancelled/);
  f.reopen();assert.equal(f.request('stop').evidence.phase,'uncertain','uncontained executions never acquire native stop proof');
});

test('issued and completed work is never declared not started by a fence request',t=>{
  const f=fixture(t);f.scope.run(()=>f.lifecycle.assertCanSpawn());
  assert.equal(f.request('fence').evidence.phase,'issued');f.scope.close('done');f.reopen();
  const response=f.request('fence');assert.equal(response.evidence.phase,'uncertain');assert.equal(response.evidence.outcome,'done');
});
test('absent, changed input and another enrollment cannot obtain or create evidence',t=>{
  const f=fixture(t);for(const change of [{executionId:'missing'},{requestHash:cliTurnHash('different')}])assert.equal(f.request('fence',change).ok,false);
  f.changeAccount();assert.equal(f.request().ok,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cli_turns').get().n,1);
  assert.equal(f.db.prepare('SELECT phase FROM cli_turns').get().phase,'preparing');
});
test('failed preparation fence never emits a committed not-started receipt',t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER refuse_fence BEFORE UPDATE ON cli_turns BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
  assert.equal(f.request('fence').ok,false);assert.equal(f.request().evidence.phase,'preparing');
});
test('enrollment restart hold refuses reconciliation instead of adopting new settings',t=>{
  const f=fixture(t);f.sandbox.empir3RestartRequired=true;assert.equal(f.request('fence').ok,false);
  assert.equal(f.db.prepare('SELECT phase FROM cli_turns').get().phase,'preparing');
});
