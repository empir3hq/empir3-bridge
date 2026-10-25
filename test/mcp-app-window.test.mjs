import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['commandToolName','requiredBridgePermission','parseRelayStyleDesktopCommand','sourceUsesLocalMcpPolicy','enforceCommandPolicy'];
const declarations = ['COMMAND_TOOL_MAP','TOOL_PERMISSION_REQUIREMENTS','BROWSER_READ_ACTIONS','BROWSER_WRITE_ACTIONS','DESKTOP_READ_ACTIONS'];
const selected = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && functions.includes(n.name?.text)
  || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => declarations.includes(d.name.getText(parsed))));
const code = ts.transpileModule(selected.map(n => n.getText(parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function policyFixture() {
  const permissions = { read:true, execute:false };
  const enabledTools = { desktop_app:false, desktop_window:false };
  const context = vm.createContext({hasBridgePermission:p=>!!permissions[p],permissionDenied:p=>({success:false,error:'Permission denied: '+p}),enforceHandlerFamilyGate:()=>null,loadConfig:()=>({enabledTools})});
  vm.runInContext(code,context);
  return { permissions, enabledTools, check:(type,action,channel='mcp')=>context.enforceCommandPolicy({type:'desktop:'+type,action,channel},channel) };
}

test('app/window discovery works with read while mutation needs Execute and local opt-in', () => {
  const f=policyFixture();
  for(const [type,action] of [['app','list_running'],['app','is_running'],['window','list'],['window','active']]) assert.equal(f.check(type,action),null);
  for(const [type,action] of [['app','launch'],['app','kill'],['window','resize'],['window','close']]) {
    assert.match(f.check(type,action).error,/execute/);
    f.permissions.execute=true;
    assert.match(f.check(type,action).error,/MCP tool disabled locally/);
    assert.equal(f.check(type,action,'empir3'),null,'local opt-in must not disable an authorized companion');
    f.enabledTools['desktop_'+type]=true;
    assert.equal(f.check(type,action),null);
    f.enabledTools['desktop_'+type]=false;f.permissions.execute=false;
  }
  f.permissions.read=false;
  assert.match(f.check('app','is_running').error,/read/);
  assert.match(f.check('window','list').error,/read/);
});

test('named MCP adapters register valid schemas and forward only supported backend actions', async () => {
  const mcp=readFileSync(new URL('../src/mcp-server.ts',import.meta.url),'utf8');
  const tree=ts.createSourceFile('mcp.ts',mcp,ts.ScriptTarget.Latest,true),registered=new Map(),sent=[];
  const registrations=tree.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(tree)==='server.tool'&&['desktop_app','desktop_window'].includes(n.expression.arguments[0]?.text));
  assert.equal(registrations.length,2);
  vm.runInNewContext(ts.transpileModule(registrations.map(n=>n.getText(tree)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{z,server:{tool:(name,_description,shape,run)=>registered.set(name,{schema:z.object(shape),run})},bridgeCommand:async payload=>{sent.push(JSON.parse(JSON.stringify(payload)));return {success:true,verified:false}},jsonResult:r=>r});
  const app=registered.get('desktop_app'),win=registered.get('desktop_window');
  await app.run(app.schema.parse({action:'list'}));
  await app.run(app.schema.parse({action:'kill',pid:123}));
  await win.run(win.schema.parse({action:'resize',title:'Observed window',x:-200,width:1200,height:800}));
  assert.deepEqual(sent,[{type:'desktop:app',action:'list_running',params:{}},{type:'desktop:app',action:'kill',params:{pid:123}},{type:'desktop:window',action:'resize',params:{title:'Observed window',x:-200,width:1200,height:800}}]);
  assert.throws(()=>app.schema.parse({action:'kill',pid:-1}));
  assert.throws(()=>win.schema.parse({action:'resize',width:0}));
});
