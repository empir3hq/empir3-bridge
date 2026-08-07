import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  LINUX_TERMINALS,
  resolveCliInstall,
  posixCommandLine,
  visibleShellScript,
  visibleTerminalPlan,
  cliPlatformSummary,
} = require_('../src/cli-platform.js');

test('GitHub install is never incorrectly mapped from macOS Homebrew to Linux', () => {
  const mac = resolveCliInstall('github', { platform: 'darwin' });
  const linux = resolveCliInstall('github', { platform: 'linux' });
  assert.equal(mac.command, 'brew install gh');
  assert.equal(mac.launchSupported, true);
  assert.match(linux.command, /official GitHub CLI instructions/i);
  assert.equal(linux.launchSupported, false);
  assert.match(linux.blocker, /distribution-specific/i);
});

test('Antigravity uses the vendor installer for each host family', () => {
  assert.match(resolveCliInstall('agy', { platform: 'win32' }).command, /install\.ps1/);
  assert.match(resolveCliInstall('agy', { platform: 'darwin' }).command, /install\.sh/);
  assert.match(resolveCliInstall('agy', { platform: 'linux' }).command, /install\.sh/);
});

test('headless Linux exposes a copyable command but refuses invisible terminal launch', () => {
  const install = resolveCliInstall('codex', { platform: 'linux', headless: true });
  assert.equal(install.command, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  assert.equal(install.launchSupported, false);
  assert.match(install.blocker, /SSH terminal/i);
  const summary = cliPlatformSummary('codex', { platform: 'linux', headless: true });
  assert.equal(summary.executionSupported, true);
  assert.equal(summary.authLaunchSupported, false);
});

test('headless mode blocks GUI installers on every operating system', () => {
  const install = resolveCliInstall('claude', { platform: 'win32', headless: true });
  assert.equal(install.launchSupported, false);
  assert.match(install.blocker, /headless/i);
});

test('POSIX command builder quotes executable paths and every argument', () => {
  assert.equal(
    posixCommandLine('/Applications/My CLI/bin/tool', ['auth', "user's account"]),
    "'/Applications/My CLI/bin/tool' 'auth' 'user'\"'\"'s account'",
  );
});

test('visible shell script scopes execution to the selected Bridge project', () => {
  const script = visibleShellScript("'codex' 'login'", "/Users/VK/Empir3 work", true);
  assert.match(script, /^cd '\/Users\/VK\/Empir3 work' &&/);
  assert.match(script, /Press Enter to close/);
});

test('macOS terminal plan activates Terminal with a safely quoted command', () => {
  const plan = visibleTerminalPlan({
    platform: 'darwin',
    command: "'codex' 'login'",
    cwd: '/Users/VK/Empir3',
  });
  assert.equal(plan.executable, 'osascript');
  assert.equal(plan.args[0], '-e');
  assert.match(plan.args[1], /tell application "Terminal" to do script/);
  assert.match(plan.args[3], /activate/);
});

test('Linux terminal plans cover every advertised launcher', () => {
  for (const terminal of LINUX_TERMINALS) {
    const plan = visibleTerminalPlan({
      platform: 'linux', terminal: `/usr/bin/${terminal}`,
      command: "'claude' 'auth' 'login'", cwd: '/home/vk/Empir3',
    });
    assert.equal(plan.executable, `/usr/bin/${terminal}`);
    assert.ok(plan.args.length >= 3, terminal);
  }
});
