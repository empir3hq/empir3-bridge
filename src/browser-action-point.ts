/** Locate a stable, hit-tested point in the visible portion of a control. */
export function browserActionPointExpression(selector: string, label: string, requireEditable = false, desiredText = '', targetId = ''): string {
  return `(async function() {
    const selector = ${JSON.stringify(selector)}, label = ${JSON.stringify(label)};
    const fail = error => JSON.stringify({error: error + ' No input was sent.'});
    if (document.visibilityState === 'hidden') return fail('browser_tab_not_visible: Use browser_tab_focus action "control" with targetId ' + ${JSON.stringify(targetId)} + ', then observe again.');
    const el = document.querySelector(selector);
    if (!el) return fail('Element not found: ' + label);
    if (${requireEditable} && el.tagName === 'SELECT') {
      const options = Array.from(el.options).filter(o => !o.disabled).map(o => ({value:o.value,label:o.label}));
      const desired = ${JSON.stringify(desiredText)};
      const matches = options.filter(o => o.value === desired || o.label === desired);
      return JSON.stringify({error:'This is a select menu, not a text field.',selectOptions:options,selectValue:matches.length===1?matches[0].value:undefined});
    }
    const editable = el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    if (${requireEditable} && !editable) return fail('Element is not editable: ' + label);
    el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    let previous = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (document.visibilityState === 'hidden' || !el.isConnected || document.querySelector(selector) !== el) return fail('Target changed before input: ' + label);
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || style.display === 'none' || style.visibility !== 'visible' || style.pointerEvents === 'none') return fail('Element is not actionable: ' + label);
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) return fail('Element is disabled: ' + label);
      const same = previous && ['left','top','width','height'].every(k => Math.abs(previous[k]-r[k]) < 0.5);
      previous = {left:r.left,top:r.top,width:r.width,height:r.height};
      if (same) {
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p), box = p.getBoundingClientRect();
          if (/^(hidden|clip|auto|scroll|overlay)$/.test(s.overflowX)) { left=Math.max(left,box.left+p.clientLeft);right=Math.min(right,box.left+p.clientLeft+p.clientWidth); }
          if (/^(hidden|clip|auto|scroll|overlay)$/.test(s.overflowY)) { top=Math.max(top,box.top+p.clientTop);bottom=Math.min(bottom,box.top+p.clientTop+p.clientHeight); }
        }
        for (const rect of el.getClientRects()) {
          const l=Math.max(left,rect.left), t=Math.max(top,rect.top), w=Math.min(right,rect.right)-l, h=Math.min(bottom,rect.bottom)-t;
          if (w <= 1 || h <= 1) continue;
          for (const [fx,fy] of [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]]) {
            const x=l+w*fx, y=t+h*fy, hit=document.elementFromPoint(x,y);
            if (hit && (hit===el || el.contains(hit))) return JSON.stringify({x,y,tag:el.tagName.toLowerCase(),editable});
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve,20));
    }
    return fail('Element has no stable, unobscured visible point: ' + label + '. Observe the page and dismiss any covering panel before retrying.');
  })()`;
}
