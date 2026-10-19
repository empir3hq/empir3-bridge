import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createWindowsControlWorker}=require('../src/windows-control-worker.js');
const {NATIVE_TEXT_VALUE_PS}=require('../src/windows-semantic-control.js');

test('document readback normalizes RichEdit paragraphs without changing other field values',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker();
 const run=(value,role)=>worker.run(NATIVE_TEXT_VALUE_PS+'\n@{value=(ConvertTo-Empir3TextValue $control.value $control.role)}|ConvertTo-Json -Compress',10000,{value,role});
 try{
  assert.equal((await run('café ✓ 中文 😀\r\nsecond\rthird\nlast','Document')).value,'café ✓ 中文 😀\nsecond\nthird\nlast');
  assert.equal((await run('exact\r\nfield','Edit')).value,'exact\r\nfield');
  assert.equal((await run('','Document')).value,'');
  assert.equal((await run(null,'Document')).value,null);
 }finally{worker.stop();}
});
