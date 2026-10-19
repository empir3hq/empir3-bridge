import WebSocket from 'ws';
// Attended, isolated Windows acceptance. Never points at an installed runtime.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
if (process.platform !== 'win32' || !process.argv.includes('--run-interactive')) {
  console.log('On Windows, pass --run-interactive for an attended disposable browser test.');
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot=process.env.EMPIR3_TEST_RUNTIME_ROOT?resolve(process.env.EMPIR3_TEST_RUNTIME_ROOT):root;
const runtimeArgs=name=>runtimeRoot===root?['--import','tsx',`src/${name}.ts`]:[`bundle-${name}.js`];
const state = mkdtempSync(join(tmpdir(), 'empir3-browser-acceptance-'));
const appData = join(state, 'appdata');
mkdirSync(join(appData, 'Empir3'), { recursive: true });
mkdirSync(join(state, '.empir3-bridge'), { recursive: true });
const accuracyEnabled=process.argv.includes('--accuracy');
const installedCalibration=accuracyEnabled?JSON.parse(readFileSync(join(process.env.APPDATA,'Empir3','bridge-settings.json'),'utf8')).desktopCalibration:undefined;
writeFileSync(join(appData, 'Empir3', 'bridge-settings.json'), JSON.stringify({ globalSafety: {read:true,write:true,execute:true}, empir3Permissions:{read:true,write:true,execute:true}, lentTranscriptRetentionDays:0, desktopCalibration:installedCalibration }));
writeFileSync(join(state, '.empir3-bridge', 'config.json'), JSON.stringify({mode:'api', apiKeys:{}, enabledTools:{browser_navigate:true,browser_snapshot:true,browser_evaluate:true,browser_click_ref:true,browser_type_ref:true,browser_click_xy:true,browser_scroll:true,desktop_click:true,desktop_hover:true,desktop_drag:true,desktop_type:true,desktop_key:true,desktop_scroll:true,desktop_click_ref:true,desktop_snapshot:true}}));
const nonce = randomBytes(24).toString('hex');
const port = 13006;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, runtimeArgs('server'), { cwd:runtimeRoot, windowsHide:true, env:{...process.env, PW_PORT:String(port), EMPIR3_WS_URL:'', EMPIR3_AUTH_TOKEN:'', EMPIR3_BRIDGE_PORT:'19867', EMPIR3_BRIDGE_NONCE:nonce, APPDATA:appData, LOCALAPPDATA:join(state,'localappdata'), USERPROFILE:state, EMPIR3_BRIDGE_RUNTIME_DATA_DIR:state, EMPIR3_SERVER:'http://127.0.0.1:13005'}, stdio:['ignore','pipe','pipe'] });
let serverOutput='';
server.stdout.on('data',d=>{serverOutput+=d;}); server.stderr.on('data',d=>{serverOutput+=d;});
const browserProcess=spawn(process.execPath,runtimeArgs('bridge'),{cwd:runtimeRoot,windowsHide:true,env:{...process.env,PW_PORT:String(port),BRIDGE_PORT:'19867',CDP_PORT:'19222',BRIDGE_PROFILE:join(state,'chrome-profile'),EMPIR3_BRIDGE_NONCE:nonce},stdio:['ignore','pipe','pipe']});
let browserOutput='';browserProcess.stdout.on('data',d=>browserOutput+=d);browserProcess.stderr.on('data',d=>browserOutput+=d);
const timings=[];
async function command(body) {
  const start=performance.now();const r=await fetch(base+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Empir3-Nonce':nonce},body:JSON.stringify(body)});
  const e=await r.json(); const result=e.result??e;
  timings.push({type:body.type,ms:Math.round(performance.now()-start)});
  if(e.ok===false||result.success===false)throw Error(result.error||e.error||JSON.stringify(e));
  return result;
}
async function evaluate(script) { const r=await command({type:'evaluate',script});return typeof r.result==='string'?JSON.parse(r.result):r.result; }
try {
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/status')).ok&&(await (await fetch('http://127.0.0.1:19867/health')).json()).cdpConnected;}catch{}if(ready)break;await delay(200);}
  assert.ok(ready,'Isolated browser failed to start: '+browserOutput.slice(-1000));
  // Test the real clipboard transport with an independent numeric oracle.
  // A broken OEM write/read pair can cancel its errors and falsely pass a
  // string round trip. Preserve existing text and refuse rich clipboard data.
  const formatsResult=await command({type:'desktop:execute',action:'run',params:{shell:'powershell',command:'Add-Type -AssemblyName System.Windows.Forms; $data=[Windows.Forms.Clipboard]::GetDataObject(); @{formats=@(if($data){$data.GetFormats($false)})}|ConvertTo-Json -Compress'}});
  const formats=JSON.parse(formatsResult.stdout).formats;
  const textFormats=new Set(['Text','UnicodeText','OEMText','Locale','System.String']);
  assert.ok(formats.every(format=>textFormats.has(format)),'Clipboard contains non-text data; no clipboard mutation performed');
  const originalClipboard=(await command({type:'desktop:clipboard',action:'read'})).text;
  const clipboardText='Bridge clipboard — café ✓ 中文 😀\r\n+ {literal}';
  try {
    await command({type:'desktop:clipboard',action:'write',params:{text:clipboardText}});
    const numeric=await command({type:'desktop:execute',action:'run',params:{shell:'powershell',command:'$value=Get-Clipboard -Raw; @{codes=@($value.ToCharArray()|ForEach-Object{[int]$_})}|ConvertTo-Json -Compress'}});
    assert.deepEqual(JSON.parse(numeric.stdout).codes,Array.from({length:clipboardText.length},(_,i)=>clipboardText.charCodeAt(i)));
    assert.equal((await command({type:'desktop:clipboard',action:'read'})).text,clipboardText);
  } finally {
    const current=(await command({type:'desktop:clipboard',action:'read'})).text;
    if(current===clipboardText){
      await command({type:'desktop:clipboard',action:originalClipboard?'write':'clear',params:{text:originalClipboard}});
      assert.equal((await command({type:'desktop:clipboard',action:'read'})).text,originalClipboard,'Original clipboard text must be restored');
    }
  }
  console.log('Clipboard Unicode: independent native code units and text readback verified; original text restored');
  const url=base+'/desktop-test?native-control-acceptance=1';
  const navigation=await command({type:'navigate',url});
  const observed=await evaluate('JSON.stringify({url:location.href,title:document.title})');
  assert.equal(observed.url,url,'Navigation returned before the requested page was current');
  await command({type:'desktop:window',action:'focus',params:{title:observed.title}});
  await command({type:'desktop:window',action:'maximize',params:{title:observed.title}});
  const maximized=await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(JSON.stringify({width:outerWidth,height:outerHeight})))) )');
  await command({type:'page_to_screen',cssX:100,cssY:100});
  assert.deepEqual(await evaluate('JSON.stringify({width:outerWidth,height:outerHeight})'),maximized,'Page mapping must preserve maximized browser geometry');
  await evaluate(`document.body.innerHTML='<main style="padding:80px;font:24px sans-serif"><h1>Empir3 browser control acceptance</h1><label for="control-text">Control text</label><input id="control-text" style="display:block;width:600px;height:48px"><button id="count" style="margin-top:40px;width:180px;height:60px">Count click</button><p id="result">0</p></main>';document.querySelector('#count').onclick=()=>document.querySelector('#result').textContent=String(Number(document.querySelector('#result').textContent)+1);JSON.stringify({ready:true})`);
  const snapshot=await command({type:'snapshot'});
  writeFileSync(join(state,'snapshot.json'),JSON.stringify(snapshot,null,2));
  console.log('Snapshot: '+JSON.stringify(snapshot));
  const field=snapshot.snapshot.nodes.find(n=>n.role==='input')?.ref;
  const button=snapshot.snapshot.nodes.find(n=>n.name==='Count click')?.ref;
  assert.ok(field&&button,'Expected observed refs for fixture field and named button');
  const unicode='Vincent – café ✓ + {test} ^ % 中文 😀';
  await command({type:'type_ref',ref:field,text:unicode});
  assert.equal((await evaluate('JSON.stringify({value:document.querySelector("#control-text").value})')).value,unicode);
  const clickReceipts=[];
  for(let i=0;i<4;i++)clickReceipts.push(await command({type:'click_ref',ref:button}));
  writeFileSync(join(state,'click-receipts.json'),JSON.stringify({clickReceipts,timings},null,2));
  assert.equal((await evaluate('JSON.stringify({clicks:Number(document.querySelector("#result").textContent)})')).clicks,4);
  await evaluate('window.acceptanceKeys=[];document.querySelector("#control-text").addEventListener("keydown",e=>window.acceptanceKeys.push({key:e.key,trusted:e.isTrusted,ctrl:e.ctrlKey}));JSON.stringify(true)');
  await command({type:'click_ref',ref:field});
  await command({type:'press',key:'ENTER'});
  await command({type:'press',key:'ctrl+enter'});
  assert.deepEqual(await evaluate('JSON.stringify(window.acceptanceKeys.filter(e=>e.key==="Enter"))'),[{key:'Enter',trusted:true,ctrl:false},{key:'Enter',trusted:true,ctrl:true}]);
  const pointer=await command({type:'desktop_pointer_status'});
  writeFileSync(join(state,'pointer-status.json'),JSON.stringify(pointer,null,2));
  assert.equal(pointer.active,true,'Foreground browser input must show its feedback cursor');
  assert.equal(pointer.overlayRunning,true,'Feedback window must be running');
  // Native screenshot includes the independent feedback window; CDP screenshots cannot.
  const shot=await command({type:'desktop_screenshot',monitor:'primary'});
  await command({type:'navigate',url:base+'/control-lab'});
  const tabs=await command({type:'browser_tab_state'});
  const tabState=await (await fetch('http://127.0.0.1:19867/tabs')).json();
  const workflowTarget={surface:'browser',tabId:tabState.currentTargetId};
  await command({type:'browser_tab_focus',tabAction:'user_focus',targetId:workflowTarget.tabId});
  await assert.rejects(command({type:'type',selector:'#name',text:'Must not type',target:workflowTarget}),/target_owned_by_user/);
  await command({type:'control_activate',target:workflowTarget});
  assert.equal((await command({type:'browser_tab_state'})).userFocusTarget,null);
  const observedControl=await command({type:'control_observe',target:workflowTarget});assert.ok(observedControl.observation.controls.length>=5);
  await assert.rejects(command({type:'type',selector:'#team',text:'colva'}),error=>{
    const body=error.message.slice(error.message.indexOf('{'));
    const guidance=JSON.parse(body).error;
    assert.match(guidance,/No input was sent/);
    const recipe=JSON.parse(guidance.split('Use browser_control ')[1].split('. Enabled options:')[0]);
    assert.deepEqual(recipe,{action:'control_run',params:{target:workflowTarget,steps:[{action:'select',locator:{selector:'#team'},value:'colva'}]}});
    return true;
  });
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#team").value)'),'vincent','Text-to-select refusal must not change the selected option');
  const workflow=await command({type:'control_run',target:workflowTarget,owner:'Acceptance',steps:[
    {action:'fill',locator:{role:'textbox',name:'Name'},value:'Astra ✓',expect:{kind:'value',locator:{selector:'#name'},equals:'Astra ✓'}},
    {action:'select',locator:{selector:'#team'},value:'colva',expect:{kind:'value',locator:{selector:'#team'},equals:'colva'}},
    {action:'check',locator:{selector:'#enabled'},value:true,expect:{kind:'checked',locator:{selector:'#enabled'},equals:true}},
    {action:'expand',locator:{selector:'#details'},value:true,expect:{kind:'expanded',locator:{selector:'#details'},equals:true}},
    {action:'click',locator:{selector:'#save'},expect:{kind:'text',locator:{selector:'#status'},equals:'Saved 1'}}
  ]});assert.equal(workflow.receipts.length,5);assert.ok(workflow.receipts.every(r=>r.verified));
  if(process.argv.includes('--batch-refs')) {
    const refs=(await command({type:'snapshot'})).snapshot.nodes;
    const nameRef=refs.find(n=>n.name==='Name').ref;
    const saveRef=refs.find(n=>n.name==='Save locally').ref;
    const byRef=await command({type:'control_run',target:workflowTarget,steps:[
      {action:'fill',locator:{ref:nameRef},value:'Batch ref ✓',expect:{kind:'value',locator:{ref:nameRef},equals:'Batch ref ✓'}},
      {action:'click',locator:{ref:saveRef},expect:{kind:'text',locator:{selector:'#status'},equals:'Saved 2'}}
    ]});assert.ok(byRef.receipts.every(r=>r.verified));
    await assert.rejects(command({type:'control_run',target:workflowTarget,steps:[{action:'click',locator:{ref:'e999999',selector:'#save'}}]}),/target_missing/);
    await assert.rejects(command({type:'control_run',target:workflowTarget,steps:[{action:'click',locator:{ref:'e0"] , button'}}]}),/invalid_ref/);
    assert.equal(await evaluate('JSON.stringify(document.querySelector("#status").textContent)'),'Saved 2');
    await evaluate('document.querySelector("#name").style.display="none";JSON.stringify(true)');
    const hiddenRefs=(await command({type:'snapshot'})).snapshot.nodes;
    assert.equal(await evaluate('JSON.stringify(document.querySelector("#name").hasAttribute("data-empir3-ref"))'),false,'Hidden nodes must lose old markers');
    assert.ok(hiddenRefs.every(n=>!refs.some(old=>old.ref===n.ref)),'A new snapshot must not recycle old refs');
    await evaluate('document.querySelector("#name").style.display="";JSON.stringify(true)');
    const freshRefs=(await command({type:'snapshot'})).snapshot.nodes;
    await assert.rejects(command({type:'click_ref',ref:saveRef}),/not found|missing|actionable/i);
    await assert.rejects(command({type:'control_run',target:workflowTarget,steps:[{action:'click',locator:{ref:saveRef,selector:'#save'}}]}),/target_missing/);
    assert.equal(await evaluate('JSON.stringify(document.querySelector("#status").textContent)'),'Saved 2','Stale refs must never hit a different element');
    const fresh=await command({type:'control_run',target:workflowTarget,steps:[{action:'fill',locator:{ref:freshRefs.find(n=>n.name==='Name').ref},value:'Fresh snapshot ✓'}]});
    assert.ok(fresh.receipts.every(r=>r.verified));
    console.log('Batch refs: verified fill, click, expectation, missing-ref no fallback and malformed-ref refusal');
  console.log('Repeated snapshots: hidden markers removed, refs never reused, stale direct/batch input refused, fresh input verified');
  }
  // Real React mention pickers insert siblings while typing. The original
  // field is still alive even though its generated nth-of-type path moved.
  await evaluate(`(() => { const host=document.createElement('div');host.dataset.typingFixture='true';
    const field=document.createElement('textarea');field.setAttribute('aria-label','Moving editor');host.append(field);document.body.append(host);
    field.addEventListener('input',()=>{if(!host.previousElementSibling?.hasAttribute('data-popup-fixture')){const popup=document.createElement('div');popup.dataset.popupFixture='true';host.before(popup);}});
    return JSON.stringify(true); })()`);
  const movingFill=await command({type:'control_run',target:workflowTarget,steps:[{action:'fill',locator:{role:'textbox',name:'Moving editor'},value:'@Nemotron'}]});
  assert.ok(movingFill.receipts.every(r=>r.verified),'Sibling insertion must not turn successful typing into a false failure');
  assert.equal(await evaluate(`JSON.stringify(document.querySelector('textarea[aria-label="Moving editor"]').value)`),'@Nemotron');
  await evaluate(`(() => {const field=document.createElement('input');field.id='identity-replacement';field.value='original';document.body.append(field);
    field.addEventListener('input',()=>{if(field.value==='new'){const replacement=field.cloneNode();replacement.value='replacement must survive';field.replaceWith(replacement);}});
    return JSON.stringify(true);})()`);
  await assert.rejects(command({type:'type',selector:'#identity-replacement',text:'new'}),/disappeared while typing/);
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#identity-replacement").value)'),'replacement must survive','Failure must not restore the old value into a replacement node');
  assert.deepEqual(await evaluate('JSON.stringify(Object.keys(window.__empir3ActionReceipts||{}))'),[],'Completed and failed typing must release retained DOM nodes');
  await evaluate(`document.querySelectorAll('[data-typing-fixture],[data-popup-fixture],#identity-replacement').forEach(el=>el.remove());JSON.stringify(true)`);
  await assert.rejects(command({type:'control_run',target:workflowTarget,steps:[{action:'fill',locator:{selector:'input'},value:'ambiguous'}]}),/ambiguous_target/);
  await command({type:'record_start',target:workflowTarget});
  await command({type:'type',selector:'#name',text:'Recorded ✓'});
  await command({type:'click',selector:'#save'});
  const recording=await command({type:'record_stop',text:'control-acceptance'});assert.ok(recording.actionCount>=3,JSON.stringify(recording));
  const playback=await command({type:'play',recording:recording.saved});assert.equal(playback.success,true);
  await assert.rejects(command({type:'play',recording:recording.saved,maxSteps:1}),/action budget/);
  // A second capture must survive closing the previous recording session.
  await command({type:'record_start',target:workflowTarget});
  await command({type:'type',selector:'#password',text:'fixture-private-password'});
  await command({type:'navigate',url:base+'/control-lab?recorder=second'});
  await command({type:'click',selector:'#save'});
  const privateRecording=await command({type:'record_stop',text:'private-control-acceptance'});
  const privateSource=readFileSync(join(state,'recordings',privateRecording.saved),'utf8');
  assert.ok(!privateSource.includes('fixture-private-password'));assert.ok(privateSource.includes('{{PASSWORD}}'));
  assert.ok(JSON.parse(privateSource).controlSteps.filter(s=>s.action==='navigate').length>=2);
  await command({type:'play',recording:recording.saved});
  assert.equal((await evaluate('JSON.stringify({value:document.querySelector("#name").value})')).value,'Recorded ✓');
  const diagnostics=await command({type:'control_diagnostics'});assert.ok(JSON.stringify(diagnostics).length<60000);assert.ok(!JSON.stringify(diagnostics).includes('Recorded ✓'));
  const controlProof={workflowVerified:true,recordingActions:recording.actionCount,playbackVerified:true,diagnosticBytes:JSON.stringify(diagnostics).length};
  let accuracy;
  if(accuracyEnabled) {
    await command({type:'navigate',url:base+'/accuracy-lab'});
    // Exercise the public page mapping path before the full physical sweep.
    const pagePoint=await command({type:'page_to_screen',cssX:100,cssY:100});assert.ok(Number.isFinite(pagePoint.screenX));
    accuracy=await command({type:'desktop:browse:accuracy_lab_sweep'});
    assert.equal(accuracy.passed,true,'Fresh physical accuracy sweep did not pass');
    assert.equal(accuracy.trustedReceipts,103,'All 103 real mouse events must hit their intended targets');
  }
  const receipt={passed:true,state,timings,controlProof,navigationReturnedCurrentPage:true,unicodeExact:true,clicks:4,pointer,accuracy,screenshot:shot.captures?.[0]?.path};
  writeFileSync(join(state,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,accuracy:accuracy?{passed:accuracy.passed,trustedReceipts:accuracy.trustedReceipts,stats:accuracy.stats}:undefined},null,2));
  if(process.argv.includes('--hold-ui')){console.log('UI acceptance ready at '+base+'/welcome; create '+join(state,'finish-ui')+' to clean up.');while(!existsSync(join(state,'finish-ui')))await delay(500);}
} catch(error) {
  console.error(error);
  if(process.argv.includes('--hold-on-failure')){console.log('Failure retained at '+state+'; create '+join(state,'finish-ui')+' to clean up.');while(!existsSync(join(state,'finish-ui')))await delay(500);}
  throw error;
} finally {
  try {
    const version=await (await fetch('http://127.0.0.1:19222/json/version')).json();
    const ws=new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(resolveClose=>{const timer=setTimeout(()=>{ws.terminate();resolveClose();},2000);ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.close'})));ws.on('close',()=>{clearTimeout(timer);resolveClose();});ws.on('error',()=>{clearTimeout(timer);resolveClose();});});
  } catch {}
  browserProcess.kill();server.kill();
  writeFileSync(join(state,'server.log'),serverOutput);writeFileSync(join(state,'browser.log'),browserOutput);
  console.log('Retained test state: '+state);
}
