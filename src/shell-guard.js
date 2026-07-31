/**
 * Shell command blocklist — the speed bump in front of desktop:execute.
 *
 * One combined list applied on every platform: a Windows box with git-bash
 * can run POSIX commands and a Linux box can have pwsh installed, so
 * splitting the lists per-platform only creates gaps. The patterns are
 * specific enough not to collide across platforms.
 *
 * Say it plainly (docs/SAFETY.md says it too): a regex blocklist is a speed
 * bump, not a boundary. On Linux the boundary is the service user plus the
 * systemd hardening block (NoNewPrivileges, ProtectSystem=full, …); a lent
 * Claude CLI can run arbitrary bash by design. This list exists to stop the
 * obvious catastrophic one-liners, not a determined attacker.
 */

'use strict';

/** @type {Array<[RegExp, string]>} */
const BLOCKED_SHELL_PATTERNS = [
  // ── destructive deletes (both platforms) ──
  [/\brm\s+-rf\b/i, 'recursive force delete (rm -rf)'],
  [/\brm\s+-r\b/i, 'recursive delete (rm -r)'],
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r)\w*\b/i, 'recursive force delete (rm combined flags)'],
  // NB: no \b before the dash — there is no word boundary between a space and
  // '-', so `\b-Recurse\b` never matched and the original inline pattern was
  // dead regex. Found by the first unit test ever pointed at it.
  [/\bRemove-Item\b(?=[^\r\n;]*-Recurse\b)(?=[^\r\n;]*-Force\b)/i, 'recursive force delete (Remove-Item -Recurse -Force)'],
  [/\bRemove-Item\b[^\r\n;]*(?:[A-Z]:\\(?:\s|$)|[A-Z]:\\\*)/i, 'drive-root delete (Remove-Item)'],
  [/\bdel\s+\/[sS]\b/i, 'recursive delete (del /s)'],
  [/\brmdir\s+\/[sS]\b/i, 'recursive directory removal (rmdir /s)'],
  [/\brd\s+\/[sS]\b/i, 'recursive directory removal (rd /s)'],
  [/\bClear-RecycleBin\b/i, 'recycle bin clear'],

  // ── disk / filesystem destruction ──
  [/\bformat\s+[a-zA-Z]:/i, 'disk format'],
  [/\bclear-disk\b/i, 'disk wipe'],
  [/\bdiskpart\b/i, 'disk partition tool'],
  [/\bmkfs(\.\w+)?\b/i, 'filesystem format (mkfs)'],
  [/\bdd\b[^\r\n;|&]*\bof=\/dev\//i, 'raw write to a device node (dd of=/dev/…)'],
  [/>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk)/i, 'raw write to a block device'],

  // ── power state ──
  [/\bRestart-Computer\b/i, 'system restart'],
  [/\bStop-Computer\b/i, 'system shutdown'],
  [/\bshutdown\b/i, 'system shutdown'],
  [/\breboot\b/i, 'system reboot'],
  [/\bsystemctl\s+(poweroff|reboot|halt|suspend|hibernate)\b/i, 'system power control (systemctl)'],

  // ── privilege / account escalation ──
  [/\breg\s+delete\b/i, 'registry deletion'],
  [/\bRemove-ItemProperty\b.*Registry/i, 'registry manipulation'],
  [/\bnet\s+user\b.*\/add/i, 'user account creation'],
  [/\bnet\s+localgroup\b.*administrators.*\/add/i, 'admin privilege escalation'],
  [/\bSet-ExecutionPolicy\b.*Unrestricted/i, 'execution policy bypass'],
  [/\/etc\/sudoers\b/i, 'sudoers access'],
  [/\bvisudo\b/i, 'sudoers modification'],

  // ── critical process kill ──
  [/\btaskkill\s+\/f\s+\/im\s+(svchost|csrss|lsass|winlogon)/i, 'critical process kill'],
  [/\bStop-Process\b.*-Name\s+(svchost|csrss|lsass|winlogon)/i, 'critical process kill'],

  // ── network / firewall sabotage ──
  [/\bDisable-NetAdapter\b/i, 'network adapter disable'],
  [/\biptables\s+(-F\b|--flush)/i, 'firewall flush (iptables)'],
  [/\bnft\s+flush\s+ruleset\b/i, 'firewall flush (nftables)'],
  [/\bufw\s+disable\b/i, 'firewall disable (ufw)'],

  // ── boot configuration ──
  [/\bbcdedit\b/i, 'boot configuration edit'],

  // ── remote-code-execution shapes ──
  [/\bInvoke-WebRequest\b.*-OutFile.*\.(exe|bat|ps1|cmd)/i, 'download and save executable'],
  [/\bcurl\b.*-o\s.*\.(exe|bat|ps1|cmd)/i, 'download executable'],
  [/\b(curl|wget)\b[^\r\n;]*\|[^\r\n;]*\b(sh|bash|zsh|dash)\b/i, 'download piped straight into a shell'],

  // ── fork bombs ──
  [/:\(\)\{.*\|.*\}/, 'fork bomb'],
  [/%0\|%0/, 'fork bomb (batch)'],
];

/**
 * @param {string} command
 * @returns {string|null} human-readable block reason, or null when allowed
 */
function checkShellCommand(command) {
  const text = String(command || '');
  for (const [pattern, reason] of BLOCKED_SHELL_PATTERNS) {
    if (pattern.test(text)) return `Command blocked: ${reason}`;
  }
  return null;
}

module.exports = { checkShellCommand, BLOCKED_SHELL_PATTERNS };
