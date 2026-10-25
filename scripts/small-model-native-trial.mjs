import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Opt-in, bounded model trial. Only the disposable fixture's observed controls
// are eligible. No shell, files, network tools, raw coordinates or shortcuts.
export async function smallModelNativeTrial(command, endpoint, model) {
  const contract=JSON.parse(readFileSync(new URL('../src/desktop-core-contract.json',import.meta.url),'utf8'));
  const selected=['desktop_snapshot','desktop_click_ref','desktop_type'];
  const tools=selected.map(name=>({type:'function',function:{name,description:contract.find(c=>c.mcp===name).description,parameters:name==='desktop_snapshot'?{type:'object',properties:{}}:name==='desktop_click_ref'?{type:'object',properties:{ref:{type:'string'}},required:['ref']}:{type:'object',properties:{text:{type:'string'},ref:{type:'string'}},required:['text','ref']}}}));
  const expected='Vincent ✓ café + {literal}';
  const messages=[{role:'system',content:'Use the advertised tools. Observe the intended window, copy the exact returned ref, perform one action, then observe to verify the actual field value. A dispatched receipt is not proof. Never invent a ref. Finish only after the value matches.'},{role:'user',content:`In the already-open Empir3 Native Control Acceptance test window, enter exactly "${expected}" in the empty Control text field. Verify its value using a fresh snapshot.`}];
  const calls=[];let allowed=new Set(),verified=false;
  for(let turn=0;turn<8;turn++) {
    const started=performance.now();
    const response=await fetch(endpoint.replace(/\/$/,'')+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,tools,stream:false,options:{temperature:0,num_predict:700}}),signal:AbortSignal.timeout(45000)});
    assert.ok(response.ok,'Local model endpoint refused the trial');
    const reply=await response.json();assert.ok(reply.message,'Model response lacks a message');messages.push(reply.message);
    if(!reply.message.tool_calls?.length) { assert.ok(verified,'Model finished without observing the correct value');return {passed:true,model,expected,calls}; }
    for(const call of reply.message.tool_calls) {
      const name=call.function.name;assert.ok(selected.includes(name),'Model requested an unadvertised action');
      const args=typeof call.function.arguments==='string'?JSON.parse(call.function.arguments):call.function.arguments;
      if(name!=='desktop_snapshot')assert.ok(allowed.has(args.ref),'Model invented a ref or selected a non-fixture control');
      if(name==='desktop_type')assert.equal(args.text,expected,'Model changed the requested literal text');
      const result=await command({type:name,...args});
      if(name==='desktop_snapshot') {
        const fields=result.elements.filter(e=>e.role==='Edit'&&e.window?.title==='Empir3 Native Control Acceptance');
        assert.equal(fields.length,1,'Disposable fixture must be foreground');
        allowed=new Set(fields.map(e=>e.ref));verified=fields[0].value===expected;
      }
      calls.push({name,modelMs:Math.round(performance.now()-started),verified});
      messages.push({role:'tool',tool_name:name,content:JSON.stringify(result)});
    }
  }
  throw Error('Small model exceeded the eight-turn acceptance limit');
}
