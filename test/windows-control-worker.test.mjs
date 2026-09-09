import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import workerModule from '../src/windows-control-worker.js';
import inputModule from '../src/windows-native-input.js';
import {setControlLimitsReader} from '../src/control-limits.js';
const {createWindowsControlWorker,cacheInteropTypes}=workerModule;
const {keyCodes,literalTextBase64}=inputModule;

test('targeted and foreground snapshots do not contact unrelated desktop providers',{skip:process.platform!=='win32'},async()=>{
  const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  const selection=server.slice(server.indexOf('$targetWindows = @()',server.indexOf('async function getDesktopSnapshot')),server.indexOf('$elements = @()',server.indexOf('async function getDesktopSnapshot')));
  assert.ok(selection.includes('$targetWindows'));
  const fake=String.raw`Add-Type @"
using System;
public static class E3SelectionAutomation {
 public static object RootElement { get { throw new Exception("unrelated_provider_contacted"); } }
 public static object FromHandle(IntPtr h) { return h.ToInt64(); }
}
public static class E3SelectionWindow {
 public static IntPtr GetForegroundWindow() { return new IntPtr(77); }
 public static int GetWindowThreadProcessId(IntPtr h,out int pid) { pid=1;return 1; }
}
"@
`;
  const worker=createWindowsControlWorker();
  const probe=(handle,scope)=>fake+`\n$scope='${scope}'\n`+selection.replaceAll('${requestedWindow}',String(handle)).replaceAll('System.Windows.Automation.AutomationElement','E3SelectionAutomation').replaceAll('Empir3DesktopUia','E3SelectionWindow')+'\n@{handle=$targetWindows[0]}|ConvertTo-Json -Compress';
  try {
    assert.equal((await worker.run(probe(123,'all-windows'),10000)).handle,123);
    assert.equal((await worker.run(probe(0,'foreground'),10000)).handle,77);
    await assert.rejects(worker.run(probe(0,'all-windows'),10000),/unrelated_provider_contacted/);
  } finally {worker.stop();}
});

test('literal Unicode survives encoding; shortcuts have a separate validated vocabulary',()=>{
  for(const text of ['café ✓ + {test} ^ %','中文 😀','first\nsecond']) assert.equal(Buffer.from(literalTextBase64(text),'base64').toString('utf16le'),text);
  assert.throws(()=>literalTextBase64('\uD800'),/surrogate/);
  assert.deepEqual(keyCodes(['CTRL','A']),[17,65]);
  assert.deepEqual(keyCodes(['F24']),[135]);
  assert.throws(()=>keyCodes(['hello']),/Unknown/);
});

