'use strict';
const {spawn}=require('node:child_process');
const {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync}=require('node:fs');
const {resolve,join}=require('node:path');
const net=require('node:net');
const {prepareSmokeEnvironmentDirectories}=require('../src/smoke-isolation.cjs');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return String(port);}
async function main(){
 const executable=resolve(process.argv[2]||'');
 if(!process.argv[2]||!existsSync(executable)||!existsSync(join(resolve(executable,'..'),'resources','app.asar')))throw Error('Pass the isolated packaged executable with resources/app.asar');
 const out=resolve(__dirname,'..','out');mkdirSync(out,{recursive:true});const scratch=mkdtempSync(join(out,'pairing-smoke-'));
 const env={...process.env,HOME:scratch,USERPROFILE:scratch,APPDATA:join(scratch,'roaming'),LOCALAPPDATA:join(scratch,'local'),TEMP:join(scratch,'temp'),TMP:join(scratch,'temp'),XDG_CONFIG_HOME:join(scratch,'config'),XDG_DATA_HOME:join(scratch,'data'),EMPIR3_DESKTOP_USER_DATA:join(scratch,'electron'),EMPIR3_BRIDGE_PROFILE:join(scratch,'chrome'),EMPIR3_BRIDGE_NO_RELAY:'1',EMPIR3_PW_PORT:await freePort(),EMPIR3_BRIDGE_HTTP_PORT:await freePort(),EMPIR3_CDP_PORT:await freePort(),EMPIR3_DESKTOP_SMOKE_STATE_ROOT:join(scratch,'roaming'),EMPIR3_DESKTOP_SMOKE_ISOLATION_ROOT:scratch};
 delete env.ELECTRON_RUN_AS_NODE;
 prepareSmokeEnvironmentDirectories({isolationRoot:scratch,stateRoot:env.EMPIR3_DESKTOP_SMOKE_STATE_ROOT,userData:env.EMPIR3_DESKTOP_USER_DATA,env});
 const child=spawn(executable,['--pairing-smoke'],{cwd:resolve(__dirname,'..'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const timer=setTimeout(()=>child.kill(),120000);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)}).finally(()=>clearTimeout(timer));
 writeFileSync(join(scratch,'stdout.log'),stdout);writeFileSync(join(scratch,'stderr.log'),stderr);
 const line=stdout.split(/\r?\n/).find(l=>l.startsWith('{"ok":true'));
 if(code!==0||!line)throw Error(`Packaged pairing smoke exit ${code}; logs in ${scratch}\n${stderr.slice(-2500)}`);
 const receipt=JSON.parse(line);
 if(!receipt.managedBridge||receipt.attachedToExistingBridge||receipt.browserRunning||!receipt.pairingIntegration?.manualSelection||!receipt.pairingIntegration?.interceptedNavigation)throw Error('Incomplete pairing isolation/recovery receipt');
 const expected=JSON.parse(readFileSync(resolve(__dirname,'..','package.json'),'utf8')).version;
 if(receipt.version!==expected)throw Error(`Wrong package ${receipt.version}, expected ${expected}`);
 writeFileSync(join(scratch,'receipt.json'),JSON.stringify({executable,at:new Date().toISOString(),...receipt},null,2));
 console.log(JSON.stringify({ok:true,scratch,receipt}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
