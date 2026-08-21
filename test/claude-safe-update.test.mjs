import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { safeUpdateClaudeOnWindows, selectLatestMatchedClaudeVersion } from '../src/claude-safe-update.ts';

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('selects the newest root release that has a matching Windows native package', () => {
  assert.equal(selectLatestMatchedClaudeVersion({
    'dist-tags': { latest: '2.1.238' },
    versions: { '2.1.236': {}, '2.1.237': {}, '2.1.238': {} },
  }, {
    versions: { '2.1.236': {}, '2.1.237': {} },
  }), '2.1.237');
});

test('Windows npm and Claude cmd shims run through explicit cmd argv handling', () => {
  assert.match(serverSource, /isWindowsShim = \/\\\.\(cmd\|bat\)\$\/i\.test\(file\)/);
  assert.match(serverSource, /runProcess\('cmd\.exe', \['\/d', '\/s', '\/c', file, \.\.\.args\], options\)/);
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
