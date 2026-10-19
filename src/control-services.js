'use strict';
const {getControlLimits} = require('./control-limits.js');
const {join} = require('node:path');
const {mkdirSync,statSync} = require('node:fs');
const {randomUUID} = require('node:crypto');
const {validateTarget} = require('./control-runtime.js');
const {browserControlExpression,browserObservationExpression} = require('./browser-control.js');
const {WINDOW_CAPTURE_PS} = require('./windows-control-observe.js');
const {NATIVE_SEMANTIC_PS,NATIVE_READ_VALUE_PS,NATIVE_LEGACY_PS} = require('./windows-semantic-control.js');
const {NATIVE_INPUT_PS,NATIVE_TARGET_GUARD_PS} = require('./windows-native-input.js');
const {desktopUnavailableMessage} = require('./capability-gate.js');
const {getPlatformProfile} = require('./platform-profile.js');
function createControlServices(d) {
  async function target(t, input=false) {
    validateTarget(t);
    if(t.surface==='browser') {
      const state=await d.tabs();
      if(!state.tabs.some(tab=>tab.targetId===t.tabId))throw new Error('target_closed: browser tab is unavailable.');
      if(input && d.userTarget()?.targetId===t.tabId)throw new Error('target_owned_by_user: hand control back in Bridge or choose another tab.');
      if(input && state.currentTargetId!==t.tabId)throw new Error('target_not_current: select the tab with browser_tab_focus before input.');
    } else {
      if(process.platform!=='win32')throw new Error(`capability_unsupported: ${desktopUnavailableMessage(getPlatformProfile())} Native window targets need the Windows backend.`);
      await d.runPS(`${d.preamble()}\n${NATIVE_INPUT_PS}\nAdd-Type -AssemblyName UIAutomationClient\n$h=[IntPtr]::new([long]$control.windowHandle)\n$w=[Windows.Automation.AutomationElement]::FromHandle($h)\nif (!$w) { throw 'target_closed' }\n${input?'[Empir3NativeInput]::Check($h)':''}\n[pscustomobject]@{success=$true} | ConvertTo-Json -Compress`,getControlLimits().nativeTargetTimeoutMs,t);
    }
  }
  async function browser(t,input) {
    const r=await d.cdpPost('/evaluate-on-target',{targetId:t.tabId,expression:browserControlExpression(input),...(['select','check','expand'].includes(input.operation)?{observeDialogs:true}:{})});
    if(r.ok===false)throw new Error(r.error);
    return r.needsDialogResponse?r:r.result;
  }
  async function observe(t, options={}) {
    await target(t);
    if(t.surface==='browser') {
      const r=await d.cdpPost('/evaluate-on-target',{targetId:t.tabId,expression:browserObservationExpression({...getControlLimits(),compact:options.compact===true,maxElements:options.maxElements})});
      if(r.ok===false)throw new Error(r.error || 'Browser observation failed.');
      return {success:true,target:t,observation:r.result};
    }
    const observation=await d.snapshot({type:'desktop_snapshot',windowHandle:t.windowHandle,maxElements:options.maxElements??getControlLimits().nativeElements});
    let image;
    if(options.image!==false) {
      await d.awake();const dir=join(d.feedbackDir(),'desktop');mkdirSync(dir,{recursive:true});
      image=await d.runPS(`${d.preamble()}\n${WINDOW_CAPTURE_PS}`,getControlLimits().nativeCaptureTimeoutMs,{windowHandle:t.windowHandle,path:join(dir,`window-${randomUUID()}.jpg`),maxWidth:Math.min(2560,Math.max(320,Number(options.maxWidth)||getControlLimits().imageWidth))});
      image.bytes=statSync(image.path).size;
    }
    return {success:true,target:t,observation,image};
  }
  async function element(t,locator) {
    if(locator?.ref) {const entry=d.resolveRef(locator.ref);if(entry.window.handle!==t.windowHandle)throw new Error('target_mismatch: ref belongs to another window.');return entry;}
    if(!locator||(!locator.name&&!locator.automationId&&!locator.runtimeId))throw new Error('Use locator.ref or exact name/automationId from observation.');
    const snap=await d.snapshot({type:'desktop_snapshot',windowHandle:t.windowHandle});
    const matches=snap.elements.filter(e=>(!locator.name||e.name===locator.name)&&(!locator.role||e.role===locator.role)&&(!locator.automationId||e.automationId===locator.automationId)&&(!locator.runtimeId||e.runtimeId===locator.runtimeId));
    if(matches.length!==1)throw new Error(matches.length?'ambiguous_target: refine the locator.':'target_missing: observe again.');
    return d.resolveRef(matches[0].ref);
  }
  async function inspect(t,c) {
    if(t.surface==='browser')return browser(t,{...c,operation:'inspect'});
    if(c.kind==='url')return {available:false,reason:'Native windows do not have URLs.'};
    let entry;
    try{entry=await element(t,c.locator);}catch(error){if(error.message.startsWith('target_missing:'))return {available:true,exists:false};throw error;}
    return d.runPS(`${d.preamble()}\n${NATIVE_READ_VALUE_PS}\n${NATIVE_LEGACY_PS}\nAdd-Type -AssemblyName UIAutomationClient
$n=$global:Empir3DesktopRefs[$control.ref]
if(!$n){throw 'stale_observation: observe again'}
$v=$null;$available=$true
switch($control.kind){
'value' {if($n.Current.IsPassword){$available=$false}else{try{$v=$n.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{$v=[Empir3NativeValue]::ReadText([IntPtr]::new($n.Current.NativeWindowHandle));$available=$null -ne $v}}}
'checked' {try{$v=$n.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq [Windows.Automation.ToggleState]::On}catch{$v=[Empir3LegacyControl]::Read([IntPtr]::new($n.Current.NativeWindowHandle),'checked');$available=$null -ne $v}}
'expanded' {try{$v=$n.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded}catch{$v=[Empir3LegacyControl]::Read([IntPtr]::new($n.Current.NativeWindowHandle),'expanded');$available=$null -ne $v}}
'text' {$v=$n.Current.Name}
}
if($control.kind -eq 'value'){$v=ConvertTo-Empir3TextValue $v $control.role}
[pscustomobject]@{available=$available;exists=$true;value=$v}|ConvertTo-Json -Compress`,getControlLimits().nativeReadTimeoutMs,{ref:entry.ref,kind:c.kind,role:entry.role});
  }
  // Receipts must say whether input could have reached the surface. Every
  // failure before the first input call (policy, target guard, value
  // validation, locator resolution) is marked inputMayHaveOccurred:false so
  // the runtime never reports dispatched:false together with "input may have
  // occurred" for a step that never touched the page or window.
  async function act(t,step,source) {
    const marker={reached:false};
    try { return await actInner(t,step,source,marker); }
    catch(error) {
      if(!marker.reached && error && typeof error==='object' && error.inputMayHaveOccurred===undefined) error.inputMayHaveOccurred=false;
      throw error;
    }
  }
  async function actInner(t,step,source,marker) {
    const reach=()=>{marker.reached=true;};
    const native=t.surface==='desktop';
    const types=native?{observe:'desktop_snapshot',click:'desktop_click_ref',fill:'desktop_type',select:'desktop_click_ref',check:'desktop_click_ref',expand:'desktop_click_ref',press:'desktop_key',scroll:'desktop_scroll',drag:'desktop_drag'}:{observe:'snapshot',click:'click',fill:'type',select:'click',check:'click',expand:'click',press:'press',scroll:'scroll',navigate:'navigate'};
    const type=types[step.action];if(!type)throw new Error('unsupported_action: unavailable on the selected surface.');
    const policy=d.policy({type},source);if(policy)throw new Error(policy.error);
    if(step.action==='observe')return observe(t,step);
    d.runtime.check();await target(t,true);
    if(['fill','select','check','expand'].includes(step.action)) {
      if(['check','expand'].includes(step.action)&&typeof step.value!=='boolean')throw new Error('value must be true or false.');
      if(step.action==='fill'&&(typeof step.value!=='string'||step.value.length>getControlLimits().textCharacters))throw new Error(`fill requires a string value up to ${getControlLimits().textCharacters} characters.`);
      if(!native){
        const resolved=await browser(t,{locator:step.locator,operation:step.action==='fill'?'resolve_fill':'resolve'});
        if(step.action==='fill'){
          reach();
          const result=await d.execute({type:'type',selector:resolved.selector,text:step.value,target:t},source);
          if(result?.success===false||result?.ok===false)throw new Error(result.error||'Field input failed.');
          if(result?.needsDialogResponse)return result;
          return browser(t,{...step,operation:'verify_fill'});
        }
        await d.cursor({selector:resolved.selector,intent:'focus'});
        reach();
        const at=Date.now();
        const result=await browser(t,{...step,operation:step.action});
        if(result?.needsDialogResponse)await d.recordingWarning?.(t,'A website dialog interrupted a semantic action. Review and repair that step before replay.');
        // Select/expand setters do not emit trusted DOM events. Record the
        // verified declarative action without trusting synthetic page events.
        if(result?.verified===true && ['select','expand'].includes(step.action)) {
          const locator={selector:resolved.selector},value=step.action==='select'?String(step.value):step.value;
          await d.recordSemantic?.(t,{action:step.action,locator,value,expect:{kind:step.action==='select'?'value':'expanded',locator,equals:value},at});
        }
        return result;
      }
      const entry=await element(t,step.locator);
      d.beginFeedback(step.action);
      reach();
      return d.runPS(`$empir3InputStarted=$false\ntry {\n${d.preamble()}\n${NATIVE_INPUT_PS}\n${NATIVE_TARGET_GUARD_PS}\n${NATIVE_READ_VALUE_PS}\n${NATIVE_SEMANTIC_PS}\n} catch { $_.Exception.Data['inputMayHaveOccurred']=[bool]$empir3InputStarted; throw }`,getControlLimits().nativeTextTimeoutMs,{target:entry,allowSemanticFocus:step.action==='fill',operation:step.action,value:step.value,readbackTimeoutMs:getControlLimits().editorAckTimeoutMs,encoded:Buffer.from(String(step.value??''),'utf16le').toString('base64')});
    }
    if(step.action==='click') {
      if(native){const e=await element(t,step.locator);reach();return d.execute({type,ref:e.ref,target:t},source);}
      const resolved=await browser(t,{locator:step.locator,operation:'resolve'});
      reach();
      return d.execute({type,selector:resolved.selector,target:t},source);
    }
    reach();
    return d.execute({...step,type,target:t,text:step.key || step.keys?.join('+'),url:step.url,keys:step.keys || (step.key?[step.key]:undefined)},source);
  }
  return {target,observe,inspect,act};
}
module.exports={createControlServices};
