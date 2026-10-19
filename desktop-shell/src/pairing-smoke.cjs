'use strict';

// Only invoked by --pairing-smoke after the normal smoke isolation assertions.
// The rendered page and Electron navigation/clipboard policies are real; the
// account endpoint is a fixture and no pairing code is created on Empir3.
async function runPairingSmoke(window, intercepted) {
  const contents = window.webContents;
  contents.setBackgroundThrottling(false);
  const localUrl = contents.getURL();
  const fixtureUrl = 'https://pairing-smoke.invalid/connect-bridge?code=LOCAL-TEST';
  await contents.executeJavaScript(`(() => {
    const original = window.fetch;
    window.__pairingSmokeRequests = 0;
    window.fetch = async function(input, options) {
      if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/api/install/empir3-pair') {
        window.__pairingSmokeRequests++;
        return new Response(JSON.stringify({ok:true,redirectUrl:${JSON.stringify(fixtureUrl)}}), {headers:{'Content-Type':'application/json'}});
      }
      return original.call(this,input,options);
    };
    window.openDrawer();
    document.getElementById('pairEmpir3').click();
  })()`, true);
  for (let i=0;i<60 && !intercepted.length;i++) await new Promise(r=>setTimeout(r,50));
  if (intercepted.length !== 1 || intercepted[0] !== fixtureUrl || contents.getURL() !== localUrl) {
    throw Error('Pairing navigation did not stay in the packaged recovery page');
  }
  const result = await contents.executeJavaScript(`(async () => {
    const status = document.getElementById('drawerStatus');
    const input = status.querySelector('input');
    const copy = status.querySelector('button');
    if (!input || !copy || input.value !== ${JSON.stringify(fixtureUrl)} || !input.readOnly) throw Error('Missing selectable pairing link');
    input.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,250));
    const bounds = input.getBoundingClientRect();
    if (bounds.width < 100 || bounds.height < 10 || bounds.right > innerWidth || bounds.left < 0 || bounds.bottom > innerHeight || bounds.top < 0) throw Error('Pairing link is not visibly usable');
    copy.click();
    for(let i=0;i<60 && copy.textContent==='Copy pairing link';i++) await new Promise(r=>setTimeout(r,50));
    const clipboardOutcome=copy.textContent;
    if (!/Link copied|Link selected/.test(clipboardOutcome)) throw Error('Copy action did not finish');
    if (clipboardOutcome.includes('selected') && (input.selectionStart!==0 || input.selectionEnd!==input.value.length)) throw Error('Manual selection is incomplete');
    // Also force denial so the fallback is covered on systems where clipboard
    // write permission happens to succeed without a permission request.
    const oldWrite=navigator.clipboard.writeText;
    const oldLegacy=document.execCommand;
    let legacyCalls=0;
    navigator.clipboard.writeText=async()=>{throw Error('simulated clipboard denial')};
    document.execCommand=()=>{legacyCalls++;return false;};
    try {
      copy.click();await new Promise(r=>setTimeout(r,50));
      if (!copy.textContent.includes('selected') || input.selectionStart!==0 || input.selectionEnd!==input.value.length) throw Error('Clipboard denial lost the link');
      if (legacyCalls!==1 || !status.textContent.includes('Could not copy automatically')) throw Error('Clipboard failure lacks fallback or visible guidance');
    } finally {navigator.clipboard.writeText=oldWrite;document.execCommand=oldLegacy;}
    return {requests:window.__pairingSmokeRequests,linkVisible:true,manualSelection:true,clipboardOutcome,googleGuidance:status.textContent.includes('Google sign-in')};
  })()`, true);
  if(result.requests!==1 || !result.googleGuidance) throw Error('Pairing fixture request or Google guidance missing');
  await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot=require('node:path').join(process.env.EMPIR3_DESKTOP_USER_DATA,'pairing-recovery.png');
  await require('node:fs/promises').writeFile(screenshot,(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  return {...result,interceptedNavigation:true,livePairing:false};
}
module.exports={runPairingSmoke};
