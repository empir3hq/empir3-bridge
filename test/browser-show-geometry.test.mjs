import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {getControlLimits} from '../src/control-limits.js';

const source=readFileSync(new URL('../src/bridge.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('bridge.ts',source,ts.ScriptTarget.Latest,true);
const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='showChromeWindow');
assert.ok(fn);
const javascript=ts.transpileModule(fn.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

for(const state of ['normal','maximized','fullscreen','minimized']){
  test(`show browser preserves ${state} geometry unless restoration is necessary`,async()=>{
    const calls=[];
    const show=vm.runInNewContext(javascript+';showChromeWindow;',{
      WRAPPER_PORT:3006,PORT:9867,currentTargetId:'owned-tab',chromeProcess:null,console,
      ensureChromeReady:async()=>{},cdpEvaluate:async()=>'http://127.0.0.1:3006/accuracy-lab',
      cdpNavigate:async()=>{throw Error('Showing an existing page must not navigate');},
      cdpSend:async(method,params)=>{calls.push({method,params});return method==='Browser.getWindowForTarget'?{windowId:7,bounds:{windowState:state}}:{};},
    });
    assert.equal(await show(),'http://127.0.0.1:3006/accuracy-lab');
    const resize=calls.filter(c=>c.method==='Browser.setWindowBounds');
    assert.equal(resize.length,state==='minimized'?1:0);
    if(resize.length){assert.equal(resize[0].params.windowId,7);assert.equal(resize[0].params.bounds.windowState,'normal');}
    assert.ok(calls.some(c=>c.method==='Page.bringToFront'));
  });
}

const serverSource=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const serverTree=ts.createSourceFile('server.ts',serverSource,ts.ScriptTarget.Latest,true);
const handler=serverTree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleWindowCommand');
const handlerJs=ts.transpileModule(handler.getText(serverTree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('legacy focus uses verified activation and refuses ambiguous titles or OS refusal',async()=>{
  let windows=[{handle:42,title:'Acceptance',isActive:false}],refused=false,calls=0;
  const focus=vm.runInNewContext(handlerJs+';handleWindowCommand;',{
    getControlLimits,
    hasBridgePermission:()=>true,listDesktopWindows:async()=>({windows}),
    desktopPreamble:()=>'',NATIVE_INPUT_PS:'native',ACTIVATE_WINDOW_PS:'activate',
    runDesktopPowerShellJson:async(script,timeout,bindings)=>{
      calls++;assert.equal(bindings.windowHandle,42);assert.ok(script.includes('activate'));
      if(refused)throw Error('activation_refused');return {success:true,verified:true};
    },
  });
  const result=await focus('focus',{title:'Acceptance'});
  assert.equal(result.verified,true);assert.equal(result.focused.isActive,true);
  refused=true;await assert.rejects(focus('focus',{title:'Acceptance'}),/activation_refused/);
  windows=[...windows,{handle:43,title:'Acceptance'}];
  assert.equal((await focus('focus',{title:'Acceptance'})).success,false);
  assert.equal(calls,2,'An ambiguous title must not activate any window');
});
