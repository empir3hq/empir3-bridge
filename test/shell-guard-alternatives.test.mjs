/**
 * Blocked shell commands name a permitted alternative (Work Board c44eae5d):
 * an agent acting on an explicit "delete these folders" request should not
 * have to guess the blocklist's shape after a failed round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { checkShellCommand, BLOCKED_SHELL_PATTERNS } = require_('../src/shell-guard.js');

test('Remove-Item -Recurse -Force is refused with the reason and the allowed form', () => {
  const m = checkShellCommand('Remove-Item -Recurse -Force "C:\\Users\\me\\staging-a"');
  assert.match(m, /^Command blocked: recursive force delete \(Remove-Item -Recurse -Force\)\. Allowed alternative: Drop -Force: `Remove-Item -Recurse <path>` is allowed/);
});

test('the named alternative is actually allowed', () => {
  assert.equal(checkShellCommand('Remove-Item -Recurse "C:\\Users\\me\\staging-a"'), null);
  assert.equal(checkShellCommand('Remove-Item "C:\\Users\\me\\staging-a\\file.txt"'), null);
});

test('rm -rf and del /s carry alternatives too; unrelated rules keep the short form', () => {
  assert.match(checkShellCommand('rm -rf ./build'), /Allowed alternative: Delete specific files by name, or move the folder aside/);
  assert.match(checkShellCommand('del /s C:\\tmp\\x'), /Allowed alternative: Use PowerShell `Remove-Item -Recurse <path>` \(without -Force\)/);
  assert.equal(checkShellCommand('shutdown /s'), 'Command blocked: system shutdown');
});

test('every rule is a [pattern, reason] or [pattern, reason, alternative] triple', () => {
  for (const rule of BLOCKED_SHELL_PATTERNS) {
    assert.ok(rule[0] instanceof RegExp);
    assert.equal(typeof rule[1], 'string');
    if (rule.length > 2) assert.equal(typeof rule[2], 'string');
  }
});
