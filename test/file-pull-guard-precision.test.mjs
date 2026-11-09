import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {blockedPosixReadPath,canonicalReadablePath} from '../src/path-guard.js';

// Run the actual shipping validator, with real disposable files. The previous
// board fixes lived only in the app repo and never changed this daemon.
const source=fs.readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const constants=source.slice(source.indexOf('const BLOCKED_EXT_READ ='),source.indexOf('const UNSAFE_FILENAME_CHARS'));
const fn=source.slice(source.indexOf('function validateReadableFilePath('),source.indexOf('\n/**',source.indexOf('function validateReadableFilePath(')));
const context=vm.createContext({...fs,basename:path.basename,extname:path.extname,expandUserPath:path.resolve,process:{platform:process.platform},parseAllowedRoots:()=>[],withinPath:()=>true,blockedPosixReadPath,canonicalReadablePath,
 AUTH_FILE:path.join(os.tmpdir(),'guard-private-auth.json'),SETTINGS_FILE:path.join(os.tmpdir(),'guard-private-settings.json'),CONFIG_FILE:path.join(os.tmpdir(),'guard-private-config.json')});
vm.runInContext(ts.transpileModule(constants+'\n'+fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
const validate=context.validateReadableFilePath;

test('ordinary data filenames and .dat pass the shipping file-pull guard',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'empir3-file-policy-'));
 try{
  for(const name of ['samples.csv','md5-sample-results.csv','system-report.csv','security-audit-notes.txt','shadowing-notes.txt','passwd-reset-counts.csv','session.dat','SESSION.DAT']){
   const file=path.join(dir,name);fs.writeFileSync(file,'ordinary data café ✓');
   const result=validate(file,1000);assert.equal(result.ok,true,`${name}: ${result.error}`);assert.equal(result.size,fs.statSync(file).size);
  }
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('credential names and protected extensions remain refused for real files and missing paths',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'empir3-private-policy-'));
 const at=name=>{const file=path.join(dir,name);fs.writeFileSync(file,'test-only secret');return validate(file,1000)};
 try {
 for(const name of ['SAM','SECURITY','SYSTEM','shadow','passwd'])assert.equal(at(name).ok,false,name);
 for(const name of ['private.pem','client.key','cert.pfx','key.p12','keys.jks','x.keystore','id_rsa','id_ed25519','known_hosts','authorized_keys','ntds.dit']){
  const r=at(name);assert.equal(r.ok,false,name);assert.match(r.error,/credential/);
 }
 for(const ext of ['sys','dll','drv','ocx','db','sqlite','ldb'])assert.match(at(`x.${ext}`).error,/system files/);
 assert.match(at('client.pem').error,/credential/);
 assert.match(at('.env.local').error,/credential/);
 assert.equal(validate(path.join(dir,'missing','.env.local'),1000).ok,false);
 if(process.platform==='win32'){
  assert.match(at('SAM').error,/whole filename/);
  assert.equal(validate('C:\\Windows\\session.dat',1000).ok,false);
 }
 } finally {fs.rmSync(dir,{recursive:true});}
});
