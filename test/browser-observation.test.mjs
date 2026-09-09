import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {browserObservationExpression} from '../src/browser-control.js';
const element=(properties={},attributes={})=>({tagName:'INPUT',type:'checkbox',id:'fixture',value:'on',checked:false,getAttribute:name=>attributes[name]??null,...properties});
function observe(controls) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(browserObservationExpression({browserTextCharacters:1000,browserElements:20,browserNameCharacters:100}),{
    location:{href:'https://fixture.invalid/'},document:{title:'Fixture',body:{innerText:'Fixture'},querySelectorAll:()=>controls},
  })));
}
test('observation distinguishes checked, unchecked and mixed rather than checkbox value on',()=>{
  const result=observe([element(),element({checked:true}),element({indeterminate:true}),element({type:'radio',checked:true})]);
  assert.deepEqual(result.controls.map(c=>c.value),['on','on','on','on']);
  assert.deepEqual(result.controls.map(c=>c.checked),[false,true,'mixed',true]);
});
test('observation includes accessible toggle and expansion states without exposing password values',()=>{
  const result=observe([
    element({tagName:'DIV'},{role:'checkbox','aria-checked':'mixed'}),
    element({tagName:'BUTTON'},{'aria-expanded':'false','aria-disabled':'true'}),
    element({tagName:'SUMMARY',parentElement:{tagName:'DETAILS',open:true}}),
    element({type:'password',value:'fixture-secret'}),
  ]);
  assert.equal(result.controls[0].checked,'mixed');assert.equal(result.controls[1].expanded,false);
  assert.equal(result.controls[1].disabled,true);assert.equal(result.controls[2].expanded,true);
  assert.equal(result.controls[3].value,null);assert.equal(result.controls[3].checked,undefined);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
