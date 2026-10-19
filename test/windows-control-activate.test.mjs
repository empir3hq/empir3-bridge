import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVATE_WINDOW_PS} from '../src/windows-control-activate.js';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {DEFAULT_CONTROL_LIMITS} from '../src/control-limits.js';
import {NATIVE_INPUT_PS} from '../src/windows-native-input.js';

// Compile and run the production orchestration with deterministic Win32 fakes.
// No UI, pointer, keystroke or application is touched by these unit tests.
const implementations={
 IsWindow:'return h.ToInt64()==42;',
 IsWindowEnabled:'return TestMode!="blocked";',
 IsIconic:'return TestMode=="minimized";',
 ShowWindowAsync:'Restored=true;return true;',
 SetForegroundWindow:'if(TestMode=="direct")Foreground=h;return Foreground==h;',
 GetForegroundWindow:'return Foreground;',
 GetWindowThreadProcessId:'pid=(TestMode=="identity"&&Moved)?8u:7u;return 9;',
 GetWindowRect:'r=new RECT();r.Left=100;r.Top=100;r.Right=900;r.Bottom=600;if(TestMode=="moved"&&Moved)r.Left++;return true;',
 WindowFromPoint:'return new IntPtr(TestMode=="covered"?99:42);',
 GetAncestor:'return TestMode=="ownedTopmost"&&h.ToInt64()==88?new IntPtr(42):h;',
 GetDpiForWindow:'return 96;',
 GetSystemMetricsForDpi:'return index==4?23:8;',
 SetWindowPos:'Raised=true;if(after.ToInt64()==-1)Promotions++;if(after.ToInt64()==-2)Demotions++;return true;',
 GetWindowStyle:'return TestMode=="topmost"||TestMode=="ownedTopmost"&&h.ToInt64()==88?8:0;',
 EnumWindows:'if(TestMode=="ownedTopmost")visitor(new IntPtr(88),state);return true;',
 GetLastInputInfo:'info.time=0;return true;',
 GetDoubleClickTime:'return 0;',
 SendMessageTimeout:'LargestWait=Math.Max(LargestWait,timeout);result=UIntPtr.Zero;if(TestMode=="hung")return IntPtr.Zero;if(msg==0x84){HitTests++;result=(UIntPtr)(TestMode=="buttons"?20u:TestMode=="content"?1u:TestMode=="coveredAfterMove"&&Moved?1u:2u);}return new IntPtr(1);',
};
let fake=ACTIVATE_WINDOW_PS.replace(/\[DllImport\([^\n]+\)\] ([^\n]+);/g,(_all,signature)=>{
 const name=/\s(\w+)\(/.exec(signature)?.[1];assert.ok(implementations[name],name);
 return signature.replace('extern ','')+'{'+implementations[name]+'}';
});

test('activation click batches down/up and only releases after partial input',{skip:process.platform!=='win32'},async()=>{
 const fakeInput=NATIVE_INPUT_PS.replace(/\[DllImport\("user32.dll", SetLastError=true\)\] static extern uint SendInput\(uint count, INPUT\[\] inputs, int size\);/,String.raw`
 public static int Accepted=2,Calls;
 public static string Events="";
 static uint SendInput(uint count,INPUT[] inputs,int size){Calls++;foreach(var e in inputs)Events+=e.data.mouse.dwFlags+",";return Calls==1?(uint)Accepted:count;}
 `);
 assert.doesNotMatch(fakeInput,/extern uint SendInput/);
 const worker=createWindowsControlWorker({initializeScript:fakeInput});
 try{
  for(const accepted of [2,1,0]){
   const result=await worker.run(fakeInput+String.raw`
 [Empir3NativeInput]::Accepted=[int]$control.accepted
 [Empir3NativeInput]::Calls=0;[Empir3NativeInput]::Events=''
 $failure=''
 try{[Empir3NativeInput]::Click(2,4)}catch{$failure=$_.Exception.Message}
 @{calls=[Empir3NativeInput]::Calls;events=[Empir3NativeInput]::Events;error=$failure}|ConvertTo-Json -Compress
 `,8000,{accepted});
   assert.equal(result.calls,accepted===2?1:2);
   assert.equal(result.events,accepted===2?'2,4,':'2,4,4,');
   if(accepted===2)assert.equal(result.error,'');else assert.match(result.error,/input_incomplete/);
  }
 }finally{worker.stop();}
});
assert.doesNotMatch(fake,/DllImport|AttachThreadInput/);
fake=fake.replace('static uint selectedPid;',`public static string TestMode="";
 public static bool Moved,Restored,Raised;
 public static int Clicks,HitTests,Promotions,Demotions;
 public static uint LargestWait;
 public static IntPtr Foreground=new IntPtr(99);
 public static int CursorX,CursorY;
 static uint selectedPid;`);
const native=String.raw`Add-Type @"
using System;
public static class Empir3NativeInput {
 public struct POINT {public int X,Y;}
 public static IntPtr RequiredWindow;
 public static void Check(IntPtr h){if(Empir3ActivateWindow.TestMode=="paused"||(Empir3ActivateWindow.TestMode=="pauseAfterMove"&&Empir3ActivateWindow.Moved))throw new Exception("control_paused");}
 public static short GetAsyncKeyState(int key){return (short)(Empir3ActivateWindow.TestMode=="held"&&key==1?-32768:0);}
 public static void Move(int x,int y,int duration,IntPtr h){Empir3ActivateWindow.Moved=true;Empir3ActivateWindow.CursorX=x;Empir3ActivateWindow.CursorY=y;}
 public static bool GetCursorPos(out POINT p){p=new POINT();p.X=Empir3ActivateWindow.CursorX+(Empir3ActivateWindow.TestMode=="takeover"?10:0);p.Y=Empir3ActivateWindow.CursorY;return true;}
 public static void Click(uint down,uint up){Empir3ActivateWindow.Clicks++;if(Empir3ActivateWindow.TestMode!="refused")Empir3ActivateWindow.Foreground=new IntPtr(42);}
}
"@
`;
// Compile both fake classes in one assembly so they can reference each other.
const boundary=fake.indexOf('[Empir3ActivateWindow]::AckMs=');
const classOnly=fake.slice(0,boundary);
const combined=classOnly.replace('public static class Empir3ActivateWindow',native.slice(native.indexOf('public static class'),native.lastIndexOf('"@')).trim()+'\npublic static class Empir3ActivateWindow');
const reset=String.raw`
[Empir3ActivateWindow]::TestMode=[string]$control.mode
[Empir3ActivateWindow]::Moved=$false
[Empir3ActivateWindow]::Restored=$false
[Empir3ActivateWindow]::Raised=$false
[Empir3ActivateWindow]::Clicks=0
[Empir3ActivateWindow]::HitTests=0
[Empir3ActivateWindow]::Promotions=0
[Empir3ActivateWindow]::Demotions=0
[Empir3ActivateWindow]::LargestWait=0
[Empir3ActivateWindow]::Foreground=[IntPtr]99
`;
const script=combined+reset+fake.slice(boundary);
const read=combined+String.raw`
@{clicks=[Empir3ActivateWindow]::Clicks;hits=[Empir3ActivateWindow]::HitTests;wait=[Empir3ActivateWindow]::LargestWait;restored=[Empir3ActivateWindow]::Restored;raised=[Empir3ActivateWindow]::Raised;promotions=[Empir3ActivateWindow]::Promotions;demotions=[Empir3ActivateWindow]::Demotions}|ConvertTo-Json -Compress
`;
test('verified caption fallback, exact foreground receipts and refusal paths',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker({initializeScript:combined});
 try{
  for(const mode of ['direct','caption','minimized','topmost','ownedTopmost']){
   const result=await worker.run(script,8000,{mode,windowHandle:42,controlLimits:DEFAULT_CONTROL_LIMITS});
   assert.equal(result.verified,true);assert.equal(result.windowHandle,42);
   const stats=await worker.run(read);
   assert.equal(stats.clicks,mode==='direct'?0:1);
   assert.equal(result.method,mode==='direct'?'foreground-request':'verified-caption-click');
   if(mode==='minimized')assert.equal(stats.restored,true);
   assert.equal(stats.promotions,mode==='direct'||mode==='ownedTopmost'?0:1,mode);
   assert.equal(stats.demotions,mode==='caption'||mode==='minimized'?1:0,mode);
  }
  const errors={hung:'activation_unresponsive',blocked:'activation_blocked',buttons:'activation_caption_unavailable',content:'activation_caption_unavailable',covered:'activation_caption_unavailable',moved:'target_changed',identity:'target_changed',coveredAfterMove:'target_changed',takeover:'input_cancelled',paused:'control_paused',pauseAfterMove:'control_paused',held:'input_busy'};
  for(const [mode,error] of Object.entries(errors)){
   await assert.rejects(worker.run(script,8000,{mode,windowHandle:42,controlLimits:{...DEFAULT_CONTROL_LIMITS,nativeActivationAckMs:50,nativeActivationSearchPoints:6}}),new RegExp(error),mode);
   const stats=await worker.run(read);assert.equal(stats.clicks,0,mode);assert.ok(stats.hits<=6,mode);assert.ok(stats.wait<=50,mode);
  }
  await assert.rejects(worker.run(script,8000,{mode:'refused',windowHandle:42,controlLimits:DEFAULT_CONTROL_LIMITS}),/activation_refused/);
  assert.equal((await worker.run(read)).clicks,1,'Uncertain activation must never replay the click');
 }finally{worker.stop();}
});
