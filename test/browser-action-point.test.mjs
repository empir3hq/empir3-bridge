import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import sourceModule from '../src/browser-action-point.ts';
const {browserActionPointExpression}=sourceModule;
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
function fixture({bounds=rect(0,0,200,60),clip,covered=false,moving=false,replace=false}={}) {
 let ticks=0,scroll;
 const style={display:'block',visibility:'visible',pointerEvents:'auto',overflowX:'visible',overflowY:'visible'};
 const parent=clip?{style:{...style,overflowX:'hidden'},getBoundingClientRect:()=>clip,clientWidth:clip.width,clientHeight:clip.height,clientLeft:0,clientTop:0}:null;
 const el={tagName:'BUTTON',isConnected:true,parentElement:parent,style,disabled:false,getAttribute:()=>null,closest:()=>null,contains:n=>n===el,scrollIntoView:o=>{scroll=o},getBoundingClientRect:()=>moving?rect(ticks*5,0,200,60):bounds,getClientRects:()=>[bounds]};
 const document={visibilityState:'visible',querySelector:()=>replace&&ticks?{}:el,elementFromPoint:(x,y)=>!covered&&x>=Math.max(0,clip?.left||0)&&x<Math.min(800,clip?.right||800)&&y>=0&&y<600?el:{}};
 return {el,document,get scroll(){return scroll},run:async()=>JSON.parse(await vm.runInNewContext(browserActionPointExpression('#test','test',false,'','tab-1'),{document,innerWidth:800,innerHeight:600,getComputedStyle:n=>n.style,setTimeout:fn=>{ticks++;fn()}}))};
}
test('uses viewport intersection and instant scrolling for a wide control',async()=>{
 const f=fixture({bounds:rect(0,20,1600,60)}),r=await f.run();assert.equal(r.x,400);assert.equal(r.y,50);assert.equal(f.scroll.behavior,'instant');
});
test('uses the visible portion inside a clipping ancestor',async()=>{
 const r=await fixture({bounds:rect(0,0,400,60),clip:rect(0,0,100,100)}).run();assert.equal(r.x,50);assert.equal(r.y,30);
});
test('never returns coordinates for a covering overlay, moving or replaced target',async()=>{
 for(const options of [{covered:true},{moving:true},{replace:true}]){const r=await fixture(options).run();assert.match(r.error,/No input was sent/);assert.equal(r.x,undefined);}
});
test('hidden, disabled and inert controls remain refusals',async()=>{
 for(const kind of ['hidden','disabled','inert']){const f=fixture();if(kind==='hidden')f.document.visibilityState='hidden';if(kind==='disabled')f.el.disabled=true;if(kind==='inert')f.el.closest=()=>({});const r=await f.run();assert.match(r.error,/No input was sent/);assert.equal(r.x,undefined);}
});
