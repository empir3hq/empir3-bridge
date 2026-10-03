'use strict';
const NATIVE_TEXT_VALUE_PS=String.raw`
function ConvertTo-Empir3TextValue($value, $role) {
 if ($null -eq $value) { return $null }
 # RichEdit documents expose paragraph breaks as CR even after SetValue(CRLF).
 # The control API uses LF for document text; other field values stay exact.
 if ($role -eq 'Document') { return ([string]$value) -replace '\r\n?', ([string][char]10) }
 return $value
}
`;
const NATIVE_READ_VALUE_PS=NATIVE_TEXT_VALUE_PS+String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Empir3NativeValue {
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,UIntPtr size,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
 public static string ReadText(IntPtr h) {
  if(h==IntPtr.Zero||(GetWindowLong(h,-16)&0x20)!=0)return null;
  var text=new StringBuilder(32768);UIntPtr result;
  if(SendMessageTimeout(h,13,(UIntPtr)text.Capacity,text,2,250,out result)==IntPtr.Zero)return null;
  return text.ToString();
 }
}
"@
`;
const NATIVE_LEGACY_PS = String.raw`
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies Accessibility @"
using System;
using System.Runtime.InteropServices;
using Accessibility;
public static class Empir3LegacyControl {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [DllImport("oleacc.dll")] static extern int AccessibleObjectFromPoint(POINT point, out IAccessible accessible, [MarshalAs(UnmanagedType.Struct)] out object child);
 [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint objectId,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
 public static bool? Read(IntPtr hwnd,string operation) {
  if(hwnd==IntPtr.Zero)return null;
  var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); IAccessible a;
  if(AccessibleObjectFromWindow(hwnd,0xFFFFFFFC,ref iid,out a)!=0||a==null)return null;
  try {
   int state=Convert.ToInt32(a.get_accState(0)),role=Convert.ToInt32(a.get_accRole(0));
   if(operation=="checked")return role==44?(bool?)((state&16)!=0):null;
   if(operation=="expanded")return (state&1536)!=0?(bool?)((state&512)!=0):null;
   return null;
  } finally {if(Marshal.IsComObject(a))Marshal.ReleaseComObject(a);}
 }
 public static bool Set(int x,int y,string operation,bool desired) {
  POINT p=new POINT();p.x=x;p.y=y;IAccessible a;object child;
  int hr=AccessibleObjectFromPoint(p,out a,out child);if(hr!=0||a==null)throw new Exception("unsupported_control: no accessible control at the observed point.");
  try {
   int before=Convert.ToInt32(a.get_accState(child)),role=Convert.ToInt32(a.get_accRole(child));
   int mask=operation=="check"?16:operation=="expand"?512:2;
   if(operation=="check"&&role!=44)throw new Exception("unsupported_control: no checkbox state exposed.");
   if(operation=="expand"&&(before&1536)==0)throw new Exception("unsupported_control: no expansion state exposed.");
   if(operation=="select")a.accSelect(2,child);
   else if(((before&mask)!=0)!=desired)a.accDoDefaultAction(child);
   return ((Convert.ToInt32(a.get_accState(child))&mask)!=0)==(operation=="select"||desired);
  } finally { if(Marshal.IsComObject(a))Marshal.ReleaseComObject(a); }
 }
}
"@
`;
const NATIVE_SEMANTIC_PS = NATIVE_LEGACY_PS + String.raw`
$node=$global:Empir3DesktopRefs[$control.target.ref]
[Empir3NativeInput]::Check([IntPtr]::new([long]$control.target.window.handle))
if (!$node -or $node.Current.IsPassword) { throw 'unsupported_control: semantic readback requires a non-password accessible control.' }
$operation=[string]$control.operation
$verified=$false
if ($operation -eq 'fill') {
 $value=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($control.encoded))
 $pattern=$null
 try { $pattern=$node.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern) } catch {}
 if ($pattern -and $pattern.Current.IsReadOnly) { throw 'unsupported_control: field is read-only.' }
 if ($control.target.role -notin @('Edit','Document')) { throw 'unsupported_control: choose an editable text field.' }
 $empir3InputStarted=$true
 if (([Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',') -ne $control.target.runtimeId) { $node.SetFocus() }
 [Empir3NativeInput]::Check([IntPtr]::new([long]$control.target.window.handle))
 if (([Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',') -ne $control.target.runtimeId) { throw 'stale_observation: field focus was refused; no text was sent.' }
 if ($control.target.role -eq 'Document' -and $pattern) {
  $pattern.SetValue($value)
  $verified=(ConvertTo-Empir3TextValue $pattern.Current.Value $control.target.role) -ceq (ConvertTo-Empir3TextValue $value $control.target.role)
 }
 else {
  if ($control.target.role -ne 'Edit') { throw 'unsupported_control: field is not editable.' }
  # Ordinary input notifies dialog/combobox change handlers. ValuePattern can
  # echo SetValue while the application still keeps the previous filename.
  [Empir3NativeInput]::Keys([int[]]@(17,65),[IntPtr]::new([long]$control.target.window.handle))
  if($value.Length -eq 0){[Empir3NativeInput]::Keys([int[]]@(8),[IntPtr]::new([long]$control.target.window.handle))}
  else{[Empir3NativeInput]::Text($value,[IntPtr]::new([long]$control.target.window.handle)) | Out-Null}
  # SendInput returns before the application's edit handler has necessarily
  # processed the text. Poll the same observed control; never send it again.
  $readbackUntil=[DateTime]::UtcNow.AddMilliseconds([Math]::Max(0,[int]$control.readbackTimeoutMs))
  do {
   [Empir3NativeInput]::Check([IntPtr]::new([long]$control.target.window.handle))
   if($node.Current.IsPassword){throw 'unsupported_control: field became protected after input.'}
   $pattern=$null;try{$pattern=$node.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)}catch{}
   $actual=if($pattern){$pattern.Current.Value}else{[Empir3NativeValue]::ReadText([IntPtr]::new($node.Current.NativeWindowHandle))}
   $verified=$null -ne $actual -and $actual -ceq $value
   if($verified -or [DateTime]::UtcNow -ge $readbackUntil){break}
   Start-Sleep -Milliseconds 20
  } while([DateTime]::UtcNow -le $readbackUntil)
 }
} elseif ($operation -eq 'check') {
 $empir3InputStarted=$true
 $pattern=$null;try{$pattern=$node.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)}catch{}
 if($pattern){
  $desired=if ($control.value) { [Windows.Automation.ToggleState]::On } else { [Windows.Automation.ToggleState]::Off }
  for($i=0;$i -lt 2 -and $pattern.Current.ToggleState -ne $desired;$i++) {
   [Empir3NativeInput]::Check([IntPtr]::new([long]$control.target.window.handle));$pattern.Toggle()
  }
  $verified=$pattern.Current.ToggleState -eq $desired
 }else{
  $verified=[Empir3LegacyControl]::Set($control.target.bounds.cx,$control.target.bounds.cy,'check',[bool]$control.value)
 }
} elseif ($operation -eq 'expand') {
 $empir3InputStarted=$true
 $pattern=$null;try{$pattern=$node.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)}catch{}
 if($pattern){
  if($control.value) { $pattern.Expand();$verified=$pattern.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded }
  else { $pattern.Collapse();$verified=$pattern.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Collapsed }
 }else{
  $verified=[Empir3LegacyControl]::Set($control.target.bounds.cx,$control.target.bounds.cy,'expand',[bool]$control.value)
 }
} elseif ($operation -eq 'select') {
 $empir3InputStarted=$true
 $pattern=$null;try{$pattern=$node.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)}catch{}
 if($pattern){$pattern.Select();$verified=$pattern.Current.IsSelected}
  else{$verified=[Empir3LegacyControl]::Set($control.target.bounds.cx,$control.target.bounds.cy,'select',$true)}
} else { throw 'Unsupported native semantic operation.' }
[pscustomobject]@{success=$true;dispatched=$true;verified=$verified;operation=$operation;windowHandle=$control.target.window.handle;note='Verification reads the accessible control state; edit fields get a bounded settling check. Use expect for later application outcomes.'} | ConvertTo-Json -Compress
`;
module.exports={NATIVE_SEMANTIC_PS,NATIVE_READ_VALUE_PS,NATIVE_LEGACY_PS,NATIVE_TEXT_VALUE_PS};
