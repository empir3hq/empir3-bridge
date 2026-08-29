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
  resolveCliLifecycle,
  extractSemanticVersion,
  compareSemanticVersions,
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

test('Windows Higgsfield automation stays paused while Defender blocks the official binary', () => {
  const windows = resolveCliInstall('higgsfield', { platform: 'win32' });
  const mac = resolveCliInstall('higgsfield', { platform: 'darwin' });
  assert.equal(windows.launchSupported, false);
  assert.match(windows.note, /Trojan:Win32\/Bearfoos\.A!ml/);
  assert.match(windows.blocker, /Do not bypass Windows Security/i);
  assert.equal(mac.launchSupported, true);
});

test('CLI lifecycle catalog exposes only fixed vendor actions', () => {
  const higgsfieldWindows = resolveCliLifecycle('higgsfield', { platform: 'win32' });
  const higgsfieldMac = resolveCliLifecycle('higgsfield', { platform: 'darwin' });
  assert.equal(higgsfieldWindows.checkSupported, true);
  assert.equal(higgsfieldWindows.latestSource, 'npm registry');
  assert.equal(higgsfieldWindows.update.launchSupported, false);
  assert.equal(higgsfieldMac.update.command, 'npm install -g @higgsfield/cli@latest');
  assert.equal(higgsfieldWindows.deauthorize.command, 'higgsfield auth logout');
  assert.equal(higgsfieldWindows.deauthorize.mode, 'command');

  const agy = resolveCliLifecycle('agy', { platform: 'win32' });
  assert.equal(agy.checkSupported, false);
  assert.equal(agy.update.command, 'agy update');
  assert.equal(agy.deauthorize.mode, 'interactive');
  assert.match(agy.deauthorize.instruction, /\/logout/);
});

test('GitHub update policy stays platform-specific', () => {
  const windows = resolveCliLifecycle('github', { platform: 'win32' });
  const mac = resolveCliLifecycle('github', { platform: 'darwin' });
  const linux = resolveCliLifecycle('github', { platform: 'linux' });
  assert.match(windows.update.command, /^winget upgrade/);
  assert.equal(mac.update.command, 'brew upgrade gh');
  assert.equal(linux.update.launchSupported, false);
  assert.match(linux.update.blocker, /Linux distribution/i);
});

test('headless lifecycle actions stay copyable but never claim to launch', () => {
  const codex = resolveCliLifecycle('codex', { platform: 'linux', headless: true });
  assert.equal(codex.update.command, 'codex update');
  assert.equal(codex.update.launchSupported, false);
  assert.equal(codex.deauthorize.launchSupported, false);
});

test('semantic version helpers normalize probe text and compare releases', () => {
  assert.equal(extractSemanticVersion('codex-cli 0.142.4'), '0.142.4');
  assert.equal(extractSemanticVersion('gh version 2.96.0 (2026-07-02)'), '2.96.0');
  assert.equal(compareSemanticVersions('0.142.4', '0.147.0'), -1);
  assert.equal(compareSemanticVersions('grok 1.0.0 [stable]', '1.0.0'), 0);
  assert.equal(compareSemanticVersions('2.1.227', '2.1.227-beta.1'), 1);
  assert.equal(compareSemanticVersions('installed', '2.1.227'), null);
});
