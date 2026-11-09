'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('installer failure survives cleanup and retains its diagnostic fixture', async () => {
  const errors = [];
  let cleanupCalls = 0;
  let exitCode;
  const source = readFileSync(path.join(__dirname, '../scripts/smoke-windows-installer.cjs'), 'utf8');
  const fakeFs = {
    existsSync: name => name.endsWith(path.join('out', 'make')),
    mkdirSync() {},
    mkdtempSync: () => path.join('fixture', 'failed-install'),
    readdirSync: () => ['Empir3 Bridge-0.4.12 Setup.exe'],
    readFileSync: () => JSON.stringify({ version: '0.4.12' }),
    rmSync() {
      cleanupCalls++;
      throw new Error('EPERM: locked diagnostic profile');
    },
    statSync: () => ({ isDirectory: () => false, isFile: () => true }),
    writeFileSync() {},
  };
  await vm.runInNewContext(source, {
    __dirname: path.join(__dirname, '../scripts'),
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:os') return { tmpdir: () => 'fixture' };
      if (name === 'node:child_process') {
        return { spawnSync: () => ({ status: 23, stderr: 'original installer failure' }) };
      }
      if (name === 'node:path') return path;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: {
      platform: 'win32', pid: 123,
      env: { CI: 'true', LOCALAPPDATA: path.join('fixture', 'local') },
      exit(code) { exitCode = code; },
    },
    console: { error: (...args) => errors.push(args.join(' ')) },
  });
  assert.equal(exitCode, 1);
  assert.match(errors.join('\n'), /original installer failure/);
  assert.match(errors.join('\n'), /Failed fixture retained at/);
  assert.equal(cleanupCalls, 0, 'failed-run diagnostics must survive');
});