test('Notepad text insertion is exact, bounded, and never replayed on uncertain completion',{skip:process.platform!=='win32'},async()=>{
 const worker=createWindowsControlWorker();
 const script=inputModule.NATIVE_INPUT_PS+String.raw`
$script:calls=0;$script:received=$null
$check=[Action]{if($control.mode -eq 'focus'){throw 'target_changed'}}
$insert=[Func[string,bool]]{param($value);$script:calls++;$script:received=$value;return $control.mode -ne 'timeout'}
$errorMessage=$null
try{[Empir3NativeInput]::InsertSelectionText([string]$control.text,$check,$insert)}catch{$errorMessage=$_.Exception.Message}
@{calls=$script:calls;text=$script:received;error=$errorMessage;known=[Empir3NativeInput]::UsesSelectionText('RichEditD2DPT',$true);ansi=[Empir3NativeInput]::UsesSelectionText('RichEditD2DPT',$false);other=[Empir3NativeInput]::UsesSelectionText('Chrome_RenderWidgetHostHWND',$true)}|ConvertTo-Json -Compress
`;
 try{
  const text='café ✓ 中文 😀\r\n+ {text}';
  const ok=await worker.run(script,10000,{text});
  assert.equal(ok.text,text);assert.equal(ok.calls,1);assert.equal(ok.error,null);
  assert.equal(ok.known,true);assert.equal(ok.ansi,false);assert.equal(ok.other,false);
  const timed=await worker.run(script,10000,{text,mode:'timeout'});
  assert.equal(timed.calls,1);assert.match(timed.error,/input_incomplete/);
  const focus=await worker.run(script,10000,{text,mode:'focus'});
  assert.equal(focus.calls,0);assert.match(focus.error,/target_changed/);
  const nul=await worker.run(script,10000,{text:'first\0second'});
  assert.equal(nul.calls,0);assert.match(nul.error,/unsupported_text/);
 }finally{worker.stop();}
});
test('interop definitions are reused and incompatible definitions get distinct names',()=>{
  const script='Add-Type @"\npublic static class Empir3Test { public static int X=1; }\n"@\n[Empir3Test]::X';
  const cached=cacheInteropTypes(script);
  assert.equal(cached,cacheInteropTypes(script));
  assert.match(cached,/if \(-not \('Empir3Test_[0-9a-f]+/);
  assert.notEqual(cached,cacheInteropTypes(script.replace('X=1','X=2')));
});
test('warm interop keeps trailing parameters and referenced assemblies in the guarded command',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  const script='Add-Type -ReferencedAssemblies System @"\npublic static class E3WarmProbe { public static int Value=7; }\n"@ -ErrorAction Stop\n@{value=[E3WarmProbe]::Value}|ConvertTo-Json -Compress';
  try {for(let i=0;i<2;i++)assert.equal((await worker.run(script,10000)).value,7);}finally{worker.stop();}
});
function fakeProcess(onWrite, announceReady=true) {
  const proc=new EventEmitter(); proc.stdout=new PassThrough();proc.stderr=new PassThrough();
  if(announceReady)setImmediate(()=>proc.stdout.write('{"ready":true}\n'));
  proc.stdin=new Writable({write(chunk,_,done){onWrite(JSON.parse(chunk),proc);done();}});
  proc.kill=()=>{proc.killed=true;};return proc;
}

test('worker holds actions until initialization succeeds and starts their deadlines afterward',async()=>{
 const writes=[];
 const worker=createWindowsControlWorker({initializeScript:'load repository types',spawnProcess:()=>fakeProcess((request,proc)=>{
  writes.push(request.id);
  setTimeout(()=>proc.stdout.write(JSON.stringify({id:request.id,ok:true,output:'{"ok":true}'})+'\n'),request.id===0?400:0);
 })});
 try{
  const result=await worker.run('first input',200);
  assert.equal(result.ok,true);assert.deepEqual(writes,[0,1]);assert.equal(worker.status().ready,true);
 }finally{worker.stop();}
});

test('startup timeout rejects all queued actions without dispatching any of them',async()=>{
 let writes=0,proc;setControlLimitsReader(()=>({workerStartupTimeoutMs:100}));
 const worker=createWindowsControlWorker({spawnProcess:()=>proc=fakeProcess(()=>writes++,false)});
 try{
  const results=await Promise.allSettled([worker.run('click',1000),worker.run('type',1000)]);
  assert.equal(writes,0);assert.equal(proc.killed,true);
  assert.ok(results.every(r=>r.status==='rejected'&&/startup timed out; no action was dispatched/.test(r.reason.message)));
 }finally{worker.stop();setControlLimitsReader(()=>({}));}
});

test('initialization failure kills the worker and refuses queued actions without dispatch',async()=>{
 const writes=[];
 const worker=createWindowsControlWorker({initializeScript:'failing setup',spawnProcess:()=>fakeProcess((request,proc)=>{
  writes.push(request.id);setImmediate(()=>proc.stdout.write(JSON.stringify({id:request.id,ok:false,error:'setup failed'})+'\n'));
 })});
 try{
  await assert.rejects(worker.run('click'),/initialization failed; no action was dispatched/);
  assert.deepEqual(writes,[0]);assert.equal(worker.status().running,false);
 }finally{worker.stop();}
});
test('private worker serializes inputs, preserves UTF-8 receipts and starts only once',async()=>{
  let starts=0, inFlight=0, max=0;
  const worker=createWindowsControlWorker({spawnProcess:(exe,args,opts)=>{
    starts++;assert.equal(opts.windowsHide,true);assert.equal(exe,'powershell.exe');
    return fakeProcess((request,proc)=>{max=Math.max(max,++inFlight);setTimeout(()=>{inFlight--;proc.stdout.write(JSON.stringify({id:request.id,ok:true,output:JSON.stringify({text:'café ✓'})})+'\n');},10);});
  }});
  try {const results=await Promise.all([worker.run('first'),worker.run('second')]);assert.equal(starts,1);assert.equal(max,1);assert.equal(results[1].text,'café ✓');}finally{worker.stop();}
});
test('timeout rejects queued work without replaying uncertain input',async()=>{
  let writes=0;
  const worker=createWindowsControlWorker({spawnProcess:()=>fakeProcess(()=>writes++)});
  const results=await Promise.allSettled([worker.run('click',25),worker.run('type',1000)]);
  assert.equal(writes,1);assert.ok(results.every(r=>r.status==='rejected'&&/may have been dispatched/.test(r.reason.message)));
  worker.stop();
});
test('worker rejects mismatched receipts',async()=>{
  const worker=createWindowsControlWorker({spawnProcess:()=>fakeProcess((r,p)=>setImmediate(()=>p.stdout.write(JSON.stringify({id:r.id+1,ok:true,output:'{}'})+'\n')))});
  await assert.rejects(worker.run('click'),/Mismatched/);worker.stop();
});

test('per-action bindings remain JSON data outside the reusable PowerShell source',async()=>{
  const seen=[];
  const worker=createWindowsControlWorker({spawnProcess:()=>fakeProcess((r,p)=>{seen.push(r);setImmediate(()=>p.stdout.write(JSON.stringify({id:r.id,ok:true,output:'{}'})+'\n'));})});
  try {
    await worker.run('@{ok=$true}|ConvertTo-Json',1000,{text:'$(throw "unsafe") + café',x:1});
    await worker.run('@{ok=$true}|ConvertTo-Json',1000,{text:'different',x:200});
    assert.equal(seen[0].script,seen[1].script);
    assert.equal(seen[0].bindings.text,'$(throw "unsafe") + café');
    assert.equal(seen[1].bindings.x,200);
  } finally {worker.stop();}
});

test('a ref that expires in the queue is refused before any native input API is available',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  try {
    await assert.rejects(worker.run(inputModule.NATIVE_TARGET_GUARD_PS,10000,{target:{capturedAt:Date.now()-31000}}),/queued snapshot expired/);
  } finally {worker.stop();}
});

test('native cursor acknowledgment tolerates delayed Windows feedback but rejects takeover and stalled movement',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  const probe=inputModule.NATIVE_INPUT_PS+String.raw`
$previous=[Empir3NativeInput+POINT]::new();$previous.X=1767;$previous.Y=1678
$requested=[Empir3NativeInput+POINT]::new();$requested.X=1797;$requested.Y=1678
$script:cursorReads=0
$reader=[Func[Empir3NativeInput+POINT]]{
  $script:cursorReads++
  if($control.delayMs -and $script:cursorReads -le 2){[Threading.Thread]::Sleep([int]$control.delayMs)}
  $point=[Empir3NativeInput+POINT]::new();$point.Y=1678
  if($control.mode -eq 'takeover'){$point.X=1900}
  elseif($control.mode -eq 'stalled' -or $script:cursorReads -le 2){$point.X=1767}
  else{$point.X=1797}
  return $point
}
$guard=[Action]{if($control.mode -eq 'focus') {throw 'target_changed: selected window lost focus'}}
$result=[Empir3NativeInput]::AwaitCursor($previous,$requested,$reader,$guard)
@{x=$result.X;y=$result.Y;reads=$script:cursorReads}|ConvertTo-Json -Compress
`;
  try {
    const delayed=await worker.run(probe,10000,{mode:'delayed'});
    assert.equal(delayed.x,1797);assert.equal(delayed.y,1678);assert.equal(delayed.reads,3);
    // This injected PowerShell reader crosses a managed callback twice and
    // sleeps 120ms. A busy CI scheduler can add more than the production 250ms
    // budget; that correctly produces input_incomplete, not a runtime defect.
    // Exercise the supported configurable budget here. The preceding case and
    // takeover/stalled/focus cases retain the production default deadline.
    const loaded=await worker.run(probe,10000,{mode:'delayed',delayMs:60,controlLimits:{cursorAckTimeoutMs:1000}});
    assert.equal(loaded.x,1797);assert.equal(loaded.reads,3,'Delayed acknowledgement within the configured budget must succeed without resending movement');
    await assert.rejects(worker.run(probe,10000,{mode:'takeover'}),/input_cancelled/);
    await assert.rejects(worker.run(probe,10000,{mode:'stalled'}),/input_incomplete/);
    await assert.rejects(worker.run(probe,10000,{mode:'focus'}),/target_changed/);
  } finally {worker.stop();}
});

