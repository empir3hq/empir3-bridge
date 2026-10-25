import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const restart=source.slice(source.indexOf('let empir3RestartRequired ='),source.indexOf('function startPairPoll('));
const connect=source.slice(source.indexOf('function connectToEmpir3('),source.indexOf('// Detection is centralized'));
const code=transformSync(restart+connect,{loader:'ts'}).code;
for(const dev of [true,false])test(`account change retires the old relay and prevents reconnect (${dev?'source':'supervised'} install)`,()=>{
 let terminations=0,beats=0,fleet=0,decisions=0;const cleared=[],timers=[];
 const context=vm.createContext({process:{env:dev?{npm_lifecycle_event:'start'}:{},exit:()=>{}},
  empir3Connected:true,empir3Ws:{terminate:()=>terminations++},empir3ReconnectTimer:17,
  decisionRelay:{close:()=>decisions++},
  clearEmpir3Heartbeat:()=>beats++,stopFleetHealthBeat:()=>fleet++,clearTimeout:id=>cleared.push(id),
  setTimeout:(fn,delay)=>timers.push({fn,delay}),console:{log:()=>{}}});
 vm.runInContext(code,context);context.restartAfterPairing();
 assert.equal(terminations,1);assert.equal(beats,1);assert.equal(fleet,1);assert.deepEqual(cleared,[17]);
 assert.equal(decisions,1,'Changing accounts settles outstanding billed decisions');
 assert.equal(context.empir3Connected,false);assert.equal(context.empir3Ws,null);assert.equal(context.empir3ReconnectTimer,null);
 // No connection dependencies are installed: reaching the old auth/transport
 // path would throw, proving an operator delay cannot revive the old account.
 assert.doesNotThrow(()=>context.connectToEmpir3());
 assert.equal(timers.length,dev?0:1);if(!dev)assert.equal(timers[0].delay,500);
});
