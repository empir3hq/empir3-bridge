// Real Win32 activation acceptance using disposable windows, never user documents.
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {createWindowsControlWorker} from '../src/windows-control-worker.js';
import {NATIVE_INPUT_PS} from '../src/windows-native-input.js';
import {ACTIVATE_WINDOW_PS} from '../src/windows-control-activate.js';
import {getControlLimits} from '../src/control-limits.js';
if(process.platform!=='win32'||!process.argv.includes('--run-interactive')){
 console.log('Pass --run-interactive on Windows for disposable native activation acceptance.');process.exit(0);
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const state=mkdtempSync(join(tmpdir(),'empir3-activation-acceptance-'));
const ps=String.raw`
param([string]$State)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FixtureNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr h);
}
"@
[FixtureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null
$target=New-Object Windows.Forms.Form
$target.Text='Empir3 disposable activation target'
$target.StartPosition='Manual';$target.Location=New-Object Drawing.Point(400,300);$target.Size=New-Object Drawing.Size(600,350)
$label=New-Object Windows.Forms.Label;$label.Text='Acceptance fixture - no user document';$label.Dock='Fill';$target.Controls.Add($label)
$cover=New-Object Windows.Forms.Form
$cover.Text='Empir3 disposable covering window'
$cover.StartPosition='Manual';$cover.Location=New-Object Drawing.Point(300,200);$cover.Size=New-Object Drawing.Size(800,550)
$script:clicks=0;$script:keys=0;$script:seq='ready'
$target.Add_MouseDown({$script:clicks++});$label.Add_MouseDown({$script:clicks++});$target.Add_KeyDown({$script:keys++})
function Proof {
 $proof=@{seq=$script:seq;target=$target.Handle.ToInt64();cover=$cover.Handle.ToInt64();foreground=[FixtureNative]::GetForegroundWindow().ToInt64();clicks=$script:clicks;keys=$script:keys;topmost=$target.TopMost;windowState=[string]$target.WindowState;bounds=@{x=$target.Left;y=$target.Top;width=$target.Width;height=$target.Height}}
 [IO.File]::WriteAllText((Join-Path $State 'proof.json'),($proof|ConvertTo-Json -Depth 4 -Compress))
}
$timer=New-Object Windows.Forms.Timer;$timer.Interval=25
$timer.Add_Tick({
 $path=Join-Path $State 'command.json'
 if(!(Test-Path -LiteralPath $path)){return}
 $command=[IO.File]::ReadAllText($path)|ConvertFrom-Json
 [IO.File]::Delete($path);$script:seq=$command.seq
 switch($command.action){
  'cover' {$cover.Show();$cover.Activate();[FixtureNative]::SetForegroundWindow($cover.Handle)|Out-Null}
  'minimize' {$target.WindowState='Minimized';$cover.Show();$cover.Activate();[FixtureNative]::SetForegroundWindow($cover.Handle)|Out-Null}
  'hang' {Proof;[Threading.Thread]::Sleep(4000)}
  'close' {$cover.Close();$target.Close();return}
 }
 Proof
})
$target.Add_Shown({$cover.Show();$cover.Activate();$timer.Start();Proof})
[Windows.Forms.Application]::Run($target)
`;
writeFileSync(join(state,'fixture.ps1'),ps);
const child=spawn('powershell.exe',['-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',join(state,'fixture.ps1'),state],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const source=readFileSync(join(root,'src/server.ts'),'utf8');
const tree=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true);
const declaration=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='desktopPreamble');
const preamble=vm.runInNewContext(ts.transpileModule(declaration.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';desktopPreamble;');
const worker=createWindowsControlWorker({initializeScript:preamble()+NATIVE_INPUT_PS});
const results=[];
const pausePath=join(process.env.USERPROFILE,'.empir3-bridge/runtime/feedback/control-paused');
const read=()=>{try{return JSON.parse(readFileSync(join(state,'proof.json'),'utf8'));}catch{return null;}};
async function waitFor(predicate){const until=Date.now()+12000;while(Date.now()<until){const p=read();if(p&&predicate(p))return p;if(child.exitCode!==null)throw Error('Fixture exited: '+output);await delay(30);}throw Error('Fixture acknowledgement timed out: '+output);}
let serial=0;
async function command(action){const seq=String(++serial);writeFileSync(join(state,'command.json'),JSON.stringify({action,seq}));return waitFor(p=>p.seq===seq);}
async function activate(proof,label){
 if(existsSync(pausePath))throw Error('Bridge control is paused');
 const start=performance.now();
 try{const result=await worker.run(preamble()+NATIVE_INPUT_PS+ACTIVATE_WINDOW_PS,getControlLimits().nativeQuickTimeoutMs,{windowHandle:proof.target,controlLimits:getControlLimits(),pausePath});results.push({label,ms:Math.round(performance.now()-start),result});return result;}
 catch(error){results.push({label,ms:Math.round(performance.now()-start),error:error.message});throw error;}
}
try{
 const initial=await waitFor(p=>p.seq==='ready');
 await worker.run('1'); // Finish worker initialization before measuring action deadlines.
 for(const action of ['cover','minimize','cover']){
  let before=await command(action);
  await activate({...before,target:before.cover},'setup-cover');
  worker.stop();await worker.run('1');
  before=await command('proof');assert.equal(before.foreground,before.cover,'Covering fixture must really be foreground');
  const result=await activate(before,action);assert.equal(result.verified,true);
  const after=await command('proof');assert.equal(after.foreground,after.target);assert.equal(after.windowState,'Normal');assert.equal(after.topmost,false);
  assert.deepEqual(after.bounds,initial.bounds,'Activation must preserve normal window geometry');assert.equal(after.clicks,0,'No client-area click');assert.equal(after.keys,0,'No key input');
 }
 await command('cover');const hung=await command('hang');
 await assert.rejects(activate(hung,'hung'),/activation_unresponsive/);
 await delay(4200);const recovered=await command('proof');assert.equal(recovered.clicks,0);assert.equal(recovered.keys,0);assert.equal(recovered.topmost,false);
 await activate(recovered,'recovered');
 console.log(JSON.stringify({passed:true,state,results}));
}finally{
 worker.stop();
 if(child.exitCode===null){writeFileSync(join(state,'command.json'),JSON.stringify({action:'close',seq:'close'}));for(let i=0;i<120&&child.exitCode===null;i++)await delay(50);if(child.exitCode===null)child.kill();}
 writeFileSync(join(state,'results.json'),JSON.stringify(results,null,2));writeFileSync(join(state,'fixture.log'),output);
 console.log('Activation evidence: '+state);
}
