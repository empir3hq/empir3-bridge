'use strict';
const {randomUUID}=require('node:crypto');
const {getControlLimits}=require('./control-limits.js');

// These operations are atomic: no remote connection can leave a key/button held.
function validateMonitorInput(input) {
  const p=input&&typeof input==='object'?input:{};
  if(!['move','click','doubleclick','drag','type','key','scroll'].includes(p.kind))throw new Error('Unsupported monitor input.');
  const result={kind:p.kind};
  if(['move','click','doubleclick','drag','scroll'].includes(p.kind)) {
    for(const key of ['x','y',...(p.kind==='drag'?['toX','toY']:[])]) {
      if(typeof p[key]!=='number'||!Number.isFinite(p[key])||p[key]<0||p[key]>1)throw new Error('Monitor coordinates must be within the displayed image.');
      result[key]=p[key];
    }
    result.button=['left','right','middle'].includes(p.button)?p.button:'left';
  }
  if(p.kind==='scroll') {
    if(typeof p.deltaY!=='number'||!Number.isFinite(p.deltaY)||p.deltaY===0)throw new Error('Invalid wheel movement.');
    result.deltaY=Math.max(-getControlLimits().scrollNotches*120,Math.min(getControlLimits().scrollNotches*120,p.deltaY));
  }
  if(p.kind==='type') {
    if(typeof p.text!=='string'||!p.text||p.text.length>getControlLimits().textCharacters)throw new Error('Invalid monitor text length.');
    result.text=p.text;
  }
  if(p.kind==='key') {
    if(typeof p.key!=='string'||!(/^[a-zA-Z0-9]$/.test(p.key)||['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Insert',' ','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'].includes(p.key)))throw new Error('Unsupported monitor key.');
    if(!Array.isArray(p.modifiers)||p.modifiers.some(m=>!['Alt','Control','Meta','Shift'].includes(m)))throw new Error('Invalid key modifiers.');
    result.key=p.key;result.modifiers=[...new Set(p.modifiers)];
  }
  return result;
}
function monitorPoint(p,bounds) {
  return {x:bounds.x+Math.min(bounds.width-1,Math.floor(p.x*bounds.width)),y:bounds.y+Math.min(bounds.height-1,Math.floor(p.y*bounds.height))};
}
function createMonitorControl(d) {
  const frames=new Map();
  const now=d.now||Date.now;
  function prune(){for(const [id,f]of frames)if(now()-f.at>getControlLimits().snapshotLifetimeMs)frames.delete(id);}
  return async function monitor(surface,action,params={}) {
    prune();
    if(typeof params.sessionId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(params.sessionId))throw new Error('A monitor session is required.');
    if(action==='monitor_frame') {
      const data=await d.capture(surface,params);
      if(!data?.base64||!data.bounds?.width||!data.bounds?.height)throw new Error('No usable monitor frame was returned.');
      const frameId=randomUUID();
      // Keep bounded frame metadata until expiry. A refresh must not invalidate
      // an input burst that is already queued against the displayed image.
      while(frames.size>=getControlLimits().workerQueue)frames.delete(frames.keys().next().value);
      frames.set(frameId,{sessionId:params.sessionId,surface,at:now(),bounds:data.bounds,targetId:data.targetId,monitor:data.monitor});
      return {success:true,...data,frameId,pointerMove:true};
    }
    if(action!=='monitor_input')throw new Error('Unsupported monitor operation.');
    const frame=frames.get(params.frameId);
    if(!frame||frame.surface!==surface||frame.sessionId!==params.sessionId)throw new Error('The displayed frame expired. Wait for a fresh image before trying again.');
    const input=validateMonitorInput(params.input);
    await d.input(surface,frame,input);
    // Never return private typed content to the caller or the action log.
    return {success:true,dispatched:true,verified:false};
  };
}

async function browserMonitorInput(session,input,bounds) {
  const p=validateMonitorInput(input);
  if(p.kind==='type'){await session.send('Input.insertText',{text:p.text});return;}
  if(p.kind==='key') {
    const codes={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,Insert:45,' ':32};
    const modifiers=p.modifiers.reduce((n,m)=>n|({Alt:1,Control:2,Meta:4,Shift:8}[m]),0);
    const code=codes[p.key]||(/^F\d+$/.test(p.key)?111+Number(p.key.slice(1)):p.key.toUpperCase().charCodeAt(0));
    const text=modifiers&7?undefined:p.key==='Enter'?'\r':p.key===' '?' ':undefined;
    try{await session.send('Input.dispatchKeyEvent',{type:text?'keyDown':'rawKeyDown',key:p.key,windowsVirtualKeyCode:code,modifiers,...(text?{text,unmodifiedText:text}:{})});}
    finally{await session.send('Input.dispatchKeyEvent',{type:'keyUp',key:p.key,windowsVirtualKeyCode:code,modifiers});}
    return;
  }
  const point=monitorPoint(p,bounds);
  if(p.kind==='move'){await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none',buttons:0});return;}
  if(p.kind==='scroll'){await session.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:p.deltaY});return;}
  const button=p.button, buttons={left:1,right:2,middle:4}[button];
  const clickCount=p.kind==='doubleclick'?2:1;
  await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none'});
  try {
    await session.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button,buttons,clickCount});
    if(p.kind==='drag') {
      const end=monitorPoint({x:p.toX,y:p.toY},bounds);
      for(let i=1;i<=12;i++)await session.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+(end.x-point.x)*i/12,y:point.y+(end.y-point.y)*i/12,button,buttons});
      Object.assign(point,end);
    }
  } finally {await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button,buttons:0,clickCount});}
}

module.exports={validateMonitorInput,monitorPoint,createMonitorControl,browserMonitorInput};