test('absolute mouse input addresses physical pixel centers across negative and mixed-size displays',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  const probe=inputModule.NATIVE_INPUT_PS+String.raw`
$count=0
foreach($geometry in @(@(-1920,4751),@(0,2831),@(-1440,3960),@(0,1))) {
  $origin=[int]$geometry[0];$extent=[int]$geometry[1]
  for($offset=0;$offset -lt $extent;$offset++) {
    $normalized=[Empir3NativeInput]::AbsoluteCoordinate($origin+$offset,$origin,$extent)
    $decoded=[int][Math]::Floor([double]$normalized*$extent/65536)+$origin
    if($decoded -ne $origin+$offset){throw 'physical pixel round trip failed'}
    $count++
  }
}
@{pixels=$count}|ConvertTo-Json -Compress
`;
  try {
    assert.equal((await worker.run(probe,10000)).pixels,11543);
    for(const [pixel,origin,extent] of [[-1,0,2560],[2560,0,2560],[0,0,0]])
      await assert.rejects(worker.run(inputModule.NATIVE_INPUT_PS+`\n[Empir3NativeInput]::AbsoluteCoordinate(${pixel},${origin},${extent})`,10000),/outside the virtual desktop/);
  } finally {worker.stop();}
});

test('curved travel projects monitor gaps onto real pixels without changing valid points',{skip:process.platform!=='win32'},async()=>{
  const worker=createWindowsControlWorker();
  const probe=inputModule.NATIVE_INPUT_PS+String.raw`
$left=[Empir3NativeInput+RECT]::new();$left.Left=0;$left.Top=0;$left.Right=2560;$left.Bottom=1440
$right=[Empir3NativeInput+RECT]::new();$right.Left=2560;$right.Top=1440;$right.Right=3840;$right.Bottom=3600
$negative=[Empir3NativeInput+RECT]::new();$negative.Left=-1920;$negative.Top=0;$negative.Right=0;$negative.Bottom=1080
$screens=[Empir3NativeInput+RECT[]]@($left,$right,$negative)
$points=@(@(2819,1437),@(2819,1440),@(-50,500),@(2560,100),@(2559,1439))
$result=@(foreach($xy in $points){$p=[Empir3NativeInput+POINT]::new();$p.X=$xy[0];$p.Y=$xy[1];$q=[Empir3NativeInput]::ProjectToMonitors($p,$screens);@{x=$q.X;y=$q.Y}})
$result|ConvertTo-Json -Compress
`;
  try {
    assert.deepEqual(await worker.run(probe,10000),[{x:2819,y:1440},{x:2819,y:1440},{x:-50,y:500},{x:2559,y:100},{x:2559,y:1439}]);
  } finally {worker.stop();}
});
