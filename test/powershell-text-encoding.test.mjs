import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {basename,join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import vm from 'node:vm';
import ts from 'typescript';

const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
// runProcess moved to src/run-process.ts (detached-child fix, 24fafb79); still the production helper.
const runProcessTree=ts.createSourceFile('run-process.ts',readFileSync(new URL('../src/run-process.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const names=['runProcess','runPowerShellText'];
const functions=names.map(name=>{
 const t=name==='runProcess'?runProcessTree:tree;
 const node=t.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
 assert.ok(node,`Missing production helper ${name}`);
 return node.getText(t).replace(/^export\s+/,'');
}).join('\n');
const javascript=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function load(spawnProcess=spawn){
 return vm.runInNewContext(javascript+';({runProcess,runPowerShellText});',{
  process,Buffer,join,basename,setTimeout,clearTimeout,spawn:spawnProcess,
  registerOwnedCliProcess:child=>child,terminateCliProcessTree:child=>child.kill(),
 });
}
const text='Vincent — café ✓ 中文 😀\r\n+ {test}';
const codes=Array.from({length:text.length},(_,i)=>text.charCodeAt(i));

test('PowerShell stdin decodes real character codes, not a misleading text round trip',{skip:process.platform!=='win32'},async()=>{
 const {runPowerShellText}=load();
 const result=await runPowerShellText('param()\n$value=[Console]::In.ReadToEnd(); @($value.ToCharArray()|ForEach-Object{[int]$_})|ConvertTo-Json -Compress',10000,text);
 assert.equal(result.success,true,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),codes);
});

test('PowerShell stdout and stderr encode independently supplied Unicode as UTF-8',{skip:process.platform!=='win32'},async()=>{
 const {runPowerShellText}=load();
 const encoded=Buffer.from(text,'utf16le').toString('base64');
 const result=await runPowerShellText(`$value=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); [Console]::Write($value); [Console]::Error.Write($value)`,10000);
 assert.equal(result.success,true,result.stderr);
 assert.equal(result.stdout,text);
 assert.equal(result.stderr,text);
});

test('process output preserves multibyte characters split across pipe chunks',async()=>{
 const {runProcess}=load(()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  setImmediate(()=>{
   for(const byte of Buffer.from(text,'utf8')){child.stdout.write(Buffer.from([byte]));child.stderr.write(Buffer.from([byte]));}
   child.stdout.end();child.stderr.end();child.emit('close',0);
  });
  return child;
 });
 const result=await runProcess('fixture');
 assert.equal(result.stdout,text);
 assert.equal(result.stderr,text);
});
