/**
 * CLI "Update now" preflight (Work Board d980815c): already-current is a
 * no-op that says so; a locked executable names the holders and the action
 * to take; otherwise the vendor updater runs as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const { decideCliUpdatePreflight, lockHolderMessage, parseProcessHolders, windowsHolderProbeScript } = require_('../src/cli-update-preflight.js');

test('already current → no installer, plain message with the version', () => {
  const v = decideCliUpdatePreflight({ provider: 'codex', latestRow: { status: 'current', installedVersion: '0.152.0', latestVersion: '0.152.0' } });
  assert.equal(v.kind, 'current');
  assert.equal(v.message, 'codex is already up to date (0.152.0); nothing was installed.');
});

test('update available and nothing holds the binary → proceed', () => {
  const v = decideCliUpdatePreflight({ provider: 'codex', latestRow: { status: 'update_available', installedVersion: '0.151.0', latestVersion: '0.152.0' }, holders: [] });
  assert.equal(v.kind, 'proceed');
  assert.equal(v.latestVersion, '0.152.0');
});

test('unknown version state does not block the update', () => {
  assert.equal(decideCliUpdatePreflight({ provider: 'grok', latestRow: { status: 'unknown', installedVersion: null }, holders: [] }).kind, 'proceed');
  assert.equal(decideCliUpdatePreflight({ provider: 'grok', latestRow: null }).kind, 'proceed');
});

test('the owner-observed case: three Codex MCP servers under Claude Code sessions → refused with names, no npm run', () => {
  const holders = [
    { pid: 15600, name: 'codex.exe', parentPid: 20980, parentName: 'claude.exe' },
    { pid: 23312, name: 'codex.exe', parentPid: 23508, parentName: 'claude.exe' },
    { pid: 26524, name: 'codex.exe', parentPid: 25992, parentName: 'claude.exe' },
  ];
  const v = decideCliUpdatePreflight({ provider: 'codex', latestRow: { status: 'update_available', installedVersion: '0.151.0', latestVersion: '0.152.0' }, holders });
  assert.equal(v.kind, 'locked');
  assert.match(v.message, /3 Claude Code sessions still have codex open/);
  assert.match(v.message, /PIDs 15600, 23312, 26524/);
  assert.match(v.message, /Close them, then click Update again\. Nothing was changed\./);
  assert.doesNotMatch(v.message, /EBUSY|npm ERR/);
});

test('force reinstall skips the already-current short-circuit but still respects locks', () => {
  const row = { status: 'current', installedVersion: '1.0.0', latestVersion: '1.0.0' };
  assert.equal(decideCliUpdatePreflight({ provider: 'gemini', latestRow: row, force: true }).kind, 'proceed');
  assert.equal(decideCliUpdatePreflight({ provider: 'gemini', latestRow: row, force: true, holders: [{ pid: 4, name: 'node.exe', parentName: 'Code.exe' }] }).kind, 'locked');
});

test('lock message groups holders by the app that owns them', () => {
  const m = lockHolderMessage('gemini', [
    { pid: 1, name: 'node.exe', parentName: 'Code.exe' },
    { pid: 2, name: 'node.exe', parentName: 'WindowsTerminal.exe' },
  ]);
  assert.match(m, /1 VS Code window, 1 Windows Terminal tab/);
});

test('process probe output is parsed defensively and the script targets the install directory', () => {
  const parsed = parseProcessHolders(JSON.stringify([{ ProcessId: 10, Name: 'codex.exe', ExecutablePath: 'C:\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe', ParentProcessId: 9, ParentName: 'claude.exe' }]));
  assert.deepEqual(parsed, [{ pid: 10, name: 'codex.exe', path: 'C:\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe', parentPid: 9, parentName: 'claude.exe' }]);
  assert.deepEqual(parseProcessHolders('not json'), []);
  assert.deepEqual(parseProcessHolders(''), []);
  assert.equal(parseProcessHolders(JSON.stringify({ ProcessId: 3, Name: 'x' })).length, 1, 'single object from ConvertTo-Json');
  const script = windowsHolderProbeScript("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex");
  assert.match(script, /\$root = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'/);
  assert.match(script, /StartsWith\(\$root, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(script, /ConvertTo-Json -Compress/);
});

test('server runs the preflight before launching any updater', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const fn = server.slice(server.indexOf('async function completeCliUpdate('), server.indexOf('async function completeCliUpdate(') + 900);
  assert.ok(fn.indexOf('await preflightCliUpdate(provider)') < fn.indexOf('await launchProviderUpdate(provider)'), 'preflight precedes launch');
  assert.match(fn, /if \(preflight\.kind === 'current'\) return \{ warnings: \[preflight\.message\] \};/);
  assert.match(fn, /if \(preflight\.kind === 'locked'\) throw new Error\(preflight\.message\);/);
});
