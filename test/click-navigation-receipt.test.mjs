import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import failure from '../src/browser-refusal.ts';
const source = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function clickBrowserTarget(');
const code = transformSync(source.slice(start, source.indexOf('async function clickByRef(', start)), { loader: 'ts' }).code;
function harness({ received = true, held = false, arm = true, popup = false } = {}) {
  let listener, binding, navigated = false, closed = false, removed = false, input = 0;
  const session = { targetId: 'fixture', onEvent: fn => { listener = fn; return () => { removed = true; }; }, close: () => { closed = true; },
    send: async (method, params) => {
      if (method === 'Runtime.addBinding') binding = params.name;
      if (method === 'Runtime.evaluate') {
        if (navigated) throw Error('Execution context was destroyed');
        return { result: { value: arm } };
      }
      return {};
    } };
  const activated=[];
  const ctx = vm.createContext({ currentTargetId: 'fixture', emulationSession: held ? session : null,
    browserActionFailure:failure.browserActionFailure,
    ensureBrowserWsReady:async()=>{},browserSend:async(method,params)=>{if(method==='Target.activateTarget'){activated.push(params.targetId);return {};}
      return {targetInfos:popup&&input?[{targetId:'popup',openerId:'fixture',type:'page',url:'https://example.test/new'}]:[]};},
    resolveBrowserActionTarget: async () => ({ x: 100, y: 200 }), openPageCdpSession: async () => session, sleep: async () => {},
    clickByXY: async () => { input++; if (received) listener({ method: 'Runtime.bindingCalled', params: { name: binding, payload: 'click' } }); navigated = true; },
  });
  vm.runInContext(code, ctx);
  return { run: () => ctx.clickBrowserTarget('#next', 'Next'), state: () => ({ closed, removed, input }),activated };
}
test('trusted navigation remains verified after its document is gone', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.verified, true); assert.deepEqual(Array.from(result.receivedEvents), ['click']);
  assert.deepEqual(h.state(), { closed: true, removed: true, input: 1 });
});
test('a click-created page is reported and the agent page regains focus',async()=>{
 const h=harness({popup:true});const r=await h.run();assert.equal(r.newTab.targetId,'popup');assert.equal(r.newTab.url,'https://example.test/new');assert.deepEqual(h.activated,['fixture']);
});
test('missing proof stays uncertain and never claims a verified click', async () => {
  const h = harness({ received: false }); await assert.rejects(h.run(), err => err.inputMayHaveOccurred === true && /Observe/.test(err.message));
});
test('a disappeared target receives no input; an emulation session survives click cleanup', async () => {
  const missing = harness({ arm: false }); await assert.rejects(missing.run(), /before input/); assert.equal(missing.state().input, 0);
  const held = harness({ held: true }); await held.run(); assert.equal(held.state().closed, false);
});
