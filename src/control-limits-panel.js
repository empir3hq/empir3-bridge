'use strict';
const {CONTROL_LIMIT_DEFS} = require('./control-limits.js');
/**
 * The Control limits editor, rendered inside the console's Desktop Tools pane.
 *
 * It used to live on a separate /settings page ("Bridge control center") that
 * duplicated the console's account, safety and permission surfaces and was the
 * only thing the Overview "Control limits" button linked to. That page is gone;
 * this panel moved here and uses the console's own block/idiom classes so it
 * looks native rather than like a transplanted page. Markup is self-contained
 * (its own inline script, talking to /api/settings/state) so it can be dropped
 * into any console pane without extra wiring.
 */
function controlLimitsPanelHtml(index = '06') {
  const groups = [...new Set(Object.values(CONTROL_LIMIT_DEFS).map(d => d.category))];
  const fields = groups.map(group => `<details class="limits-group"><summary>${group}</summary><div class="limits-grid">${Object.values(CONTROL_LIMIT_DEFS).filter(d => d.category === group).map(d => `<label class="limits-field"><strong>${d.label}</strong><small>${d.description}</small><input type="number" data-control-limit="${d.key}" min="${d.min}" max="${d.max}" step="${d.key === 'moveDistanceFactor' ? 'any' : '1'}" aria-describedby="limit-help-${d.key}" required disabled><small id="limit-help-${d.key}">${d.unit} · Default ${d.default} · Range ${d.min}–${d.max}</small></label>`).join('')}</div></details>`).join('');
  return `<div class="block" id="control-limits">
          <div class="block-head">
            <span class="ix">${index}</span>
            <span class="title">Control Limits</span>
            <span class="spacer"></span>
            <span class="sub">Timeouts, budgets and element caps for control actions on this PC</span>
          </div>
          <div class="block-body">
            <p style="margin:0 0 12px; font-size:12.5px; color:var(--soft);">Applies on this computer to MCP, local tools, and connected agents. Save takes effect for new actions; an active workflow keeps the budget it started with. Per-turn browser action budgets are an <span class="brand-inline">empir<span class="three">3</span></span> server setting and live in Admin → Limits, not here.</p>
            <form id="control-limits-form">${fields}<div class="desktop-actions" style="margin-top:14px;"><button type="submit" class="btn primary" id="control-limits-save" disabled>Save control limits</button><button type="button" class="btn" id="control-limits-reset" disabled>Restore defaults</button></div><p class="status" id="control-limits-status" role="status" aria-live="polite">Loading control limits…</p></form>
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
  })();</script>
          </div>
        </div>`;
}
module.exports={controlLimitsPanelHtml};
