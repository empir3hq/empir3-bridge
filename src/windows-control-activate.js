'use strict';
const {DEFAULT_CONTROL_LIMITS}=require('./control-limits.js');
const ACTIVATE_WINDOW_PS=String.raw`
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Empir3ActivateWindow {
 public static int AckMs=${DEFAULT_CONTROL_LIMITS.nativeActivationAckMs};
 public static int SearchPoints=${DEFAULT_CONTROL_LIMITS.nativeActivationSearchPoints};
 [StructLayout(LayoutKind.Sequential)] public struct POINT {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO {public uint size,time;}
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int mode);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index,uint dpi);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowStyle(IntPtr h,int index);
 delegate bool WindowVisitor(IntPtr h,IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor,IntPtr state);
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
 [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
 static uint selectedPid;
 static RECT selectedRect;
 public static uint LastInput(){var i=new LASTINPUTINFO();i.size=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO));if(!GetLastInputInfo(ref i))throw new Exception("input_failed: cannot check recent user input.");return i.time;}
 public static int ClickGap(uint last){uint elapsed=unchecked((uint)Environment.TickCount-last);return (int)Math.Max(0L,(long)GetDoubleClickTime()-elapsed);}
 static void Identity(IntPtr h){uint pid;if(!IsWindow(h)||GetWindowThreadProcessId(h,out pid)==0||pid!=selectedPid)throw new Exception("target_changed: observe the selected window again.");if(!IsWindowEnabled(h))throw new Exception("activation_blocked: select the application's open dialog instead.");}
 public static void Acknowledge(IntPtr h){UIntPtr result;if(SendMessageTimeout(h,0,UIntPtr.Zero,IntPtr.Zero,0x23,(uint)AckMs,out result)==IntPtr.Zero)throw new Exception("activation_unresponsive: selected window did not respond; inspect fresh state before retrying.");}
 static bool CanTemporarilyRaise(IntPtr h){
  // Promoting/demoting an owner also changes owned windows. Preserve existing
  // topmost dialogs and never promote an owned window independently.
  if(GetAncestor(h,3)!=h)return false;
  bool safe=true;
  bool scanned=EnumWindows(delegate(IntPtr other,IntPtr state){if(other!=h&&GetAncestor(other,3)==h&&(GetWindowStyle(other,-20)&8)!=0)safe=false;return true;},IntPtr.Zero);
  return scanned&&safe;
 }
 public static bool Prepare(IntPtr h){
  if(!IsWindow(h)||GetWindowThreadProcessId(h,out selectedPid)==0)throw new Exception("target_closed: observe the window list again.");
  Identity(h);
  if(GetForegroundWindow()==h)return true;
  if(IsIconic(h))ShowWindowAsync(h,9);
  Acknowledge(h);Identity(h);
  SetForegroundWindow(h);Acknowledge(h);
  if(GetForegroundWindow()==h)return true;
  // Raise asynchronously without joining the other application's input queue.
  bool topmost=(GetWindowStyle(h,-20)&8)!=0;
  if(topmost){SetWindowPos(h,new IntPtr(-1),0,0,0,0,0x4213);}
  else if(CanTemporarilyRaise(h)){
   // Pair the asynchronous requests immediately: never leave a temporary
   // topmost style in place while waiting, searching or moving the pointer.
   try{SetWindowPos(h,new IntPtr(-1),0,0,0,0,0x4213);}
   finally{SetWindowPos(h,new IntPtr(-2),0,0,0,0,0x4213);}
  }
  else{SetWindowPos(h,IntPtr.Zero,0,0,0,0,0x4213);}
  Acknowledge(h);Identity(h);
  if(((GetWindowStyle(h,-20)&8)!=0)!=topmost)throw new Exception("activation_refused: window stacking state did not restore; inspect the window before retrying.");
  if(!GetWindowRect(h,out selectedRect))throw new Exception("target_closed: window geometry is unavailable.");
  return GetForegroundWindow()==h;
 }
 static bool Caption(IntPtr h,POINT p,int timeout){
  if(p.X<short.MinValue||p.X>short.MaxValue||p.Y<short.MinValue||p.Y>short.MaxValue)return false;
  if(GetAncestor(WindowFromPoint(p),2)!=h)return false;
  long packed=unchecked((int)(((uint)(ushort)p.Y<<16)|(ushort)p.X));UIntPtr result;
  if(SendMessageTimeout(h,0x84,UIntPtr.Zero,new IntPtr(packed),0x23,(uint)Math.Max(1,timeout),out result)==IntPtr.Zero)throw new Exception("activation_unresponsive: caption hit test did not respond.");
  return result.ToUInt64()==2; // HTCAPTION only, never content or window buttons.
 }
 public static POINT FindCaption(IntPtr h){
  Identity(h);var watch=Stopwatch.StartNew();uint dpi=GetDpiForWindow(h);if(dpi==0)dpi=96;
  int frame=GetSystemMetricsForDpi(33,dpi)+GetSystemMetricsForDpi(92,dpi),caption=GetSystemMetricsForDpi(4,dpi);
  int columns=Math.Max(1,SearchPoints/3),width=selectedRect.Right-selectedRect.Left;
  for(int row=0;row<3;row++)for(int col=0;col<columns;col++){
   int remaining=AckMs-(int)watch.ElapsedMilliseconds;if(remaining<=0)throw new Exception("activation_caption_unavailable: no safe title-bar point was found within the search limit.");
   POINT p=new POINT();p.X=selectedRect.Left+(int)((long)(col+1)*width/(columns+1));p.Y=selectedRect.Top+frame+caption*(row+1)/4;
   if(Caption(h,p,remaining))return p;
  }
  throw new Exception("activation_caption_unavailable: no unobscured title bar is available; select the window locally, then observe again.");
 }
 public static void ValidateCaption(IntPtr h,POINT p){
  Identity(h);RECT r;if(!GetWindowRect(h,out r)||r.Left!=selectedRect.Left||r.Top!=selectedRect.Top||r.Right!=selectedRect.Right||r.Bottom!=selectedRect.Bottom)throw new Exception("target_changed: window moved before activation; observe again.");
  if(!Caption(h,p,AckMs))throw new Exception("target_changed: activation point is now covered or is no longer a title bar.");
 }
}
"@
[Empir3ActivateWindow]::AckMs=if($null -ne $control.controlLimits.nativeActivationAckMs){$control.controlLimits.nativeActivationAckMs}else{${DEFAULT_CONTROL_LIMITS.nativeActivationAckMs}}
[Empir3ActivateWindow]::SearchPoints=if($null -ne $control.controlLimits.nativeActivationSearchPoints){$control.controlLimits.nativeActivationSearchPoints}else{${DEFAULT_CONTROL_LIMITS.nativeActivationSearchPoints}}
# Activation explicitly changes foreground; all other input guards remain.
[Empir3NativeInput]::RequiredWindow=[IntPtr]::Zero
[Empir3NativeInput]::Check([IntPtr]::Zero)
$h=[IntPtr]::new([long]$control.windowHandle)
$lastInput=[Empir3ActivateWindow]::LastInput()
$method='foreground-request';$clicked=$false
if(-not [Empir3ActivateWindow]::Prepare($h)){
 $point=[Empir3ActivateWindow]::FindCaption($h)
 # Do not turn a preceding user caption click into a double-click/maximize.
 $gap=[Empir3ActivateWindow]::ClickGap($lastInput)
 if($gap -gt 0){[Threading.Thread]::Sleep($gap)}
 [Empir3NativeInput]::Check([IntPtr]::Zero)
 if([Empir3ActivateWindow]::LastInput() -ne $lastInput){throw 'input_cancelled: user input changed during activation preparation.'}
 foreach($key in @(1,2,4,5,6,16,17,18,91,92)){if(([Empir3NativeInput]::GetAsyncKeyState($key) -band 0x8000) -ne 0){throw 'input_busy: release mouse buttons and modifiers before activation.'}}
 [Empir3ActivateWindow]::ValidateCaption($h,$point)
 [Empir3NativeInput]::Move($point.X,$point.Y,100,[IntPtr]::Zero)
 [Empir3NativeInput]::Check([IntPtr]::Zero)
 [Empir3ActivateWindow]::ValidateCaption($h,$point)
 $cursor=[Empir3NativeInput+POINT]::new()
 if(-not [Empir3NativeInput]::GetCursorPos([ref]$cursor) -or $cursor.X -ne $point.X -or $cursor.Y -ne $point.Y){throw 'input_cancelled: cursor moved before activation click.'}
 foreach($key in @(1,2,4,5,6,16,17,18,91,92)){if(([Empir3NativeInput]::GetAsyncKeyState($key) -band 0x8000) -ne 0){throw 'input_busy: input changed before activation click.'}}
 if([Empir3ActivateWindow]::GetForegroundWindow() -ne $h){
  [Empir3NativeInput]::Click(2,4)
  $clicked=$true;$method='verified-caption-click'
 }
 [Empir3ActivateWindow]::Acknowledge($h)
}
if([Empir3ActivateWindow]::GetForegroundWindow() -ne $h){throw 'activation_refused: foreground did not match the selected window; inspect fresh state before retrying.'}
[pscustomobject]@{success=$true;activated=$true;verified=$true;windowHandle=$h.ToInt64();method=$method;clicked=$clicked;next='Observe again before input.'}|ConvertTo-Json -Compress
`;
module.exports={ACTIVATE_WINDOW_PS};
