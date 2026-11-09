import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {normalizeWindowBounds,WINDOW_RESIZE_PS} from '../src/windows-window-resize.js';

test('window dimensions must be finite, positive and representable before dispatch',()=>{
 const current={left:-1920,top:20,width:800,height:600};
 assert.deepEqual(normalizeWindowBounds({x:-1900.4,width:700.8},current),{x:-1900,y:20,width:701,height:600});
 for(const value of [NaN,Infinity,-Infinity,'bad',2147483648])assert.throws(()=>normalizeWindowBounds({x:value},current),/invalid_window_bounds/);
 for(const value of [0,-1,0.1])assert.throws(()=>normalizeWindowBounds({width:value},current),/invalid_window_bounds/);
 assert.throws(()=>normalizeWindowBounds({x:2147483640,width:100},current),/invalid_window_bounds/);
});

const fixture=String.raw`
Add-Type @"
using System;using System.Runtime.InteropServices;
public static class ResizeFixture {
 public delegate IntPtr WndProc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Class {public uint style;public WndProc proc;public int cbClsExtra,cbWndExtra;public IntPtr instance,icon,cursor,background;public string menu,name;}
 [StructLayout(LayoutKind.Sequential)] struct Position {public IntPtr h,after;public int x,y,cx,cy;public uint flags;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref Class cls);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string name,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 static IntPtr Proc(IntPtr h,uint m,IntPtr w,IntPtr l){
  if(m==0x46){var p=(Position)Marshal.PtrToStructure(l,typeof(Position));if(p.cx==333){p.cx=444;Marshal.StructureToPtr(p,l,false);}}
  return DefWindowProc(h,m,w,l);
 }
 static WndProc handler=Proc;
 public static long Create(){var cls=new Class{proc=handler,name="E3InvisibleResizeFixture"};RegisterClass(ref cls);var h=CreateWindowEx(0,cls.name,"Bridge resize fixture",0x80000000,10,20,200,150,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);if(h==IntPtr.Zero)throw new Exception("fixture creation failed");return h.ToInt64();}
}
"@
$global:ResizeFixtureHandle=[ResizeFixture]::Create()
function global:Get-ResizeForeground { [ResizeFixture]::GetForegroundWindow().ToInt64() }
function global:Remove-ResizeFixture { [ResizeFixture]::DestroyWindow([IntPtr]::new($global:ResizeFixtureHandle)) }
@{handle=$global:ResizeFixtureHandle;foreground=[ResizeFixture]::GetForegroundWindow().ToInt64()}|ConvertTo-Json -Compress
`;

test('real invisible native window resizes, reports app constraints, rejects stale identity and never takes focus',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker();
 try{
  const initial=await worker.run(fixture,10000,{});
  const base={windowHandle:initial.handle,windowTitle:'Bridge resize fixture'};
  const requested={x:-500,y:75,width:700,height:350};
  const moved=await worker.run(WINDOW_RESIZE_PS,8000,{...base,requested});
  assert.equal(moved.success,true);assert.equal(moved.verified,true);assert.deepEqual(moved.actual,{left:-500,top:75,width:700,height:350});
  const constrained=await worker.run(WINDOW_RESIZE_PS,8000,{...base,requested:{...requested,width:333}});
  assert.equal(constrained.success,false);assert.equal(constrained.dispatched,true);assert.equal(constrained.actual.width,444);assert.equal(constrained.code,'window_resize_unverified');
  await assert.rejects(worker.run(WINDOW_RESIZE_PS,8000,{...base,windowTitle:'changed',requested}),/target_changed/);
  await assert.rejects(worker.run(WINDOW_RESIZE_PS,8000,{...base,windowHandle:0,requested}),/target_changed/);
  const state=await worker.run('@{foreground=(Get-ResizeForeground)}|ConvertTo-Json -Compress',2000,{});
  assert.equal(state.foreground,initial.foreground);
 }finally{worker.stop()}
});
