import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {blockedPosixReadPath} from '../src/path-guard.js';

// Run the actual shipping validator, with real disposable files. The previous
// board fixes lived only in the app repo and never changed this daemon.
const source=fs.readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const constants=source.slice(source.indexOf('const BLOCKED_EXT_READ ='),source.indexOf('const UNSAFE_FILENAME_CHARS'));
const fn=source.slice(source.indexOf('function validateReadableFilePath('),source.indexOf('\n/**',source.indexOf('function validateReadableFilePath(')));
const context=vm.createContext({...fs,basename:path.basename,extname:path.extname,expandUserPath:path.resolve,process:{platform:process.platform},parseAllowedRoots:()=>[],withinPath:()=>true,blockedPosixReadPath});
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

test('credential names and protected extensions remain refused before file existence or reads',()=>{
 const at=name=>validate(path.join(os.tmpdir(),'empir3-policy-nonexistent',name),1000);
 for(const name of ['SAM','SECURITY','SYSTEM','shadow','passwd'])assert.equal(at(name).ok,false,name);
 for(const name of ['private.pem','client.key','cert.pfx','key.p12','keys.jks','x.keystore','id_rsa','id_ed25519','known_hosts','authorized_keys','ntds.dit']){
  const r=at(name);assert.equal(r.ok,false,name);assert.match(r.error,/credential/);
 }
 for(const ext of ['sys','dll','drv','ocx','db','sqlite','ldb'])assert.match(at(`x.${ext}`).error,/system files/);
 assert.match(at('client.pem').error,/filename "client.pem" contains ".pem".*nothing inside/);
 assert.match(at('.env.local').error,/filename ".env.local"/);
 if(process.platform==='win32'){
  assert.match(at('SAM').error,/whole filename/);
  assert.match(validate('C:\\Windows\\session.dat',1000).error,/system directory/);
 }
});
