import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import vm from 'node:vm';
import { decodeUploadFiles } from '../src/browser-file-upload.ts';
test('file upload rejects invalid encodings, paths and oversized payloads before CDP', () => {
  const file = { filename: 'test.txt', mimeType: 'text/plain', data: 'YWJj' };
  assert.equal(decodeUploadFiles({ files: [file], ...file }).length, 1);
  assert.equal(decodeUploadFiles(file)[0].bytes.toString(), 'abc');
  assert.equal(decodeUploadFiles({ ...file, data: '' })[0].bytes.length, 0);
  assert.equal(decodeUploadFiles({ ...file, data: Buffer.alloc(1024*1024,42).toString('base64') })[0].bytes.length,1024*1024);
  for (const payload of [{ files: [] }, { files: {} }, { ...file, filename: '../bad' }, { ...file, filename: 'C:\\bad' }, { ...file, data: '???' }, { ...file, data: 'data:text/plain;base64,YWJj' }, { ...file, data: 'A'.repeat(45_000_000) }]) {
    assert.throws(() => decodeUploadFiles(payload));
  }
});

// Opt in: uses a separate Chrome profile/ports and never touches a running Bridge.
test('real Chrome: exact-target images/navigation, redirected tab_open and file bytes/events', {
  skip: process.env.EMPIR3_RUN_BROWSER_INTEGRATION !== '1', timeout: 90_000,
}, async (t) => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const state = await mkdtemp(join(tmpdir(), 'empir3-target-upload-test-'));
  let received;
  const fixture = createServer(async (req, res) => {
    const idpOrigin=`http://localhost:${fixture.address().port}`;
    res.setHeader('Access-Control-Allow-Origin',`http://127.0.0.1:${fixture.address().port}`);res.setHeader('Access-Control-Allow-Credentials','true');
    const idp={
      '/.well-known/web-identity':{provider_urls:[idpOrigin+'/idp/config']},
      '/idp/config':{accounts_endpoint:'/idp/accounts',id_assertion_endpoint:'/idp/assert',client_metadata_endpoint:'/idp/metadata',login_url:'/idp/login'},
      '/idp/accounts':{accounts:[{id:'fixture',name:'Fixture Person',email:'fixture@example.test',given_name:'Fixture',approved_clients:['fixture-client']}]},
      '/idp/metadata':{privacy_policy_url:idpOrigin+'/privacy',terms_of_service_url:idpOrigin+'/terms'},
      '/idp/assert':{token:'fixture-token'},
    };
    if(idp[req.url]){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(idp[req.url]));return;}
    if(req.url==='/idp/login')res.setHeader('Set-Login','logged-in');
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/blue' }); res.end(); return; }
    if (req.url === '/receive') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received = Buffer.concat(chunks).toString(); res.end('ok'); return;
    }
    const color = req.url === '/red' ? 'red' : 'blue';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><title>${color}</title></head><body style="margin:0;background:${color}">
      <input id="files" type="file" multiple data-empir3-ref="e1_0"><input id="single" type="file">
      <script>window.events=[]; document.addEventListener('input',e=>events.push('input:'+e.target.id)); document.addEventListener('change',e=>events.push('change:'+e.target.id));</script></body></html>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  // Reserve OS-assigned ports before spawning the isolated bridge.
  const reserve = async () => { const s=createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; };
  const port = await reserve(), cdpPort = await reserve();
  const base = `http://127.0.0.1:${port}`;
  let wrapper;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bridge.ts'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, BRIDGE_PORT: String(port), CDP_PORT: String(cdpPort), BRIDGE_PROFILE: join(state,'profile'), EMPIR3_BRIDGE_RUNTIME_DATA_DIR:join(state,'runtime'), BRIDGE_HEADLESS: 'true', BRIDGE_TOKEN: '', EMPIR3_CHROME_AUTOLAUNCH: '1' },
    stdio: ['ignore','pipe','pipe'],
  });
  let log = ''; child.stdout.on('data', c=>log+=c); child.stderr.on('data', c=>log+=c);
  async function api(path, body) {
    const response = await fetch(base+path, body === undefined ? {} : { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.error || result.success === false) throw Error(result.error || JSON.stringify(result));
    return result;
  }
  const evaluate = async (targetId, expression) => { const r=await api('/evaluate-on-target',{targetId,expression}); return Object.hasOwn(r,'result')?r.result:r; };
  try {
    let ready = false;
    for (let i=0;i<150;i++) {
      if (child.exitCode !== null) throw Error(log);
      try { const h=await api('/health'); if(h.browserRunning && h.cdpConnected) { ready=true; break; } } catch {}
      await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready, log);
    const red = await api('/create-tab', {url:fixtureUrl+'/red'});
    const blue = await api('/create-tab', {url:fixtureUrl+'/redirect'});
    assert.equal(blue.url, fixtureUrl+'/blue');
    assert.equal(blue.requestedUrl, fixtureUrl+'/redirect');
    assert.equal(blue.loaded, true);
    const before = await api('/tabs');
    const redImage = await api(`/screenshot?format=json&targetId=${red.targetId}`);
    const blueImage = await api(`/screenshot?format=json&targetId=${blue.targetId}`);
    assert.notEqual(redImage.data, blueImage.data);
    assert.equal(redImage.targetId, red.targetId);
    const pixel = await evaluate(blue.targetId, `(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/jpeg;base64,')}+${JSON.stringify(redImage.data)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return Array.from(ctx.getImageData(10,100,1,1).data);})()`);
    assert.ok(pixel[0]>200 && pixel[2]<50, `Targeted red screenshot has pixel ${pixel}`);
    assert.equal((await api('/tabs')).currentTargetId, before.currentTargetId);
    const nav = await api('/navigate', {targetId:red.targetId,url:fixtureUrl+'/red?changed'});
    assert.equal(nav.url, fixtureUrl+'/red?changed');
    assert.equal(nav.targetId, red.targetId);
    assert.equal(await evaluate(blue.targetId,'location.href'), fixtureUrl+'/blue');
    const after = await api('/tabs');
    assert.equal(after.currentTargetId, before.currentTargetId);
    assert.equal(after.tabs.length, before.tabs.length);
    const files=[{filename:'résumé.txt',mimeType:'text/plain',data:Buffer.from('hello 日本語\n').toString('base64')},{filename:'data.bin',mimeType:'application/x-test',data:Buffer.from([0,1,2,255]).toString('base64')}];
    const upload = await api('/upload-file',{targetId:blue.targetId,selector:'#files',files,...files[0]});
    assert.equal(upload.files.length,2);
    assert.equal(upload.files[1].mimeType,'application/x-test');
    // Read AFTER the endpoint removed its temp files; upload these same Files
    // through a real HTTP request, proving they are not stale disk references.
    const inspected = await evaluate(blue.targetId,`(async()=>{ const files=await Promise.all(Array.from(document.querySelector('#files').files,async f=>({name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}))); await fetch('/receive',{method:'POST',body:JSON.stringify(files)}); return {files,events}; })()`);
    assert.equal(JSON.parse(received)[0].name,'résumé.txt');
    assert.deepEqual(inspected.files[1].bytes,[0,1,2,255]);
    assert.deepEqual(inspected.events,['input:files','change:files']);
    await assert.rejects(api('/upload-file',{targetId:blue.targetId,files}),/exactly one/);
    await assert.rejects(api('/upload-file',{targetId:blue.targetId,selector:'#single',files}),/multiple/);
    await assert.rejects(api('/upload-file',{targetId:red.targetId,selector:'#files',files}),/target_not_current/);
    await assert.rejects(api('/upload-file',{targetId:blue.targetId,ref:'stale',...files[0]}),/exactly one/);
    await api('/upload-file',{targetId:blue.targetId,ref:'e1_0',...files[0]});
    assert.equal(await evaluate(blue.targetId,"document.querySelector('#files').files.length"),1);
    assert.deepEqual(await evaluate(red.targetId,"Array.from(document.querySelector('#files').files)"),[]);
    const prompts=await api('/browser-prompts',{targetId:blue.targetId,action:'status'});
    assert.equal(prompts.capabilities.fedcm,true);
    assert.deepEqual(prompts.prompts,[]);
    await assert.rejects(api('/browser-prompts',{targetId:blue.targetId,action:'respond',requestId:'invented'}),/owner_approval_required/);
    // Only the fixture changes its DOM; the recorder attaches CDP capture only.
    await evaluate(blue.targetId,"document.body.style.background='repeating-linear-gradient(90deg,red 0px,red 2px,blue 2px,blue 4px)'; document.body.innerHTML");
    const domBefore=await evaluate(blue.targetId,'document.documentElement.outerHTML');
    await assert.rejects(api('/video-start',{targetId:blue.targetId,blurRegions:[{x:8000,y:8000,width:100,height:100}]}),/outside the captured image/);
    assert.equal((await (await fetch(base+'/video-status')).json()).state,'failed');
    const start=await api('/video-start',{targetId:blue.targetId,maxDurationMs:10000,blurRegions:[{x:0,y:60,width:100,height:100}]});
    assert.equal(start.recording,true);
    await new Promise(r=>setTimeout(r,1250));
    const video=await api('/video-stop',{});
    assert.ok(video.bytes>1000);assert.ok(video.durationMs>=1200);
    assert.equal(await evaluate(blue.targetId,'document.documentElement.outerHTML'),domBefore);
    const probe=JSON.parse((await promisify(execFile)('ffprobe',['-v','error','-show_entries','format=duration','-of','json',video.path],{windowsHide:true})).stdout);
    assert.ok(Math.abs(Number(probe.format.duration)-video.durationMs/1000)<0.15,JSON.stringify({probe,video}));
    const sample=await promisify(execFile)('ffmpeg',['-v','error','-i',video.path,'-frames:v','1','-vf','format=rgb24,crop=1:1:40:100','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer'});
    assert.ok(sample.stdout[0]>60 && sample.stdout[2]>60,`Saved blur pixel ${[...sample.stdout]}`);
    const timing=JSON.parse(await readFile(join(state,'runtime','videos',video.id,'recording.json'),'utf8'));
    assert.ok(timing.frames.length>0);
    assert.equal((await api('/video-stop',{})).id,video.id);
    const wrapperPort=await reserve(),wrapperUrl=`http://127.0.0.1:${wrapperPort}`;
    const settingsDir=join(state,'appdata','Empir3');await mkdir(settingsDir,{recursive:true});
    await writeFile(join(settingsDir,'bridge-settings.json'),JSON.stringify({globalSafety:{read:true,write:true,execute:true}}));
    wrapper=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PW_PORT:String(wrapperPort),EMPIR3_BRIDGE_PORT:String(port),EMPIR3_BRIDGE_RUNTIME_DATA_DIR:join(state,'runtime'),EMPIR3_BRIDGE_CONFIG_DIR:join(state,'config'),APPDATA:join(state,'appdata'),LOCALAPPDATA:join(state,'localappdata'),EMPIR3_WS_URL:'',EMPIR3_AUTH_TOKEN:'',EMPIR3_BRIDGE_NO_CHROME_AUTOLAUNCH:'1'}});
    wrapper.stdout.on('data',()=>{});wrapper.stderr.on('data',c=>log+=c);
    for(let i=0;i<100;i++){try{if((await fetch(wrapperUrl+'/api/status')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const panel=await (await fetch(wrapperUrl+'/console')).text();
    assert.match(panel,/id="videoStart"/);assert.match(panel,/id="promptRequests"/);
    for(const script of panel.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
    const command=async body=>{const r=await fetch(wrapperUrl+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();assert.equal(r.ok,true,JSON.stringify(j));assert.notEqual(j.result?.success,false,JSON.stringify(j));return j.result;};
    const observed=await command({type:'browser_prompts',target:{surface:'browser',tabId:blue.targetId},desktopFallback:false});
    assert.equal(observed.capabilities.fedcm,true);
    const login=await api('/create-tab',{url:`http://localhost:${fixture.address().port}/idp/login`});
    await api('/activate-target',{targetId:blue.targetId,bringToFront:false});
    await evaluate(blue.targetId,`window.fixtureCredential=null;window.fixtureCredentialError=null;navigator.credentials.get({identity:{providers:[{configURL:'http://localhost:${fixture.address().port}/idp/config',clientId:'fixture-client'}]},mediation:'required'}).then(r=>window.fixtureCredential=r.token).catch(e=>window.fixtureCredentialError=e.message);true`);
    let fedcm;for(let i=0;i<60;i++){fedcm=await api('/browser-prompts',{targetId:blue.targetId});if(fedcm.prompts.length)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(fedcm.prompts.length,JSON.stringify({fedcm,error:await evaluate(blue.targetId,'window.fixtureCredentialError')}));
    assert.equal(fedcm.prompts[0].accounts[0].email,'fixture@example.test');
    const approval=await command({type:'browser_prompts',promptAction:'request',target:{surface:'browser',tabId:blue.targetId},promptId:fedcm.prompts[0].id,choice:'select_account',accountIndex:0});
    // Only this local test identity is approved through the actual owner panel.
    const panelTab=await api('/create-tab',{url:wrapperUrl+'/console?pane=agent'});
    assert.equal(await evaluate(panelTab.targetId,"!!document.querySelector('#promptRefresh').offsetParent"),true);
    await evaluate(panelTab.targetId,"document.querySelector('#promptRefresh').click();true");
    for(let i=0;i<40;i++){if(await evaluate(panelTab.targetId,"!!document.querySelector('#promptRequests button')"))break;await new Promise(r=>setTimeout(r,100));}
    await evaluate(panelTab.targetId,"document.querySelector('#promptRequests').scrollIntoView({block:'center'});document.querySelector('#promptRequests button').click();true");
    for(let i=0;i<40;i++){if((await api('/prompt-requests')).requests.some(r=>r.id===approval.requestId&&r.approved))break;await new Promise(r=>setTimeout(r,100));}
    await api('/activate-target',{targetId:blue.targetId,bringToFront:false});
    await command({type:'browser_prompts',promptAction:'respond',target:{surface:'browser',tabId:blue.targetId},requestId:approval.requestId});
    for(let i=0;i<30;i++){if(await evaluate(blue.targetId,'window.fixtureCredential'))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(await evaluate(blue.targetId,'window.fixtureCredential'),'fixture-token');await api('/close-target',{targetId:login.targetId});
    const denied=await fetch(wrapperUrl+'/api/browser-prompt-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'invented'})});assert.equal(denied.status,400);
    await command({type:'video_record_start',surface:'browser',target:{surface:'browser',tabId:blue.targetId},maxDurationMs:1000});
    let saved;for(let i=0;i<60;i++){saved=(await command({type:'video_record_status'})).browser;if(saved.state==='saved')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(saved.state,'saved',JSON.stringify(saved));
    const download=await fetch(wrapperUrl+'/api/videos/'+saved.id);assert.equal(download.status,200);assert.equal((await download.arrayBuffer()).byteLength,saved.result.bytes);
    for(let i=0;i<40;i++){if(await evaluate(panelTab.targetId,"!document.querySelector('#videoStart').disabled"))break;await new Promise(r=>setTimeout(r,100));}
    await evaluate(panelTab.targetId,"document.querySelector('#videoStart').click();true");
    for(let i=0;i<40;i++){if((await command({type:'video_record_status'})).browser.recording)break;await new Promise(r=>setTimeout(r,100));}
    assert.equal((await command({type:'video_record_status'})).browser.recording,true);
    assert.equal(await evaluate(panelTab.targetId,"document.querySelector('#videoStop').disabled"),false);
    await evaluate(panelTab.targetId,"document.querySelector('#videoStop').click();true");
    for(let i=0;i<60;i++){if((await command({type:'video_record_status'})).browser.state==='saved')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal((await command({type:'video_record_status'})).browser.state,'saved');
    await evaluate(panelTab.targetId,"document.querySelector('#videoStatus').scrollIntoView({block:'center'});true");
    await new Promise(r=>setTimeout(r,300));
    const panelImage=await api(`/screenshot?format=json&targetId=${panelTab.targetId}`);await writeFile(process.env.EMPIR3_INTEGRATION_SCREENSHOT || join(state,'panel.png'),Buffer.from(panelImage.data,'base64'));
    await api('/close-target',{targetId:panelTab.targetId});
    if(process.platform==='win32'){
      await command({type:'video_record_start',surface:'desktop',region:{x:0,y:0,width:64,height:64},maxDurationMs:1000});
      const native=await command({type:'video_record_stop',surface:'desktop'});assert.ok(native.frames>=1);assert.ok(native.bytes>0);assert.equal(native.mimeType,'video/mp4');
      t.diagnostic('Native Windows region capture encoded an MP4 successfully.');
    }
    await command({type:'video_record_start',surface:'browser',target:{surface:'browser',tabId:blue.targetId}});
    await fetch(wrapperUrl+'/api/safety/lockdown',{method:'POST'});
    for(let i=0;i<60;i++){if((await command({type:'video_record_status'})).browser.state==='saved')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal((await command({type:'video_record_status'})).browser.state,'saved','Revoke control must stop capture');
    assert.ok((await command({type:'video_record_stop'})).bytes>0,'Stop remains available after revocation');
    if(process.env.EMPIR3_VIDEO_SITE_SMOKE==='1')for(const url of ['https://www.yelp.com/','https://resy.com/']){
      const site=await api('/create-tab',{url});
      await new Promise(r=>setTimeout(r,3000));
      const before=await evaluate(site.targetId,'document.body.innerText');
      const blocked=text=>/captcha|verify you are human|access denied|unusual traffic|automated requests|enable (?:java)?script|enable js|disable any ad blocker/i.test(text);
      await api('/video-start',{targetId:site.targetId,maxDurationMs:10000});await new Promise(r=>setTimeout(r,1500));const movie=await api('/video-stop',{});
      const after=await evaluate(site.targetId,'document.body.innerText');
      const loaded=(before.length>100||blocked(before)) && (after.length>100||blocked(after));
      t.diagnostic(JSON.stringify({url,acceptance:loaded?'observed':'INCONCLUSIVE: no usable page content',title:await evaluate(site.targetId,'document.title'),blockedBefore:blocked(before),blockedAfter:blocked(after),textLengthBefore:before.length,textLengthAfter:after.length,bytes:movie.bytes}));
      if(loaded)assert.equal(blocked(after),blocked(before),'Capture introduced a bot-check page');await api('/close-target',{targetId:site.targetId});
    }
    await api('/close-target',{targetId:red.targetId});
    await assert.rejects(api(`/screenshot?format=json&targetId=${red.targetId}`),/target_closed/);
    await assert.rejects(api('/navigate',{targetId:red.targetId,url:fixtureUrl+'/red'}),/target_closed/);
  } finally {
    // Close only the browser launched on this test's dedicated CDP port.
    try {
      const version=await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      await new Promise(resolve=>{const ws=new WebSocket(version.webSocketDebuggerUrl); const timer=setTimeout(()=>{ws.terminate();resolve();},2000); ws.on('error',()=>{clearTimeout(timer);resolve();});ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.close'})));ws.on('close',()=>{clearTimeout(timer);resolve();});});
    } catch {}
    child.kill();
    wrapper?.kill();
    await new Promise(r=>setTimeout(r,500));
    fixture.closeAllConnections(); await new Promise(r=>fixture.close(r));
    await rm(state,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
});
