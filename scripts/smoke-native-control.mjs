// Attended, isolated Windows acceptance. Never points at an installed runtime.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { smallModelNativeTrial } from './small-model-native-trial.mjs';
if (process.platform !== 'win32' || !process.argv.includes('--run-interactive')) {
  console.log('On Windows, pass --run-interactive for an attended disposable native-window test.');
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot=process.env.EMPIR3_TEST_RUNTIME_ROOT?resolve(process.env.EMPIR3_TEST_RUNTIME_ROOT):root;
const runtimeArgs=name=>runtimeRoot===root?['--import','tsx',`src/${name}.ts`]:[`bundle-${name}.js`];
const state = mkdtempSync(join(tmpdir(), 'empir3-native-acceptance-'));
const appData = join(state, 'appdata');
mkdirSync(join(appData, 'Empir3'), { recursive: true });
mkdirSync(join(state, '.empir3-bridge'), { recursive: true });
writeFileSync(join(appData, 'Empir3', 'bridge-settings.json'), JSON.stringify({ globalSafety: {read:true,write:true,execute:true}, empir3Permissions:{read:true,write:true,execute:true}, lentTranscriptRetentionDays:0 }));
writeFileSync(join(state, '.empir3-bridge', 'config.json'), JSON.stringify({mode:'api', apiKeys:{}, enabledTools:{desktop_click:true,desktop_hover:true,desktop_drag:true,desktop_type:true,desktop_key:true,desktop_scroll:true,desktop_click_ref:true,desktop_snapshot:true}}));
const nonce = randomBytes(24).toString('hex');
const port = 13106;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, runtimeArgs('server'), { cwd:runtimeRoot, windowsHide:true, env:{...process.env, PW_PORT:String(port), EMPIR3_WS_URL:'', EMPIR3_AUTH_TOKEN:'', EMPIR3_BRIDGE_PORT:'19867', EMPIR3_BRIDGE_NONCE:nonce, APPDATA:appData, LOCALAPPDATA:join(state,'localappdata'), USERPROFILE:state, EMPIR3_BRIDGE_RUNTIME_DATA_DIR:state, EMPIR3_SERVER:'http://127.0.0.1:13005'}, stdio:['ignore','pipe','pipe'] });
let serverOutput='';
server.stdout.on('data',d=>{serverOutput+=d;}); server.stderr.on('data',d=>{serverOutput+=d;});
const resultPath=join(state,'fixture.json');
const controlPath=join(state,'fixture-control.txt');
const monitorIndex=Number(process.argv.find(a=>a.startsWith('--monitor='))?.split('=')[1] || 0);
assert.ok(Number.isInteger(monitorIndex)&&monitorIndex>=0,'--monitor must be a nonnegative index');
const ps = String.raw`
param([string]$ResultPath,[string]$ControlPath,[int]$MonitorIndex)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int mode);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr h);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
"@
[FixtureWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$screen=[Windows.Forms.Screen]::AllScreens[$MonitorIndex]
if (!$screen) { throw 'Requested monitor is unavailable' }
$form=New-Object System.Windows.Forms.Form
$form.Text='Empir3 Native Control Acceptance'
$form.StartPosition='Manual'; $form.Location=New-Object Drawing.Point(($screen.Bounds.X+160),($screen.Bounds.Y+160)); $form.Size=New-Object Drawing.Size(720,560)
$inputBox=New-Object Windows.Forms.TextBox
$inputBox.AccessibleName='Control text'; $inputBox.Multiline=$true; $inputBox.Location=New-Object Drawing.Point(30,30); $inputBox.Size=New-Object Drawing.Size(600,150)
$button=New-Object Windows.Forms.Button
$button.Text='Count click'; $button.Location=New-Object Drawing.Point(30,210); $button.Size=New-Object Drawing.Size(140,45)
$move=New-Object Windows.Forms.Button
$move.Text='Move target'; $move.Location=New-Object Drawing.Point(230,210); $move.Size=New-Object Drawing.Size(140,45)
$script:clicks=0
$script:wheels=0; $script:dragDown=$null; $script:dragUp=$null; $script:dragMoves=@()
$panel=New-Object Windows.Forms.Panel
$panel.Location=New-Object Drawing.Point(30,410); $panel.Size=New-Object Drawing.Size(600,65); $panel.BackColor=[Drawing.Color]::LightBlue; $panel.TabStop=$true
$check=New-Object Windows.Forms.CheckBox; $check.Text='Enable fixture';$check.Location=New-Object Drawing.Point(30,360);$check.Size=New-Object Drawing.Size(150,30)
Add-Type -AssemblyName PresentationFramework,WindowsFormsIntegration
$hosted=New-Object Windows.Forms.Integration.ElementHost;$hosted.Location=New-Object Drawing.Point(230,280);$hosted.Size=New-Object Drawing.Size(400,120)
$stack=New-Object Windows.Controls.StackPanel;$stack.Orientation='Horizontal'
$list=New-Object Windows.Controls.ListBox;$list.Width=140;$list.Items.Add('Vincent')|Out-Null;$list.Items.Add('Colva')|Out-Null
$tree=New-Object Windows.Controls.TreeView;$tree.Width=230;$root=New-Object Windows.Controls.TreeViewItem;$root.Header='Fixture options';$child=New-Object Windows.Controls.TreeViewItem;$child.Header='Advanced option';$root.Items.Add($child)|Out-Null;$tree.Items.Add($root)|Out-Null
$stack.Children.Add($list)|Out-Null;$stack.Children.Add($tree)|Out-Null;$hosted.Child=$stack
function Save-Proof {
 $p=$panel.PointToScreen([Drawing.Point]::Empty)
 [IO.File]::WriteAllText($ResultPath, (@{ text=$inputBox.Text; clicks=$script:clicks; targetTop=$button.Top; wheels=$script:wheels; dragDown=$script:dragDown; dragUp=$script:dragUp; dragMoves=$script:dragMoves; panel=@{x=$p.X;y=$p.Y}; window=@{x=$form.Left;y=$form.Top;width=$form.Width;height=$form.Height}; foreground=[FixtureWindow]::GetAsyncKeyState(1) } | ConvertTo-Json -Compress -Depth 4), (New-Object Text.UTF8Encoding $false))
}
$panel.Add_MouseDown({param($s,$e) $panel.Focus();$script:dragMoves=@();$script:dragDown=@{x=$e.X;y=$e.Y};Save-Proof})
$panel.Add_MouseMove({param($s,$e) if ($e.Button -eq [Windows.Forms.MouseButtons]::Left) { $script:dragMoves+=@{x=$e.X;y=$e.Y} }})
$panel.Add_MouseUp({param($s,$e) $script:dragUp=@{x=$e.X;y=$e.Y};Save-Proof})
$panel.Add_MouseWheel({param($s,$e) $script:wheels+=$e.Delta;Save-Proof})
$other=New-Object Windows.Forms.Form; $other.Text='Acceptance focus guard'; $other.Size=New-Object Drawing.Size(300,150)
$timer=New-Object Windows.Forms.Timer; $timer.Interval=16
$timer.Add_Tick({
 if (!(Test-Path -LiteralPath $ControlPath)) { return }
 $command=[IO.File]::ReadAllText($ControlPath)
 if ($command -eq 'cancel-drag') {
   if (([FixtureWindow]::GetAsyncKeyState(1) -band 0x8000) -eq 0) { return }
   $p=[Windows.Forms.Cursor]::Position; [FixtureWindow]::SetCursorPos(($p.X+80),($p.Y+80)) | Out-Null
 } elseif ($command -eq 'focus-other') { $other.Show(); $other.Activate(); [FixtureWindow]::SetForegroundWindow($other.Handle) | Out-Null }
 elseif ($command -eq 'focus-fixture') { $other.Hide(); $form.Activate(); [FixtureWindow]::SetForegroundWindow($form.Handle) | Out-Null }
 [IO.File]::Delete($ControlPath)
 Save-Proof
}); $timer.Start()
$inputBox.Add_TextChanged({Save-Proof})
$inputBox.Add_KeyDown({param($sender,$keyEvent) if ($keyEvent.Control -and $keyEvent.KeyCode -eq [Windows.Forms.Keys]::A) { $inputBox.SelectAll(); $keyEvent.SuppressKeyPress=$true }})
$button.Add_Click({$script:clicks++;Save-Proof})
$move.Add_Click({$button.Top+=90;Save-Proof})
$form.Controls.AddRange(@($inputBox,$button,$move,$panel,$check,$hosted))
$form.Add_Shown({[FixtureWindow]::ShowWindow($form.Handle,9) | Out-Null; [FixtureWindow]::SetForegroundWindow($form.Handle) | Out-Null; $form.Activate();Save-Proof})
[Windows.Forms.Application]::Run($form)
`;
const fixturePath=join(state,'fixture.ps1');writeFileSync(fixturePath,ps);
let fixture;
let fixtureOutput='';
const timings=[];
async function proofEquals(key,value) {
  let proof;
  for(let i=0;i<50;i++) { try {proof=JSON.parse(readFileSync(resultPath,'utf8'));if(proof[key]===value)return;}catch{}await delay(50); }
  assert.equal(proof?.[key],value);
}
async function command(body) {
  const start=performance.now();
  const response=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)});
  const envelope=await response.json();
  const result=envelope.result ?? envelope;
  timings.push({type:body.type,ms:Math.round(performance.now()-start),ok:envelope.ok!==false&&result.success!==false,...(result.timing?{phases:result.timing}:{})});
  if (envelope.ok===false || result.success===false){writeFileSync(join(state,'last-refusal.json'),JSON.stringify(result,null,2));throw new Error(result.error || envelope.error || JSON.stringify(envelope));}
  return result;
}
try {
  let ready=false;
  for(let i=0;i<50;i++){try{ready=(await fetch(base+'/api/status')).ok;}catch{}if(ready)break;await delay(200);}
  assert.ok(ready,'Candidate did not start: '+serverOutput.slice(-2000));
  // Let the invisible feedback window finish starting before opening the fixture.
  await delay(3500);
  fixture=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fixturePath,'-ResultPath',resultPath,'-ControlPath',controlPath,'-MonitorIndex',String(monitorIndex)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  fixture.stdout.on('data',d=>{fixtureOutput+=d;});fixture.stderr.on('data',d=>{fixtureOutput+=d;});
  for(let i=0;i<40&&!existsSync(resultPath);i++)await delay(200);
  assert.ok(existsSync(resultPath),'Fixture did not open');
  await delay(700);
  // Windows may refuse a newly launched process's request for foreground.
  // Select only our fixture, explicitly activate it, then observe fresh state.
  const windows=await command({type:'desktop:window',action:'list',params:{title:'Empir3 Native Control Acceptance'}});
  const matchingWindows=windows.windows.filter(w=>w.title==='Empir3 Native Control Acceptance');
  assert.equal(matchingWindows.length,1,'The disposable fixture must have a unique exact window title');
  const fixtureWindow=matchingWindows[0];
  await command({type:'control_activate',target:{surface:'desktop',windowHandle:fixtureWindow.handle}});
  let modelTrial;
  if(process.argv.includes('--small-model')) {
    assert.ok(process.env.EMPIR3_TEST_MODEL_URL&&process.env.EMPIR3_TEST_MODEL,'Set the test model endpoint and name explicitly.');
    modelTrial=await smallModelNativeTrial(command,process.env.EMPIR3_TEST_MODEL_URL,process.env.EMPIR3_TEST_MODEL);
    await proofEquals('text',modelTrial.expected);
    await command({type:'desktop_key',keys:['CTRL','A']});
    await command({type:'desktop_key',keys:['BACKSPACE']});
  }
  let snapshot=await command({type:'desktop_snapshot'});
  assert.equal(snapshot.windows[0].handle,fixtureWindow.handle,'Never send native acceptance input into another app');
  writeFileSync(join(state,'initial-snapshot.json'),JSON.stringify(snapshot,null,2));
  const field=snapshot.elements.find(e=>e.role==='Edit');
  if (!field) { console.log({fixtureExit:fixture.exitCode,snapshot}); console.log(await command({type:'desktop_screenshot',region:{x:150,y:150,width:1000,height:800}})); }
  assert.ok(field,'Fixture text field missing');
  await command({type:'desktop_click_ref',ref:field.ref});
  const text='Vincent – café ✓ + {test} ^ % 中文 😀';
  await command({type:'desktop_type',text,ref:field.ref});
  await proofEquals('text',text);
  await command({type:'desktop_key',keys:['CTRL','A']});
  await command({type:'desktop_type',text:'Replacement ✓'});
  await proofEquals('text','Replacement ✓');
  snapshot=await command({type:'desktop_snapshot'});
  let target=snapshot.elements.find(e=>e.name==='Count click');
  const mover=snapshot.elements.find(e=>e.name==='Move target');
  for(let i=0;i<6;i++) await command({type:'desktop_click_ref',ref:target.ref});
  await proofEquals('clicks',6);
  await command({type:'desktop_click_ref',ref:mover.ref});
  await delay(100);
  await assert.rejects(command({type:'desktop_click_ref',ref:target.ref}),/stale_observation/);
  assert.equal(JSON.parse(readFileSync(resultPath,'utf8')).clicks,6,'Stale reference sent a click');
  snapshot=await command({type:'desktop_snapshot'});
  target=snapshot.elements.find(e=>e.name==='Count click');
  await command({type:'desktop_click_ref',ref:target.ref});
  await proofEquals('clicks',7);
  const panel=JSON.parse(readFileSync(resultPath,'utf8')).panel;
  const drag={type:'desktop_drag',x:panel.x+30,y:panel.y+25,toX:panel.x+350,toY:panel.y+25,durationMs:250};
  await command(drag); await delay(100);
  let proof=JSON.parse(readFileSync(resultPath,'utf8'));
  assert.ok(Math.abs(proof.dragDown.x-30)<=2&&Math.abs(proof.dragUp.x-350)<=2,'Native drag did not reach the fixture endpoint');
  const continuousDrag=proof.dragMoves;
  assert.ok(continuousDrag.length>=5,'A held drag must deliver intermediate native move events, not just endpoints');
  assert.ok(continuousDrag.some(p=>p.x>70&&p.x<160)&&continuousDrag.some(p=>p.x>220&&p.x<310),'Native drag must cross both interior sections of the stroke');
  assert.ok(continuousDrag.every(p=>Math.abs(p.y-25)<=2),'A held drag must remain on its straight stroke');
  writeFileSync(join(state,'continuous-drag.json'),JSON.stringify({down:proof.dragDown,moves:continuousDrag,up:proof.dragUp},null,2));
  await command({type:'desktop_scroll',clicks:2,x:panel.x+300,y:panel.y+25});
  await proofEquals('wheels',240);
  writeFileSync(controlPath,'cancel-drag');
  await assert.rejects(command({...drag,durationMs:1500}),/input_cancelled/);
  await delay(100);
  proof=JSON.parse(readFileSync(resultPath,'utf8'));
  assert.equal(proof.foreground & 0x8000,0,'Cancelled drag left the mouse held');
  writeFileSync(controlPath,'focus-other');
  for(let i=0;i<30&&existsSync(controlPath);i++)await delay(50);
  await assert.rejects(command({type:'desktop_click_ref',ref:target.ref}),/stale_observation/);
  await proofEquals('clicks',7);
  writeFileSync(controlPath,'focus-fixture');
  for(let i=0;i<30&&existsSync(controlPath);i++)await delay(50);
  snapshot=await command({type:'desktop_snapshot'});
  assert.equal(snapshot.elements.find(e=>e.role==='Edit')?.value,'Replacement ✓','Snapshot must expose the actual typed value');
  target=snapshot.elements.find(e=>e.name==='Count click');
  await command({type:'desktop_hover_ref',ref:target.ref});
  const screenshot=await command({type:'desktop_screenshot',region:JSON.parse(readFileSync(resultPath,'utf8')).window});
  const controlTarget={surface:'desktop',windowHandle:snapshot.windows[0].handle};
  const controlObservation=await command({type:'control_observe',target:controlTarget});
  assert.ok(controlObservation.image.bytes>1000&&controlObservation.image.bytes<500000,'Focused observation should return a compact real image');
  assert.equal(controlObservation.image.windowHandle,controlTarget.windowHandle);
  const locator={automationId:controlObservation.observation.elements.find(e=>e.role==='Edit').automationId,role:'Edit'};
  const flow=await command({type:'control_run',target:controlTarget,steps:[{action:'fill',locator,value:'Verified workflow ✓',expect:{kind:'value',locator,equals:'Verified workflow ✓'}}]});
  assert.equal(flow.receipts[0].verified,true);await proofEquals('text','Verified workflow ✓');
  await command({type:'control_run',target:controlTarget,steps:[{action:'fill',locator,value:'',expect:{kind:'value',locator,equals:''}}]});
  await proofEquals('text','');
  const semantics=await command({type:'control_run',target:controlTarget,steps:[
    {action:'check',locator:{name:'Enable fixture'},value:true,expect:{kind:'checked',locator:{name:'Enable fixture'},equals:true}},
    {action:'expand',locator:{name:'Fixture options'},value:true,expect:{kind:'expanded',locator:{name:'Fixture options'},equals:true}},
    {action:'select',locator:{name:'Colva'}}
  ]});assert.ok(semantics.receipts.every(r=>r.verified));
  writeFileSync(controlPath,'focus-other');for(let i=0;i<30&&existsSync(controlPath);i++)await delay(50);
  const occluded=await command({type:'control_observe',target:controlTarget});assert.ok(occluded.image.bytes>1000);
  await assert.rejects(command({type:'control_run',target:controlTarget,steps:[{action:'fill',locator,value:'Wrong window'}]}),/stale_observation|target_changed/);
  const activated=await command({type:'control_activate',target:controlTarget});assert.equal(activated.verified,true);
  await command({type:'control_run',target:controlTarget,steps:[{action:'wait',expect:{kind:'checked',locator:{name:'Enable fixture'},equals:true}}]});
  await fetch(base+'/api/control/pause',{method:'POST',headers:{'X-Empir3-Nonce':nonce}});
  await assert.rejects(command({type:'desktop_key',keys:['TAB']}),/control_paused/);
  await fetch(base+'/api/control/resume',{method:'POST',headers:{'X-Empir3-Nonce':nonce}});
  writeFileSync(controlPath,'focus-fixture');for(let i=0;i<30&&existsSync(controlPath);i++)await delay(50);
  const receipt={passed:true,state,monitorIndex,modelTrial,timings,controlObservation:controlObservation.image,occludedObservation:occluded.image,semanticFillVerified:true,emptyFillVerified:true,pauseVerified:true,screenshot:screenshot.captures?.[0]?.path,unicodeExact:true,staleRefRejected:true,focusChangeRejected:true,dragVerified:true,scrollVerified:true,userTakeoverCancelsDrag:true,clicks:7};
  writeFileSync(join(state,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
  if(process.argv.includes('--hold-ui')){console.log('UI acceptance ready at '+base+'/welcome; create '+join(state,'finish-ui')+' to clean up.');while(!existsSync(join(state,'finish-ui')))await delay(500);}
} finally {
  fixture?.kill();
  server.kill();
  writeFileSync(join(state,'server.log'),serverOutput);
  writeFileSync(join(state,'fixture.log'),fixtureOutput);
  if(fixtureOutput) console.log(fixtureOutput.slice(-3000));
  console.log('Retained test state: '+state);
}
