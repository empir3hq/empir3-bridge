import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {signManifest}=require('../build/manifest-canonical.js');
const {buildReleaseManifestV3}=require('../build/release-manifest-v3.js');
const {buildPrestageReceipt,buildCandidate}=require('../scripts/publish-receipt.cjs');
const source=fs.readFileSync(new URL('../scripts/publish-downloads.mjs',import.meta.url),'utf8')
 .replace(/^#!.*\n/,'').replace(/^import .*;\r?\n/gm,'')
 .replace('const require = createRequire(import.meta.url);','')
 .replace("const root = resolve(fileURLToPath(new URL('..', import.meta.url)));",'const root = fixtureRoot;');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
class Exit extends Error{constructor(code){super('publisher exit');this.code=code;}}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'empir3-desktop-publisher-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dist=path.join(root,'candidate');fs.mkdirSync(dist);fs.mkdirSync(path.join(root,'build'));
 const keys=crypto.generateKeyPairSync('ed25519');
 const publicKeyHex=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 fs.writeFileSync(path.join(root,'build/payload-signing-pub.json'),JSON.stringify({publicKeyHex}));
 const put=(name,bytes)=>{fs.writeFileSync(path.join(dist,name),bytes);return Buffer.from(bytes);};
 const base='https://example.test/downloads',origin=new Map(),writes=[];
 const archive=(name,value)=>{const bytes=put(name+'.tar.gz',value);put(name+'.sig',crypto.sign(null,bytes,keys.privateKey));return bytes;};
 const payload=archive('bridge-payload-v0.3.123','real authenticated fixture123');
 const node=archive('node-win-x64-v24.13.0','previous published node');
 put('Empir3Setup.exe','existing bootstrap');
 const native=put('empir3-bridge-linux-x64-0.3.123.deb','native123');const releases=put('RELEASES','native update metadata123');
 const index={schemaVersion:1,version:'0.3.123',rollout:{channel:'production',state:'live',percent:100,seed:'fixture',previousVersion:'0.3.106'},artifacts:[
  {target:'desktop-linux-x64',platform:'linux',kind:'installer',publicName:'empir3-bridge-linux-x64-0.3.123.deb',format:'deb',sha256:hash(native),bytes:native.length,signed:true,authenticationScheme:'ed25519-manifest-sha256'},
  {target:'desktop-win32-x64',platform:'win32',kind:'update-metadata',publicName:'RELEASES',format:'squirrel-releases',sha256:hash(releases),bytes:releases.length,signed:true,authenticationScheme:'authenticode-azure-trusted-signing'},
 ]};for(const artifact of index.artifacts)artifact.url=base+'/'+artifact.publicName;
 const legacy={schemaVersion:'2',version:'0.3.123',nodeVersion:'24.13.0',payloadUrl:base+'/bridge-payload-v0.3.123.tar.gz',signatureUrl:base+'/bridge-payload-v0.3.123.sig',sha256:hash(payload),nodeUrl:base+'/node-win-x64-v24.13.0.tar.gz',nodeSignatureUrl:base+'/node-win-x64-v24.13.0.sig',nodeSha256:hash(node)};
 const save=()=>{const bytes=put('empir3-bridge-artifacts-v0.3.123.json',JSON.stringify(index));const fields=buildReleaseManifestV3(legacy,index,{artifactIndexUrl:base+'/empir3-bridge-artifacts-v0.3.123.json',artifactIndexSha256:hash(bytes)});fields.manifestSignature=signManifest(fields,keys.privateKey);put('bridge-desktop-version.json',JSON.stringify(fields));put('bridge-version.json',JSON.stringify(fields));return fields;};
 save();for(const name of ['Empir3Setup.exe','node-win-x64-v24.13.0.tar.gz','node-win-x64-v24.13.0.sig'])origin.set(name,fs.readFileSync(path.join(dist,name)));
 origin.set('bridge-version.json',Buffer.from('published legacy122'));origin.set('bridge-desktop-version.json',Buffer.from('published desktop106'));origin.set('bridge-payload-v0.3.122.tar.gz',Buffer.from('published payload122'));
 const record=()=>Object.fromEntries([...origin].filter(([name])=>name==='bridge-version.json'||name==='Empir3Setup.exe'||name.startsWith('node-')||name.includes('v0.3.122')).map(([name,bytes])=>[name,hash(bytes)]));
 const preserved=record();
 let publicFailure='',transportWrites=0;
 function spawnSync(command,args){
  const success=(stdout='')=>({status:0,stdout});const failure=()=>({status:1,stdout:''});
  if(command==='scp'){const name=path.posix.basename(args[1].slice(args[1].indexOf(':')+1));origin.set(name,fs.readFileSync(args[0]));writes.push(name);transportWrites++;return success();}
  assert.equal(command,'ssh');const cmd=args.at(-1);
  if(cmd.startsWith('mkdir '))return success();
  if(cmd.startsWith('sha256sum ')){const name=path.posix.basename(cmd.match(/'([^']+)'/)[1]);return success(origin.has(name)?hash(origin.get(name))+'  '+name:'missing');}
  if(cmd.startsWith('curl ')){if(cmd.includes('grep -q 200'))return success();const url=new URL(cmd.match(/'([^']+)'/)[1]),name=path.posix.basename(url.pathname);return success(publicFailure===name?'bad':origin.has(name)?hash(origin.get(name)):'missing');}
  if(cmd.startsWith('test ')){
   const comparisons=[...cmd.matchAll(/sha256sum '([^']+)' \| cut -d ' ' -f 1\)" = '([a-f0-9]+)'/g)];
   const first=comparisons[0];assert(first,'hash assertion expected');if(hash(origin.get(path.posix.basename(first[1]))||'')!==first[2])return failure();
   if(cmd.includes('(ln ')){const m=cmd.match(/\(ln '([^']+)' '([^']+)'/);const from=path.posix.basename(m[1]),to=path.posix.basename(m[2]);if(origin.has(to)&&hash(origin.get(to))!==hash(origin.get(from)))return failure();origin.set(to,origin.get(from));writes.push(to);origin.delete(from);return success();}
   for(const m of comparisons.slice(1))if(hash(origin.get(path.posix.basename(m[1]))||'')!==m[2])return failure();
  }
  if(cmd.includes('mv -f ')){const m=cmd.match(/mv -f '([^']+)' '([^']+)'/),from=path.posix.basename(m[1]),to=path.posix.basename(m[2]);origin.set(to,origin.get(from));origin.delete(from);writes.push(to);return success();}
  if(cmd.startsWith('rm -f '))return success();
  assert.fail('Unexpected mocked transport command: '+cmd);
 }
 function run(flags=[],options={}){
  const messages=[];const scopedRequire=id=>{
   if(id==='../build/payload-only'&&options.payloadFixture)return {...require(id),validatePayloadOnly:()=>({})};
   if(id==='./defender-scan.cjs'&&options.payloadFixture)return {scanWithDefender:()=>({})};
   if(id.startsWith('./'))return require('../scripts/'+id.slice(2));return require(id);
  };
  const ctx=vm.createContext({...fs,...path,...os,createHash:crypto.createHash,URL,Buffer,fixtureRoot:root,require:scopedRequire,spawnSync,
   process:{argv:['node','publish','--dist',dist,'--receipt',path.join(dist,'receipt.json'),...flags],pid:123,env:{EMPIR3_DOWNLOAD_HOST:'fixture@origin',EMPIR3_DOWNLOAD_DIR:'/downloads',EMPIR3_PAYLOAD_PUBLIC_URL_BASE:base},exit:code=>{throw new Exit(code);}},
   console:{log:(...x)=>messages.push(x.join(' ')),error:(...x)=>messages.push(x.join(' '))},
  });
  try{vm.runInContext(source,ctx);return {code:0,messages};}catch(error){if(error instanceof Exit)return {code:error.code,messages};throw error;}
 }
 return {root,dist,origin,writes,run,save,index,legacy,keys,put,record,preserved,setPublicFailure:name=>{publicFailure=name;},getTransportWrites:()=>transportWrites};
}
test('explicit live desktop-only pre-stage/finalize authenticates dependencies and preserves legacy122/bootstrap/node',t=>{
 const f=fixture(t);let r=f.run(['--desktop-only','--prestage']);assert.equal(r.code,0,r.messages.join('\n'));assert.deepEqual(f.record(),f.preserved);
 assert(!f.writes.includes('RELEASES'));assert(!f.writes.includes('bridge-desktop-version.json'));assert(f.origin.has('bridge-payload-v0.3.123.tar.gz'));
 const receipt=JSON.parse(fs.readFileSync(path.join(f.dist,'receipt.json')));assert.equal(receipt.candidate.releaseKind,'desktop-only-explicit');assert.deepEqual(receipt.candidate.fixedFiles.map(x=>x.name),['RELEASES','bridge-desktop-version.json']);
 f.writes.length=0;r=f.run(['--desktop-only','--finalize']);assert.equal(r.code,0,r.messages.join('\n'));assert.deepEqual(f.record(),f.preserved);
 assert.deepEqual(f.writes.filter(name=>!name.endsWith('.uploading')),['RELEASES','bridge-desktop-version.json']);
 assert.equal(f.run(['--desktop-only','--finalize']).code,1);
});
test('explicit mode rejects missing desktop file and unsupported combinations before transport',t=>{
 const f=fixture(t);for(const flags of [['--desktop-only'],['--desktop-only','--prestage','--payload-only'],['--desktop-only','--prestage','--allow-legacy-only'],['--desktop-only','--prestage','--allow-unsigned-desktop'],['--desktop-only','--prestage','--finalize']])assert.equal(f.run(flags).code,1);
 fs.unlinkSync(path.join(f.dist,'bridge-desktop-version.json'));assert.equal(f.run(['--desktop-only','--prestage']).code,1);assert.equal(f.getTransportWrites(),0);
});
test('signature, index and artifact drift fail before transport',t=>{
 const f=fixture(t);
 for(const name of ['bridge-desktop-version.json','empir3-bridge-artifacts-v0.3.123.json','empir3-bridge-linux-x64-0.3.123.deb','bridge-payload-v0.3.123.sig']){
  const file=path.join(f.dist,name),before=fs.readFileSync(file);fs.writeFileSync(file,name.endsWith('.json')?before.toString().replace('0.3.123','0.3.999'):'altered');assert.equal(f.run(['--desktop-only','--prestage']).code,1,name);fs.writeFileSync(file,before);
 }
 assert.equal(f.getTransportWrites(),0);
});

test('authenticated wrong schema and index version/rollout mismatch fail before transport',t=>{
 const f=fixture(t);const manifestPath=path.join(f.dist,'bridge-desktop-version.json');
 const original=fs.readFileSync(manifestPath),indexPath=path.join(f.dist,'empir3-bridge-artifacts-v0.3.123.json'),originalIndex=fs.readFileSync(indexPath);
 for(const change of ['schema','version','rollout']){
  const fields=JSON.parse(original),index=JSON.parse(originalIndex);
  if(change==='schema')fields.schemaVersion='2';
  else{if(change==='version')index.version='0.3.999';else index.rollout.percent=10;const bytes=Buffer.from(JSON.stringify(index));fs.writeFileSync(indexPath,bytes);fields.artifactIndexSha256=hash(bytes);}
  fields.manifestSignature=signManifest(fields,f.keys.privateKey);fs.writeFileSync(manifestPath,JSON.stringify(fields));
  assert.equal(f.run(['--desktop-only','--prestage']).code,1,change);
  fs.writeFileSync(manifestPath,original);fs.writeFileSync(indexPath,originalIndex);
 }
 assert.equal(f.getTransportWrites(),0);
});
test('immutable collisions and public failures prevent fixed activation',t=>{
 const f=fixture(t);f.origin.set('bridge-payload-v0.3.123.tar.gz',Buffer.from('collision'));assert.equal(f.run(['--desktop-only','--prestage']).code,1);assert.equal(f.origin.get('bridge-payload-v0.3.123.tar.gz').toString(),'collision');assert.deepEqual(f.record(),f.preserved);
 f.origin.delete('bridge-payload-v0.3.123.tar.gz');f.setPublicFailure('empir3-bridge-linux-x64-0.3.123.deb');assert.equal(f.run(['--desktop-only','--prestage']).code,1);assert(!f.writes.includes('RELEASES'));
});
test('wrong-mode receipt, changed fixed bytes and remote drift refuse finalization',t=>{
 const f=fixture(t);assert.equal(f.run(['--desktop-only','--prestage']).code,0);const file=path.join(f.dist,'receipt.json'),original=fs.readFileSync(file),receipt=JSON.parse(original);
 receipt.candidate.releaseKind='live';fs.writeFileSync(file,JSON.stringify(buildPrestageReceipt(receipt.candidate)));assert.equal(f.run(['--desktop-only','--finalize']).code,1);fs.writeFileSync(file,original);
 f.origin.set('empir3-bridge-linux-x64-0.3.123.deb',Buffer.from('drift'));assert.equal(f.run(['--desktop-only','--finalize']).code,1);assert(!f.writes.includes('RELEASES'));
 assert.deepEqual(f.record(),f.preserved);
});
test('default live promotion and implicit held mode retain their existing routing',t=>{
 const f=fixture(t);assert.equal(f.run(['--prestage']).code,0);assert.equal(f.run(['--finalize']).code,0);assert(f.writes.indexOf('bridge-version.json')<f.writes.lastIndexOf('Empir3Setup.exe'));
 f.index.rollout.state='hold';f.index.rollout.percent=0;f.save();f.writes.length=0;
 assert.equal(f.run(['--prestage']).code,0);const receipt=JSON.parse(fs.readFileSync(path.join(f.dist,'receipt.json')));assert.equal(receipt.candidate.releaseKind,'desktop-only');assert.equal(f.run(['--desktop-only','--finalize']).code,1);assert(!f.writes.includes('bridge-version.json'));
});
test('two-channel sequence retains exact122 base for unchanged payload124 publisher and rejects intervening base/native drift',t=>{
 const f=fixture(t);assert.equal(f.run(['--desktop-only','--prestage']).code,0);assert.equal(f.run(['--desktop-only','--finalize']).code,0);assert.deepEqual(f.record(),f.preserved);
 const payload=Buffer.from('new payload124'),fields={...f.legacy,version:'0.3.124',releaseKind:'windows-payload-only',baseManifestSha256:f.preserved['bridge-version.json'],reusedBootstrapSha256:f.preserved['Empir3Setup.exe'],sha256:hash(payload),payloadUrl:f.legacy.payloadUrl.replace('123','124'),signatureUrl:f.legacy.signatureUrl.replace('123','124')};
 fields.manifestSignature=signManifest(fields,f.keys.privateKey);f.put('bridge-version.json',JSON.stringify(fields));f.put('bridge-payload-v0.3.124.tar.gz',payload);f.put('bridge-payload-v0.3.124.sig',crypto.sign(null,payload,f.keys.privateKey));
 assert.equal(f.run(['--payload-only','--prestage'],{payloadFixture:true}).code,0);
 for(const name of ['bridge-version.json','Empir3Setup.exe','node-win-x64-v24.13.0.tar.gz']){const before=f.origin.get(name);f.origin.set(name,Buffer.from('intervening drift'));assert.equal(f.run(['--payload-only','--finalize'],{payloadFixture:true}).code,1,name);f.origin.set(name,before);}
 const desktop=hash(f.origin.get('bridge-desktop-version.json'));assert.equal(f.run(['--payload-only','--finalize'],{payloadFixture:true}).code,0);assert.equal(JSON.parse(f.origin.get('bridge-version.json')).version,'0.3.124');assert.equal(hash(f.origin.get('bridge-desktop-version.json')),desktop);
});
