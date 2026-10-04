import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {NATIVE_SEMANTIC_PS,NATIVE_TEXT_VALUE_PS} from '../src/windows-semantic-control.js';

// Execute the fill branch with a synthetic provider whose ValuePattern setter
// echoes text but does not notify its application model, like a dialog edit.
const fill=NATIVE_SEMANTIC_PS.slice(NATIVE_SEMANTIC_PS.indexOf('$node=$global:'),NATIVE_SEMANTIC_PS.indexOf("} elseif ($operation -eq 'check')"))+'}\n';
const fixture=String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;
public static class Empir3NativeInput {
 public static string TextValue; public static int TextCalls; public static int KeyCalls;
 public static void Check(IntPtr h) {}
 public static void Keys(int[] keys,IntPtr h) { KeyCalls++;if(keys[0]==8)TextValue=""; }
 public static void Text(string value,IntPtr h) { TextValue=value;TextCalls++; }
}
"@
[Empir3NativeInput]::TextValue='old';[Empir3NativeInput]::TextCalls=0;[Empir3NativeInput]::KeyCalls=0
$script:focused='other';$script:setValues=0;$script:valueReads=0
$pattern=[pscustomobject]@{Current=[pscustomobject]@{IsReadOnly=[bool]$control.readOnly}}
$pattern.Current|Add-Member ScriptProperty Value {$script:valueReads++;if($control.neverSettles -or $script:valueReads -le [int]$control.settleReads){return 'prior value'};return [Empir3NativeInput]::TextValue}
$pattern|Add-Member ScriptMethod SetValue {param($value);$script:setValues++;[Empir3NativeInput]::TextValue=$value}
$script:fixturePattern=$pattern
$nodeFixture=[pscustomobject]@{Current=[pscustomobject]@{IsPassword=$false;NativeWindowHandle=12}}
$nodeFixture|Add-Member ScriptMethod GetCurrentPattern {param($id);return $script:fixturePattern}
$nodeFixture|Add-Member ScriptMethod SetFocus {if(-not $control.refuseFocus){$script:focused='field'}}
$global:Empir3DesktopRefs=@{fixture=$nodeFixture}
`;

test('native edits deliver normal input after exact focus; documents retain normalized readback',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker();
 const script=fixture+NATIVE_TEXT_VALUE_PS+fill.replaceAll("([Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',')",'$script:focused')+'\n@{verified=$verified;value=[Empir3NativeInput]::TextValue;textCalls=[Empir3NativeInput]::TextCalls;keyCalls=[Empir3NativeInput]::KeyCalls;setValues=$script:setValues;focused=$script:focused}|ConvertTo-Json -Compress';
 const run=(value,more={})=>worker.run(script,10000,{operation:'fill',encoded:Buffer.from(value,'utf16le').toString('base64'),target:{ref:'fixture',role:'Edit',runtimeId:'field',window:{handle:100}},...more});
 try{
  const text='D:\\draft café\\$report.txt';
  const result=await run(text);
  assert.equal(result.value,text);assert.equal(result.verified,true);assert.equal(result.textCalls,1);assert.equal(result.setValues,0);assert.equal(result.focused,'field');
  const empty=await run('');assert.equal(empty.value,'');assert.equal(empty.keyCalls,2);assert.equal(empty.textCalls,0);
  const delayed=await run(text,{settleReads:3,readbackTimeoutMs:250});assert.equal(delayed.verified,true);assert.equal(delayed.textCalls,1);assert.equal(delayed.keyCalls,1);
  const unsettled=await run(text,{neverSettles:true,readbackTimeoutMs:50});assert.equal(unsettled.verified,false);assert.equal(unsettled.textCalls,1);assert.equal(unsettled.keyCalls,1);
  await assert.rejects(run('new',{refuseFocus:true}),/focus was refused; no text was sent/);
  await assert.rejects(run('new',{readOnly:true}),/read-only/);
  const document=await run('first\r\nsecond',{target:{ref:'fixture',role:'Document',runtimeId:'field',window:{handle:100}}});
  assert.equal(document.verified,true);assert.equal(document.setValues,1);assert.equal(document.textCalls,0);
 }finally{worker.stop();}
});
