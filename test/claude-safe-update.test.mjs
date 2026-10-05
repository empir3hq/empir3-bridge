import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import sourceModule1 from '../src/claude-safe-update.ts';
const { safeUpdateClaudeOnWindows, selectLatestMatchedClaudeVersion } = sourceModule1;

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('uncertain owned cleanup stops every update/rollback phase and propagates its admission hold',async()=>{
 for(const [label,uncertainAt,rollback] of [['initial version',0,false],['install',1,false],['wiring',2,false],['verification',3,false],['rollback install',2,true],['rollback wiring',3,true],['rollback verification',4,true]]){
  const cleanupPending=new Promise(()=>{});let calls=0;
  await assert.rejects(safeUpdateClaudeOnWindows({
   claudeCommand:'fixture',npmCommand:'fixture-npm',arch:'x64',npmGlobalRoot:'C:/synthetic',fileExists:()=>true,
   fetchMetadata:async()=>({'dist-tags':{latest:'2.1.237'},versions:{'2.1.236':{},'2.1.237':{}}}),
   run:async(_file,args)=>{
    const call=calls++;
    if(call===uncertainAt)return {code:-2,stdout:'',stderr:'',timedOut:true,cleanupPending};
    if(rollback&&call===1)return {code:1,stdout:'',stderr:'synthetic install failure',timedOut:false};
    return {code:0,stdout:args[0]==='--version'?(call===0?'2.1.236':'2.1.237'):'',stderr:'',timedOut:false};
   },
  }),error=>error.cleanupPending===cleanupPending,label);
  assert.equal(calls,uncertainAt+1,label+' must not start another mutating step');
 }
});

test('selects the newest root release that has a matching Windows native package', () => {
  assert.equal(selectLatestMatchedClaudeVersion({
    'dist-tags': { latest: '2.1.238' },
    versions: { '2.1.236': {}, '2.1.237': {}, '2.1.238': {} },
  }, {
    versions: { '2.1.236': {}, '2.1.237': {} },
  }), '2.1.237');
});

test('Windows npm and Claude cmd shims run through a fully quoted verbatim cmd string', () => {
  assert.match(serverSource, /isWindowsShim = \/\\\.\(cmd\|bat\)\$\/i\.test\(file\)/);
  // The args-array form breaks on space-bearing shim paths ("C:\Program Files\
  // nodejs\npm.cmd"): node quotes the path, cmd's /s strips the outer quotes of
  // the whole /c string, and cmd executes 'C:\Program'. The runner must build
  // the documented /s form itself and pass it verbatim.
  assert.match(serverSource, /commandLine = `\/d \/s \/c "\$\{\[file, \.\.\.args\]\.map\(quoteForCmd\)\.join\(' '\)\}"`/);
  assert.match(serverSource, /runProcess\('cmd\.exe', \[commandLine\], \{ \.\.\.options, verbatim: true \}\)/);
});

test('verbatim cmd command line quotes space-bearing shim paths for /s re-parsing', () => {
  const quoteForCmd = (value) => (/[\s&()^%!"<>|]/.test(value) ? `"${value}"` : value);
  const file = 'C:\\Program Files\\nodejs\\npm.cmd';
  const args = ['root', '-g'];
  const commandLine = `/d /s /c "${[file, ...args].map(quoteForCmd).join(' ')}"`;
  assert.equal(commandLine, '/d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" root -g"');
});

test('runs postinstall, verifies the target, and reports success', async () => {
  const calls = [];
  const run = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (args[0] === '--version') {
      const installs = calls.filter(call => call.args[0] === 'install');
      return { code: 0, stdout: installs.length ? '2.1.237 (Claude Code)' : '2.1.236 (Claude Code)', stderr: '', timedOut: false };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  const result = await safeUpdateClaudeOnWindows({
    claudeCommand: 'claude.cmd', npmCommand: 'npm.cmd', nodeCommand: 'node.exe', arch: 'x64',
    npmGlobalRoot: 'C:/npm/node_modules', run, fileExists: () => true,
    fetchMetadata: async (name) => name.endsWith('win32-x64')
      ? { versions: { '2.1.237': {} } }
      : { 'dist-tags': { latest: '2.1.237' }, versions: { '2.1.236': {}, '2.1.237': {} } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '2.1.237');
  assert.ok(calls.some(call => call.file === 'node.exe' && call.args[0].endsWith('install.cjs')));
});

test('a successful verified update reports cleanup warnings without echoing command output', async () => {
  let installed=false;
  const result=await safeUpdateClaudeOnWindows({
    claudeCommand:'claude.cmd',npmCommand:'npm.cmd',arch:'x64',npmGlobalRoot:'C:/synthetic',fileExists:()=>true,
    fetchMetadata:async()=>({'dist-tags':{latest:'2.1.237'},versions:{'2.1.236':{},'2.1.237':{}}}),
    run:async(_file,args)=>{
      if(args[0]==='--version')return {code:0,stdout:installed?'2.1.237':'2.1.236',stderr:'',timedOut:false};
      if(args[0]==='install'){installed=true;return {code:0,stdout:'',stderr:'npm warn cleanup EPERM rmdir C:/synthetic/PRIVATE_SENTINEL',timedOut:false};}
      return {code:0,stdout:'',stderr:'',timedOut:false};
    },
  });
  assert.equal(result.ok,true);assert.equal(result.verified,true);
  assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/cleanup warning/);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SENTINEL/);
});

test('rolls back and re-verifies the prior version when the new binary fails', async () => {
  let installedVersion = '2.1.236';
  const run = async (_file, args) => {
    if (args[0] === 'install') installedVersion = args[2].split('@').at(-1);
    if (args[0] === '--version') {
      if (installedVersion === '2.1.237') return { code: 1, stdout: '', stderr: 'stub missing', timedOut: false };
      return { code: 0, stdout: `${installedVersion} (Claude Code)`, stderr: '', timedOut: false };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  const result = await safeUpdateClaudeOnWindows({
    claudeCommand: 'claude.cmd', npmCommand: 'npm.cmd', arch: 'x64', npmGlobalRoot: 'C:/npm/node_modules',
    run, fileExists: () => true,
    fetchMetadata: async (name) => name.endsWith('win32-x64')
      ? { versions: { '2.1.237': {} } }
      : { 'dist-tags': { latest: '2.1.237' }, versions: { '2.1.236': {}, '2.1.237': {} } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.version, '2.1.236');
  assert.equal(result.verified, true);
});
