'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {execFileSync}=require('node:child_process');
const {applyPackagingPatches}=require('../scripts/apply-packaging-patches.cjs');

test('legacy minimatch copies lack the advisory optimization and bound its reported pattern',()=>{
 let checked=0;
 for(const parent of ['electron-installer-common','electron-winstaller','rimraf']) {
  const directory=join(__dirname,'../node_modules',parent,'node_modules/minimatch');
  if(!existsSync(directory)) continue; // platform-specific optional maker
  assert.equal(JSON.parse(readFileSync(join(directory,'package.json'),'utf8')).version,'3.1.5');
  const entry=require.resolve(directory); checked++;
  execFileSync(process.execPath,['-e',`const assert=require('node:assert/strict'); const mm=require(${JSON.stringify(entry)});
   assert.equal(mm.Minimatch.prototype.firstPhasePreProcess,undefined);
   assert.equal(mm.Minimatch.prototype.secondPhasePreProcess,undefined);
   const pattern='a/'.repeat(2000)+'**/../b'; mm('a/b',pattern,{optimizationLevel:2});`],{timeout:5000,stdio:'pipe',windowsHide:true});
 }
 assert.ok(checked>0);
});

test('the packaging lock has no vulnerable ZIP extractor and uses the patched image parser',()=>{
 const lock=JSON.parse(readFileSync(join(__dirname,'../package-lock.json'),'utf8'));
 assert.equal(Object.keys(lock.packages).some(p=>/(^|\/)node_modules\/extract-zip$/.test(p)),false);
 assert.equal(lock.packages['node_modules/image-size'].version,'2.0.4');
 assert.equal(lock.packages['node_modules/@electron-forge/core'].version,'8.0.1');
});

test('missing optional macOS patch dependencies cannot silently produce a package',()=>{
 const dir=mkdtempSync(join(tmpdir(),'empir3-dmg-patch-'));
 try {assert.throws(()=>applyPackagingPatches(dir,'darwin'),/requires appdmg/);}
 finally {rmSync(dir,{recursive:true,force:true});}
});

test('the new file parser reads valid backgrounds and bounds malformed ICNS input',{skip:process.platform!=='darwin'},()=>{
 assert.match(readFileSync(require.resolve('appdmg/lib/appdmg.js'),'utf8'),/const sizeOf = \(file, callback\) => imageSizeFromFile\(file\)\.then/);
 const dir=mkdtempSync(join(tmpdir(),'empir3-dmg-image-'));
 try {
  const valid=join(dir,'background.png'),bad=join(dir,'bad.icns');
  writeFileSync(valid,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0l0AAAAASUVORK5CYII=','base64'));
  const bytes=Buffer.alloc(16);bytes.write('icns');bytes.writeUInt32BE(16,4);bytes.write('ic07',8);writeFileSync(bad,bytes);
  execFileSync(process.execPath,['-e',`const assert=require('node:assert/strict');const {imageSizeFromFile}=require(${JSON.stringify(require.resolve('image-size/fromFile'))});
   (async()=>{const size=await imageSizeFromFile(${JSON.stringify(valid)});assert.equal(size.width,1);assert.equal(size.height,1);
   await assert.rejects(imageSizeFromFile(${JSON.stringify(bad)}));})().catch(e=>{console.error(e);process.exitCode=1});`],{timeout:5000,stdio:'pipe',windowsHide:true});
 } finally {rmSync(dir,{recursive:true,force:true});}
});
