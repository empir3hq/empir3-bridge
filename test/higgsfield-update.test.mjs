import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {CLI_LIFECYCLE_CATALOG, actionForPlatform, resolveCliLifecycle} from '../src/cli-platform.js';
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
const selected=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&['cliLifecycleAction','launchProviderUpdate'].includes(n.name?.text)).map(n=>n.getText(tree)).join('\n');
const javascript=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('Higgsfield update dispatches the same Windows vendor command advertised to the console and preserves failure',async()=>{
  let calls=[],invalidated=0,succeed=true;
  const update=vm.runInNewContext(javascript+';launchProviderUpdate;',{
    process:{platform:'win32'},CLI_LIFECYCLE_CATALOG,actionForPlatform,_cliLatestCache:{},
    launchProviderAction:async(provider,action)=>{calls.push({provider,action});return succeed?{ok:true,launched:true,actionId:'fixture'}:{ok:false,error:'Installer refused'}},
    invalidateCliProbeCache:()=>invalidated++,
  });
  const result=await update('higgsfield');assert.equal(result.actionId,'fixture');assert.equal(calls.length,1);
  assert.equal(calls[0].provider,'higgsfield');assert.equal(calls[0].action.bin,'npm');assert.deepEqual(calls[0].action.args,['install','-g','@higgsfield/cli@latest']);
  const ui=resolveCliLifecycle('higgsfield',{platform:'win32'});assert.equal(ui.update.launchSupported,true);assert.equal(ui.update.command,[calls[0].action.bin,...calls[0].action.args].join(' '));
  assert.equal(invalidated,1);succeed=false;
  const failed=await update('higgsfield');assert.equal(failed.ok,false);assert.equal(failed.error,'Installer refused');assert.equal(invalidated,1);assert.equal(calls.length,2);
});
