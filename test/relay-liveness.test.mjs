import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayLiveness} from '../src/relay-liveness.js';

test('local suspension allows queued pongs to arrive without dropping a healthy relay',()=>{
  let time=0;const live=createRelayLiveness({now:()=>time});
  time=20000;assert.equal(live.tick(),'recover');
  live.received();time=22000;assert.equal(live.tick(),'ping');
});
test('a dead peer still reconnects and repeated stalls cannot extend recovery forever',()=>{
  let time=0;const live=createRelayLiveness({now:()=>time});
  for(time=2000;time<=12000;time+=2000)assert.equal(live.tick(),'ping');
  assert.equal(live.tick(),'reconnect');
  const stalled=createRelayLiveness({now:()=>time});
  time+=20000;assert.equal(stalled.tick(),'recover');
  time+=2000;assert.equal(stalled.tick(),'ping');
  time+=20000;assert.equal(stalled.tick(),'reconnect');
});
