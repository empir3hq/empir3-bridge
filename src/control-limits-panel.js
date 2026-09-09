'use strict';
const {CONTROL_LIMIT_DEFS} = require('./control-limits.js');
function controlLimitsPanelHtml() {
  const groups = [...new Set(Object.values(CONTROL_LIMIT_DEFS).map(d => d.category))];
  const fields = groups.map(group => `<details class="tool-group"><summary><span>${group}</span></summary><div class="form-grid">${Object.values(CONTROL_LIMIT_DEFS).filter(d => d.category === group).map(d => `<label class="field"><strong>${d.label}</strong><small>${d.description}</small><input type="number" data-control-limit="${d.key}" min="${d.min}" max="${d.max}" step="${d.key === 'moveDistanceFactor' ? 'any' : '1'}" aria-describedby="limit-help-${d.key}" required disabled><small id="limit-help-${d.key}">${d.unit} · Default ${d.default} · Range ${d.min}–${d.max}</small></label>`).join('')}</div></details>`).join('');
  return `<section class="panel" id="control-limits"><div class="panel-head"><div><h2>Control limits</h2><p>Applies on this computer to MCP, local tools, and connected agents. Save takes effect for new actions; an active workflow keeps its starting budget. App turn budgets live in Admin → Limits.</p></div></div>
  <form id="control-limits-form">${fields}<div class="actions" style="margin-top:16px"><button type="submit" class="primary" id="control-limits-save" disabled>Save control limits</button><button type="button" id="control-limits-reset" disabled>Restore defaults</button></div><p id="control-limits-status" role="status" aria-live="polite">Loading control limits…</p></form>
  <script>(function(){
    const defs=${JSON.stringify(CONTROL_LIMIT_DEFS)},form=document.getElementById('control-limits-form'),status=document.getElementById('control-limits-status');
    const fields=Array.from(form.querySelectorAll('[data-control-limit]'));let saved={},resets=false;
    function busy(value){form.querySelectorAll('input,button').forEach(e=>e.disabled=value)}
    function paint(values){saved={...values};fields.forEach(e=>e.value=values[e.dataset.controlLimit]);resets=false}
    async function request(method,patch){const r=await fetch('/api/settings/state',method==='POST'?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({bridge:{controlLimits:patch}})}:undefined);const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Could not load control limits');return j.bridge.controlLimits}
    form.addEventListener('input',()=>{status.textContent='Changes pending. Save control limits to apply.'});
    document.getElementById('control-limits-reset').onclick=()=>{fields.forEach(e=>e.value=defs[e.dataset.controlLimit].default);resets=true;status.textContent='Defaults staged. Save control limits to apply.'};
    form.onsubmit=async event=>{event.preventDefault();if(!form.reportValidity())return;const patch={};fields.forEach(e=>{const key=e.dataset.controlLimit,value=Number(e.value);if(resets||value!==saved[key])patch[key]=resets&&value===defs[key].default?null:value});busy(true);status.textContent='Saving control limits…';try{paint(await request('POST',patch));status.textContent='Control limits saved. New actions use these values.'}catch(e){status.textContent='Save failed: '+e.message}finally{busy(false)}};
    request('GET').then(values=>{paint(values);busy(false);status.textContent='Current limits loaded.'}).catch(e=>{status.textContent='Load failed: '+e.message+' Reload this page to retry.'});
  })();</script></section>`;
}
module.exports={controlLimitsPanelHtml};
