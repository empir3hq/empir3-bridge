import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {MAGNIFIER_STATE_PS,magnifierAbsenceVerified} from '../src/windows-magnifier.js';
const absent={processes:[],windows:[],processAbsent:true,magUIAbsent:true,lensAbsent:true};
function readState(){
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(MAGNIFIER_STATE_PS,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());
}
test('Magnifier absence requires process and both window checks, never missing data',()=>{
 assert.equal(magnifierAbsenceVerified(absent),true);
 for(const state of [null,{}, {...absent,processes:[{pid:42}]},{...absent,windows:[{className:'MagUIClass'}]},{...absent,windows:[{className:'ScreenMagnifierWindow'}]}])assert.equal(magnifierAbsenceVerified(state),false);
 for(const key of ['processAbsent','magUIAbsent','lensAbsent'])for(const value of [false,undefined])assert.equal(magnifierAbsenceVerified({...absent,[key]:value}),false);
});

test('actual app kill handler refuses a lingering window or unavailable post-stop query',async()=>{
 const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function handleAppCommand('),source.indexOf('async function handleClipboardCommand('));
 const code=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 for(const state of [absent,null,{...absent,windows:[{className:'ScreenMagnifierWindow'}],lensAbsent:false}]){
  let checks=0;const context=vm.createContext({hasBridgePermission:()=>true,PROTECTED_PROCESSES:new Set(),MAGNIFIER_STATE_PS:'MAGNIFIER_QUERY',magnifierAbsenceVerified,
   runPowerShellJson:async script=>{if(script==='MAGNIFIER_QUERY'){checks++;return state}return {Id:42,ProcessName:'magnify'}},stopProcessVerified:async()=>({success:true})});
  vm.runInContext(code,context);const result=await context.handleAppCommand('kill',{pid:42});
  assert.equal(checks,1);assert.equal(result.success,state===absent);assert.equal(result.verifiedExited,true);assert.equal(result.visualVerificationRequired,true);
  if(state!==absent)assert.match(result.error,/absence was not verified/);
 }
});
test('actual Windows Magnifier query returns complete consistent evidence without changing state',{skip:process.platform!=='win32'},()=>{
 const state=readState();
 assert.ok(Array.isArray(state.processes));assert.ok(Array.isArray(state.windows));
 assert.equal(state.processAbsent,state.processes.length===0);
 assert.equal(state.magUIAbsent,!state.windows.some(w=>w.className==='MagUIClass'));
 assert.equal(state.lensAbsent,!state.windows.some(w=>w.className==='ScreenMagnifierWindow'));
});

test('actual lingering top-level and child Magnifier window classes prevent false absence',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const fixture=String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E3MagnifierFixture {
 public delegate IntPtr WndProc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Class {public uint style; public WndProc proc; public int cbClsExtra; public int cbWndExtra; public IntPtr instance,icon,cursor,background; public string menu; public string name;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref Class cls);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string name,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h,uint m,IntPtr w,IntPtr l);
 static WndProc handler=DefWindowProc;
 public static long Create(){
  var top=new Class {proc=handler,name="MagUIClass"}; var child=new Class {proc=handler,name="ScreenMagnifierWindow"};
  if(RegisterClass(ref top)==0||RegisterClass(ref child)==0)throw new Exception("fixture class registration failed");
  var h=CreateWindowEx(0,top.name,"Bridge invisible acceptance fixture",0,0,0,20,20,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
  if(h==IntPtr.Zero||CreateWindowEx(0,child.name,"Bridge invisible child",0x40000000,0,0,10,10,h,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero)==IntPtr.Zero)throw new Exception("fixture window creation failed");
  return h.ToInt64();
 }
}
"@
[Console]::WriteLine([E3MagnifierFixture]::Create())
Start-Sleep -Seconds 15
`;
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixture,'utf16le').toString('base64')],{windowsHide:true});let errors='';child.stderr.on('data',d=>errors+=d);
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture did not start: '+errors)),7000);child.stdout.once('data',d=>{clearTimeout(timer);Number(d.toString().trim())>0?resolve():reject(Error(d.toString()))});child.once('error',e=>{clearTimeout(timer);reject(e)});});
  const state=readState(),own=state.windows.filter(w=>w.pid===child.pid);
  assert.deepEqual(own.map(w=>w.className).sort(),['MagUIClass','ScreenMagnifierWindow']);
  assert.ok(own.every(w=>!w.visible),'fixture never appears or takes focus');
  assert.equal(state.magUIAbsent,false);assert.equal(state.lensAbsent,false);assert.equal(magnifierAbsenceVerified(state),false);
 }finally{const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}
 assert.equal(readState().windows.some(w=>w.pid===child.pid),false,'owned fixture windows are gone');
});
