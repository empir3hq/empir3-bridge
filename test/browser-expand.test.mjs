import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {browserControlExpression} from '../src/browser-control.js';

function fixture(tag, attrs={}) {
  const parent={tagName:'DETAILS',open:false};
  const el={tagName:tag,parentElement:parent,textContent:'More details',
    getAttribute:k=>attrs[k]??null,hasAttribute:k=>Object.hasOwn(attrs,k),
    getClientRects:()=>[{}],click(){attrs['aria-expanded']=String(attrs['aria-expanded']!=='true')}};
  const run=input=>JSON.parse(JSON.stringify(vm.runInNewContext(browserControlExpression({locator:{selector:'#disclosure'},...input}),{
    document:{querySelectorAll:()=>[el]},getComputedStyle:()=>({visibility:'visible'})
  })));
  return {parent,run};
}

test('observed native summary expands and reads the same parent details state',()=>{
  const {parent,run}=fixture('SUMMARY');
  for(const value of [false,true,true,false]){
    assert.equal(run({operation:'expand',value}).verified,true);
    assert.equal(parent.open,value);
    assert.deepEqual(run({operation:'inspect',kind:'expanded'}),{available:true,exists:true,value});
  }
});

test('ARIA disclosure preserves desired state and a plain button has no expansion assertion',()=>{
  const {run}=fixture('BUTTON',{'aria-expanded':'false'});
  for(const value of [true,true,false]){
    assert.equal(run({operation:'expand',value}).verified,true);
    assert.equal(run({operation:'inspect',kind:'expanded'}).value,value);
  }
  const plain=fixture('BUTTON').run;
  assert.equal(plain({operation:'inspect',kind:'expanded'}).available,false);
  assert.throws(()=>plain({operation:'expand',value:true}),/no expansion state/);
});
