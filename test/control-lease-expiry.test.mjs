import test from 'node:test';
import assert from 'node:assert/strict';
import {createControlRuntime} from '../src/control-runtime.js';

test('an abandoned action expires, pauses control and cannot overwrite a newer owner', {timeout:1500}, async () => {
  let paused = false, finish, finishNew, expired = 0;
  const runtime = createControlRuntime({isPaused:()=>paused, setPaused:v=>paused=v,
    leaseTimeoutMs:30, onExpire:()=>expired++});
  const old = runtime.exclusive({owner:'old'}, async()=>{
    await new Promise(resolve=>finish=resolve);
    runtime.update({owner:'obsolete'});
    await runtime.exclusive({owner:'late'}, async()=>{throw Error('late input reached');});
  });
  // Keep the test process alive while the production watchdog is unref'd.
  const keepAlive = setTimeout(()=>{}, 500);
  try {
    await assert.rejects(old, /control_lease_expired/);
    assert.equal(expired, 1);
    assert.equal(runtime.status().busy, false);
    assert.equal(runtime.status().owner, null);
    assert.equal(paused, true);
    runtime.resume();
    const fresh = runtime.exclusive({owner:'new'}, ()=>new Promise(r=>finishNew=r));
    finish();
    await new Promise(r=>setImmediate(r));
    assert.equal(runtime.status().owner, 'new');
    assert.equal(runtime.status().busy, true);
    finishNew();
    await fresh;
    assert.equal(runtime.status().owner, null);
  } finally { clearTimeout(keepAlive); }
});

test('progress keeps a live lease, while status reads do not renew a stuck one', {timeout:1500}, async () => {
  const runtime = createControlRuntime({leaseTimeoutMs:80});
  await runtime.exclusive({owner:'working'}, async()=>{
    for(let i=0;i<5;i++) {await new Promise(r=>setTimeout(r,25));runtime.check();}
  });
  const stuck = runtime.exclusive({owner:'stuck'}, ()=>new Promise(()=>{}));
  const poll = setInterval(()=>runtime.status(),10);
  try { await assert.rejects(stuck,/control_lease_expired/); }
  finally { clearInterval(poll); }
});

test('expiry remains paused and settles even when saving pause state fails', {timeout:1500}, async () => {
  const runtime = createControlRuntime({leaseTimeoutMs:30, setPaused:()=>{throw Error('disk unavailable');}});
  const keepAlive = setTimeout(()=>{},500);
  try {
    await assert.rejects(runtime.exclusive({owner:'stuck'},()=>new Promise(()=>{})),/control_lease_expired/);
    assert.equal(runtime.status().busy,false);
    assert.equal(runtime.status().paused,true);
    assert.throws(()=>runtime.check(),/control_paused/);
    assert.throws(()=>runtime.resume(),/disk unavailable/);
    assert.equal(runtime.status().paused,true);
  } finally {clearTimeout(keepAlive);}
});
