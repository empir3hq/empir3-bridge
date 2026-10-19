import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('actual relay status reports the browser and payload version in the deployed app contract',async()=>{
 const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
 const start=source.indexOf("case 'status': {",source.indexOf('async function executeCommand('));
 assert.ok(start>0);
 const body=source.slice(start,source.indexOf("case 'bridge_scale':",start));
 for(const connected of [true,false]){
  let listed=0;
  const context=vm.createContext({cdpConnected:connected,BRIDGE_VERSION:'test-candidate',sessionCtx:{},
   listBrowserTabs:async()=>{listed++;return {tabs:[{targetId:'agent',url:'https://example.com'}],currentTargetId:'agent'};},
   pruneDeadTabTargets:()=>{},
  });
  const result=await vm.runInContext(`(async()=>{switch('status'){${body}}})()`,context);
  assert.equal(result.browserRunning,connected);
  assert.equal(result.running,connected);
  assert.equal(result.version,'test-candidate');
  assert.equal(result.engine,'empir3');
  assert.equal(result.currentUrl,connected?'https://example.com':'');
  assert.equal(listed,connected?1:0);
 }
});
