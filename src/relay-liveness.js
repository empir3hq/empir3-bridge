'use strict';

// A delayed local timer is not evidence of a dead peer. After sleep or CPU
// pressure, give queued network frames one bounded chance to be processed.
function createRelayLiveness({now=Date.now, timeoutMs=12000, intervalMs=2000, recoveryMs=4000}={}) {
  let lastReceived=now(), lastTick=lastReceived, recoveryUntil=0;
  return {
    received() { lastReceived=now(); recoveryUntil=0; },
    tick() {
      const time=now(), delayed=time-lastTick > intervalMs*2;
      lastTick=time;
      if(time-lastReceived <= timeoutMs) return 'ping';
      if(delayed && !recoveryUntil) {
        recoveryUntil=time+recoveryMs;
        return 'recover';
      }
      if(recoveryUntil && time<recoveryUntil) return 'ping';
      return 'reconnect';
    },
  };
}
module.exports={createRelayLiveness};
