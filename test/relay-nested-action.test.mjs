import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='parseRelayStyleDesktopCommand');
assert.ok(fn);
const context=vm.createContext({});vm.runInContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const parse=cmd=>JSON.parse(JSON.stringify(context.parseRelayStyleDesktopCommand(cmd)));
test('HTTP relay routing retains nested focus and dialog actions without routing them as commands',()=>{
 for(const type of ['desktop:browse','desktop:agent-browser'])for(const [action,nested] of [['tab_focus','show_agent'],['dialog','accept']]){
  const target={surface:'browser',tabId:'owned'};
  const result=parse({type,action,params:{action:nested,target,dialogId:'fresh'}});
  assert.equal(result.base,type);assert.equal(result.action,action);assert.equal(result.params.action,nested);assert.deepEqual(result.params.target,target);assert.equal(result.params.dialogId,'fresh');
 }
});
test('qualified relay action and ordinary desktop adapters retain their original routing',()=>{
 const dialog=parse({type:'desktop:browse:dialog',params:{action:'dismiss'}});assert.equal(dialog.action,'dialog');assert.equal(dialog.params.action,'dismiss');
 const resize=parse({type:'desktop:window',action:'resize',params:{width:1000}});assert.equal(resize.action,'resize');assert.equal(resize.params.width,1000);assert.equal(resize.params.action,undefined);
});
