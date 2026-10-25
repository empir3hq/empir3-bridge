import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { newerVersion, readSignedManifest, verifyArchive, nativeHash, assertSourceCompatible } = require('../build/payload-only');
const { signManifest } = require('../build/manifest-canonical');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const sha = b => createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'empir3-payload-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function manifestFile(dir, extra = {}) {
  const fields = { version: '1.2.3', schemaVersion: '2', platform: 'win32', arch: 'x64', ...extra };
  fields.manifestSignature = signManifest(fields, privateKey);
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(fields));
  return file;
}
test('payload versions must advance, including multi-digit components', () => {
  for (const [a,b] of [['0.3.107','0.3.106'],['1.10.0','1.9.9'],['2.0.0','1.99.99']]) assert.equal(newerVersion(a,b),true);
  for (const [a,b] of [['1.2.3','1.2.3'],['1.2.2','1.2.3'],['1.2.4-rc.1','1.2.3'],['01.2.4','1.2.3'],['../bad','1.2.3']]) assert.equal(newerVersion(a,b),false);
});
test('accepts authenticated Windows manifests and refuses tampering', t => {
  const file = manifestFile(fixture(t));
  assert.equal(readSignedManifest(file, publicKeyHex).version,'1.2.3');
  writeFileSync(file,readFileSync(file,'utf8').replace('1.2.3','1.2.4'));
  assert.throws(()=>readSignedManifest(file,publicKeyHex),/signature/);
});
test('refuses wrong platform and held/staged/rollback manifests', t => {
  const dir=fixture(t);
  for (const extra of [{platform:'linux'},{arch:'arm64'},{schemaVersion:'3',rolloutState:'hold',rolloutPercent:'0'},
    {schemaVersion:'3',rolloutState:'staged',rolloutPercent:'10'},{schemaVersion:'3',rolloutState:'rollback',rolloutPercent:'100'}]) {
    assert.throws(()=>readSignedManifest(manifestFile(dir,extra),publicKeyHex));
  }
  assert.equal(readSignedManifest(manifestFile(dir,{schemaVersion:'3',rolloutState:'live',rolloutPercent:'100'}),publicKeyHex).schemaVersion,'3');
});
test('archive hash and detached signature must both match', t => {
  const dir=fixture(t), data=Buffer.from('signed archive bytes');
  writeFileSync(join(dir,'payload.tar.gz'),data); writeFileSync(join(dir,'payload.sig'),sign(null,data,privateKey));
  assert.equal(verifyArchive(dir,'payload.tar.gz','payload.sig',sha(data),publicKeyHex),join(dir,'payload.tar.gz'));
  assert.throws(()=>verifyArchive(dir,'payload.tar.gz','payload.sig','0'.repeat(64),publicKeyHex),/hash\/signature/);
  writeFileSync(join(dir,'payload.sig'),Buffer.alloc(64));
  assert.throws(()=>verifyArchive(dir,'payload.tar.gz','payload.sig',sha(data),publicKeyHex),/hash\/signature/);
});
test('native inventory allows JS changes but detects tray/native dependency changes', t => {
  const dir=fixture(t); writeFileSync(join(dir,'Empir3Tray.exe'),'tray');
  mkdirSync(join(dir,'node_modules')); writeFileSync(join(dir,'node_modules','pty.node'),'pty');
  const original=nativeHash(dir); writeFileSync(join(dir,'bundle-server.js'),'new runtime');
  assert.equal(nativeHash(dir),original);
  writeFileSync(join(dir,'node_modules','pty.node'),'new native bytes'); assert.notEqual(nativeHash(dir),original);
  rmSync(join(dir,'Empir3Tray.exe')); assert.throws(()=>nativeHash(dir),/missing.*tray/);
});
test('reuse ref must match release and reject changed tray or native dependency', t => {
  const dir=fixture(t);
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q'); mkdirSync(join(dir,'tray')); writeFileSync(join(dir,'tray','tray.py'),'original');
  const pkg={version:'1.2.3',dependencies:{'node-pty':'^1.1.0'}};
  writeFileSync(join(dir,'package.json'),JSON.stringify(pkg));
  git('add','package.json','tray/tray.py');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture');
  const ref=git('rev-parse','HEAD'); assert.equal(assertSourceCompatible(dir,ref,'1.2.3'),ref);
  assert.throws(()=>assertSourceCompatible(dir,ref,'1.2.2'),/version/);
  writeFileSync(join(dir,'tray','tray.py'),'changed'); assert.throws(()=>assertSourceCompatible(dir,ref,'1.2.3'),/Native source/);
  writeFileSync(join(dir,'tray','tray.py'),'original'); pkg.dependencies['node-pty']='^2.0.0';
  writeFileSync(join(dir,'package.json'),JSON.stringify(pkg)); assert.throws(()=>assertSourceCompatible(dir,ref,'1.2.3'),/node-pty/);
});
test('publisher requires explicit phase and rejects override flags before networking', () => {
  for (const args of [[],['--dist','missing'],['--dist','missing','--prestage','--allow-legacy-only'],['--dist','missing','--prestage','--finalize']]) {
    const r=spawnSync(process.execPath,['scripts/publish-downloads.mjs','--payload-only','--dry-run',...args],{encoding:'utf8'});
    assert.equal(r.status,1); assert.match(r.stderr,/requires|overrides|mutually exclusive/);
    assert.doesNotMatch(r.stdout,/scp|ssh/);
  }
});
