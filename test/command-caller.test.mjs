import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {EventEmitter} from 'node:events';
import {commandCaller} from '../src/command-caller.ts';import {compactReceipt} from '../src/control-runtime.js';
const req={headers:{origin:'http://user:password@localhost:3006/private?token=secret','user-agent':'Empir3UsageMonitor/0.1.0','x-empir3-client-id':'usage-monitor',authorization:'Bearer private-token',cookie:'private-cookie','x-empir3-nonce':'private-nonce'},socket:{remoteAddress:'::1',remotePort:48123}};
test('caller receipts retain only bounded origin, agent, client and connection hints',()=>{
  const caller=commandCaller(req);assert.deepEqual(caller,{origin:'http://localhost:3006',userAgent:'Empir3UsageMonitor/0.1.0',clientId:'usage-monitor',remoteAddress:'::1',remotePort:48123});assert.deepEqual(compactReceipt({caller}),{caller});assert.doesNotMatch(JSON.stringify(caller),/password|private\?|secret|private-token|private-cookie|private-nonce/);
  const messy=commandCaller({headers:{origin:'null','user-agent':'client\r\n'+('x'.repeat(500)),'x-empir3-client-id':'invalid\r\nID'},socket:{}});assert.equal(messy.userAgent.length,256);assert.doesNotMatch(messy.userAgent,/[\r\n]/);assert.equal(messy.origin,undefined);assert.equal(messy.clientId,undefined);
});
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const sf=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);const receiptFn=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='runCommandWithReceipt');
const start=source.indexOf("  if (url.pathname === '/api/command' && req.method === 'POST') {");const end=source.indexOf('// POST /api/shutdown',start);const route=source.slice(start,end);
for(const fails of [false,true])test(`actual command route records caller hints on ${fails?'unknown-command failure':'success'}`,async()=>{
  const receipts=[];const context={commandCaller,normalizeCommand:x=>x,browserRefusal:()=>null,recordActionReceipt:r=>receipts.push(compactReceipt(r)),summarizeCommand:cmd=>({type:cmd.type}),summarizeResult:r=>r,receiptOutcome:r=>({ok:true}),executeCommand:async cmd=>{if(fails)throw Error('Unknown command: '+cmd.type);return {success:true};}};
  context.runCommandWithReceipt=vm.runInNewContext(ts.transpileModule(receiptFn.getText(sf),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nrunCommandWithReceipt',context);
  const handlerSource=ts.transpileModule(`((req,res)=>{const url={pathname:'/api/command'};${route}})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const handler=vm.runInNewContext(handlerSource,context);
  const request=Object.assign(new EventEmitter(),req,{method:'POST'});let status;
  const finished=new Promise(resolve=>{handler(request,{writeHead:s=>{status=s;},end:body=>resolve(JSON.parse(body))});});
  request.emit('data',JSON.stringify({type:fails?'settings_state':'status',channel:'mcp',text:'private entered value'}));request.emit('end');const reply=await finished;
  assert.equal(status,fails?500:200);assert.equal(reply.ok,!fails);assert.equal(receipts[0].source,'mcp');assert.deepEqual(receipts[0].caller,commandCaller(req));assert.doesNotMatch(JSON.stringify(receipts),/private entered value|private-token|private-cookie|private-nonce/);if(fails)assert.match(receipts[0].error,/Unknown command/);
});
