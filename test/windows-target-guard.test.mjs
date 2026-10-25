import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createWindowsControlWorker}=require('../src/windows-control-worker.js');
const {NATIVE_TARGET_GUARD_PS}=require('../src/windows-native-input.js');

// Execute the production PowerShell guard with synthetic UIA boundaries. No
// desktop input, foreground changes, or reads of the user's applications.
const fixture=String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type @"
using System;
public static class Empir3NativeInput {
 public static void Check(IntPtr h) { if(h.ToInt64()!=100)throw new Exception("foreground changed"); }
 public static IntPtr HitWindow(int x,int y) { return (IntPtr)7; }
 public static bool IsChild(IntPtr p,IntPtr c) { return false; }
}
"@
function New-Node($id,$handle,$role,$parent) {
 $n=[pscustomobject]@{Id=$id;Parent=$parent;Current=[pscustomobject]@{
  NativeWindowHandle=$handle;ControlType=$role;IsOffscreen=$false;IsEnabled=$true;IsKeyboardFocusable=$true;IsPassword=$false;HasKeyboardFocus=$false;
  BoundingRectangle=[pscustomobject]@{X=10;Y=20;Width=40;Height=30}
 }}
 $n|Add-Member ScriptMethod GetRuntimeId {return @($this.Id)}
 $n|Add-Member ScriptMethod GetCurrentPattern {param($pattern);if($control.noInvoke){throw 'No InvokePattern'};return 'exact-button-invoke'}
 return $n
}
function Get-ProbeParent($n){return $n.Parent}
$window=New-Node 'window' 100 ([Windows.Automation.ControlType]::Window) $null
$pane=New-Node 'host' 7 ([Windows.Automation.ControlType]::Pane) $window
$button=New-Node 'button' 0 ([Windows.Automation.ControlType]::Button) $pane
if($control.field){$button.Current.ControlType=[Windows.Automation.ControlType]::Edit}
if($control.password){$button.Current.IsPassword=$true}
if($control.unfocusable){$button.Current.IsKeyboardFocusable=$false}
if($control.focused){$button.Current.HasKeyboardFocus=$true}
$focusedNodeFixture=if($control.focused -and -not $control.focusChanged){$button}else{$window}
$pointNodeFixture=$pane
switch($control.mode){
 'direct' {$pointNodeFixture=$button}
 'descendant' {$pointNodeFixture=New-Node 'label' 0 ([Windows.Automation.ControlType]::Text) $button}
 'sibling' {$pointNodeFixture=New-Node 'cover' 7 ([Windows.Automation.ControlType]::Pane) $window}
 'window' {$pointNodeFixture=$window}
 'underlying-document' {$pointNodeFixture=New-Node 'document' 7 ([Windows.Automation.ControlType]::Document) $window}
 'changed' {$button.Id='replacement'}
 'moved' {$button.Current.BoundingRectangle.X=40}
 'offscreen' {$button.Current.IsOffscreen=$true}
 'disabled' {$button.Current.IsEnabled=$false}
 'not-button' {$button.Current.ControlType=[Windows.Automation.ControlType]::Edit}
}
$global:Empir3DesktopRefs=@{fixture=$button}
`;
const guarded=NATIVE_TARGET_GUARD_PS
 .replace('[Windows.Automation.AutomationElement]::FocusedElement','$focusedNodeFixture')
 .replace(/\$candidate=\[System.Windows.Automation.AutomationElement\]::FromPoint\([^\n]+/g,'$candidate=$pointNodeFixture')
 .replace(/\[(?:System\.)?Windows.Automation.TreeWalker\]::ControlViewWalker.GetParent\((\$\w+)\)/g,'(Get-ProbeParent $1)');

test('native guard invokes only an exact button under its hit-tested host; never a covered sibling',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker();
 const target={ref:'fixture',capturedAt:Date.now(),runtimeId:'button',bounds:{x:10,y:20,width:40,height:30,cx:30,cy:35},window:{handle:100}};
 const run=(mode,more={})=>worker.run(fixture+guarded+'\n@{invoke=$empir3InvokeTarget}|ConvertTo-Json -Compress',15000,{target:{...target,capturedAt:Date.now()},mode,allowSemanticInvoke:true,...more});
 try{
  assert.equal((await run('host')).invoke,'exact-button-invoke');
  assert.equal((await run('direct')).invoke,null);
  assert.equal((await run('descendant')).invoke,null);
  for(const mode of ['sibling','window','changed','moved','offscreen','disabled','not-button'])await assert.rejects(run(mode),/stale_observation/);
  await assert.rejects(run('host',{allowSemanticInvoke:false}),/stale_observation/);
  await assert.rejects(run('host',{noInvoke:true}),/stale_observation/);
  await assert.rejects(run('host',{target:{...target,window:{handle:200}}}),/foreground changed/);
  assert.equal((await run('host',{field:true,allowSemanticFocus:true})).invoke,null);
  for(const mode of ['sibling','window','changed','moved','offscreen','disabled'])await assert.rejects(run(mode,{field:true,allowSemanticFocus:true}),/stale_observation/);
  await assert.rejects(run('host',{field:true,allowSemanticFocus:true,password:true}),/stale_observation/);
  await assert.rejects(run('host',{field:true,allowSemanticFocus:true,unfocusable:true}),/stale_observation/);
  await assert.rejects(run('host',{field:true}),/stale_observation/);
  assert.equal((await run('underlying-document',{field:true,allowSemanticFocus:true,focused:true})).invoke,null);
  await assert.rejects(run('underlying-document',{field:true,allowSemanticFocus:true}),/stale_observation/);
  await assert.rejects(run('underlying-document',{field:true,allowSemanticFocus:true,focused:true,focusChanged:true}),/stale_observation/);
  await assert.rejects(run('underlying-document',{focused:true}),/stale_observation/);
  for(const mode of ['changed','moved','offscreen','disabled'])await assert.rejects(run(mode,{field:true,allowSemanticFocus:true,focused:true}),/stale_observation/);
 }finally{worker.stop();}
});
