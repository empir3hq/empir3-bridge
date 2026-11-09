import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecordedSteps} from '../src/control-recording.js';
import {validatePlan} from '../src/control-runtime.js';
const target={surface:'browser',tabId:'recording-fixture'};
const click={action:'click',locator:{selector:'#save'},expect:null};

test('old recorded clicks omit the null outcome without weakening direct plans',()=>{
  const original=structuredClone(click);
  assert.deepEqual(validateRecordedSteps([click],target),[{action:'click',locator:{selector:'#save'}}]);
  assert.deepEqual(click,original);
  assert.throws(()=>validatePlan({target,steps:[click]}),/condition kind/);
});
test('recording preflight rejects malformed later conditions and invalid actions',()=>{
  for(const expect of [false,{},'',{kind:'text',equals:'done'}]){
    assert.throws(()=>validateRecordedSteps([click,{action:'wait',expect}],target),/condition|locator/);
  }
  assert.throws(()=>validateRecordedSteps([click,{action:'evaluate',script:'bad'}],target),/Unknown/);
});
test('recorded value checks preserve the actual assertion and inherited locator',()=>{
  const fill={action:'fill',locator:{selector:'#name'},value:'café 中文',expect:{kind:'value',equals:'café 中文'}};
  assert.deepEqual(validateRecordedSteps([fill],target)[0].expect,{...fill.expect,locator:fill.locator});
  assert.throws(()=>validateRecordedSteps([{...fill,expect:null}],target),/condition kind/);
});
