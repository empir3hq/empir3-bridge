'use strict';
// Serialized into the explicitly selected CDP target. Never accepts source code.
function browserControlOperation(input) {
  const locator = input.locator || {};
  if (input.kind === 'url') return {available:true, value:location.href};
  const role = el => el.getAttribute('role') || ({BUTTON:'button', SELECT:'combobox', TEXTAREA:'textbox', A:'link', INPUT:el.type === 'checkbox'?'checkbox':el.type === 'radio'?'radio':'textbox', SUMMARY:'button'}[el.tagName] || '');
  const name = el => el.getAttribute('aria-label') || (el.labels?.length ? Array.from(el.labels).map(l=>l.textContent).join(' ') : el.textContent || el.getAttribute('title') || '').trim();
  let candidates;
  if (locator.ref !== undefined) {
    if (typeof locator.ref !== 'string' || !/^e\d+(?:_\d+)?$/.test(locator.ref)) throw new Error('invalid_ref: use an element ref from a fresh browser_snapshot.');
    // Same target-local snapshot markers used by click_ref/type_ref. Never fall
    // back to a broader selector when the requested ref is missing.
    candidates = Array.from(document.querySelectorAll('[data-empir3-ref="'+locator.ref+'"]'));
  }
  else if (locator.selector) candidates = Array.from(document.querySelectorAll(locator.selector));
  else if (locator.role || locator.name) candidates = Array.from(document.querySelectorAll('button,input,textarea,select,a,[role],summary'));
  else throw new Error('Use locator.ref, locator.selector or exact locator.role/name.');
  candidates = candidates.filter(el => (!locator.role || role(el) === locator.role) && (!locator.name || name(el) === locator.name));
  const visible = candidates.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  if (visible.length > 1) throw new Error('ambiguous_target: more than one control matches; refine the locator.');
  const el = visible[0];
  if (input.operation === 'inspect') {
    if (input.kind === 'exists' || input.kind === 'absent') return {available:true, exists:!!el};
    if (!el) return {available:true, exists:false};
    if (el.type === 'password') return {available:false, reason:'password_value_not_exposed'};
    const value = input.kind === 'value' ? el.value : input.kind === 'checked' ? (typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true') : input.kind === 'expanded' ? (el.tagName === 'DETAILS' ? el.open : el.getAttribute('aria-expanded') === 'true') : el.textContent;
    return {available:value !== undefined, exists:true, value};
  }
  if (!el) throw new Error('target_missing: observe again and choose a visible control.');
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('target_disabled');
  const cssPath = node => {
    if (node.id && document.querySelectorAll('#'+CSS.escape(node.id)).length === 1) return '#'+CSS.escape(node.id);
    const parts=[];
    while (node && node.nodeType===1) {
      let part=node.tagName.toLowerCase(), i=1, sib=node;
      while ((sib=sib.previousElementSibling)) if(sib.tagName===node.tagName)i++;
      parts.unshift(part+':nth-of-type('+i+')'); node=node.parentElement;
    }
    return parts.join(' > ');
  };
  if(input.operation==='resolve_fill' && (!['INPUT','TEXTAREA'].includes(el.tagName)||el.readOnly))throw new Error('unsupported_control: fill needs an editable input or textarea.');
  if(input.operation==='verify_fill')return {success:true,dispatched:true,verified:el.value===input.value,password:el.type==='password'};
  if (input.operation === 'resolve' || input.operation === 'resolve_fill') { const r=el.getBoundingClientRect(); return {selector:cssPath(el),role:role(el),name:name(el),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}; }
  const emit = () => { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
  if (input.operation === 'fill') {
    if (!['INPUT','TEXTAREA'].includes(el.tagName) || el.readOnly) throw new Error('unsupported_control: fill needs an editable input or textarea.');
    const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set;
    el.focus(); setter.call(el,String(input.value ?? '')); emit();
    return {success:true, dispatched:true, verified:el.value === String(input.value ?? ''), password:el.type==='password'};
  }
  if (input.operation === 'select') {
    if (el.tagName !== 'SELECT' || el.multiple) throw new Error('unsupported_control: use advanced tools for this custom or multiple-selection control.');
    const options=Array.from(el.options).filter(o=>o.value===String(input.value));
    if(options.length!==1 || options[0].disabled) throw new Error('Choose one enabled option value from observation.');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,String(input.value));emit();
    return {success:true,dispatched:true,verified:el.value===String(input.value)};
  }
  if (input.operation === 'check') {
    if (el.tagName !== 'INPUT' || !['checkbox','radio'].includes(el.type)) throw new Error('unsupported_control: check needs a native checkbox or radio.');
    if(el.type==='radio' && input.value===false) throw new Error('Select the other radio option instead.');
    if(el.checked!==input.value) el.click();
    return {success:true,dispatched:true,verified:el.checked===input.value};
  }
  if (input.operation === 'expand') {
    const before = el.tagName === 'DETAILS' ? el.open : el.getAttribute('aria-expanded');
    if(before===null) throw new Error('unsupported_control: no expansion state exposed.');
    if(el.tagName==='DETAILS') el.open=input.value;
    else if((before==='true')!==input.value) el.click();
    return {success:true,dispatched:true,verified:(el.tagName==='DETAILS'?el.open:el.getAttribute('aria-expanded')==='true')===input.value};
  }
  throw new Error('Unsupported semantic action.');
}
function browserControlExpression(input) { return '('+browserControlOperation.toString()+')('+JSON.stringify(input)+')'; }
// Self-contained because it is serialized into the observed browser tab.
function browserControlObservation(limits) {
  const state = (el, attr) => {
    const value = el.getAttribute(attr);
    return value === 'true' ? true : value === 'false' ? false : value === 'mixed' ? 'mixed' : undefined;
  };
  return {
    url: location.href,
    title: document.title,
    text: document.body?.innerText.slice(0, limits.browserTextCharacters),
    controls: Array.from(document.querySelectorAll('input,textarea,select,button,a,[role],summary')).slice(0, limits.browserElements).map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      name: el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent?.slice(0, limits.browserNameCharacters),
      id: el.id,
      value: el.type === 'password' ? null : el.value,
      checked: el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)
        ? (el.indeterminate ? 'mixed' : el.checked) : state(el, 'aria-checked'),
      expanded: el.tagName === 'SUMMARY' && el.parentElement?.tagName === 'DETAILS'
        ? el.parentElement.open : state(el, 'aria-expanded'),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(option => ({value: option.value, label: option.label})) : undefined,
    })),
  };
}
function browserObservationExpression({browserTextCharacters,browserElements,browserNameCharacters}) {
  return '('+browserControlObservation.toString()+')('+JSON.stringify({browserTextCharacters,browserElements,browserNameCharacters})+')';
}
module.exports = { browserControlOperation, browserControlExpression, browserObservationExpression };
