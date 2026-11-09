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

const { guardScanTarget } = require('./shell-surface.js');

/**
 * Patterns listed here match the CODE SURFACE (shell-surface.js) instead of
 * the raw command: quoted strings, heredoc bodies and comments are blanked
 * first, so a word inside a payload is data. Opt-in, one family at a time —
 * a path argument is usually quoted, and blanking it would weaken a guard
 * that is really matching on the path.
 *
 * The power-state family is here because of card f7d2fe85: a desktop command
 * whose payload said "34 days without a reboot" was refused as a system
 * reboot. These same patterns are also narrowed below to require the word to
 * stand as its own command token, so `reboot-notes.md` is a filename again.
 * @type {Set<string>}
 */
const SURFACE_SCOPED_REASONS = new Set([
  'system restart',
  'system shutdown',
  'system reboot',
  'system halt',
  'system power control (systemctl)',
]);

/**
 * [pattern, reason, allowedAlternative?]. When a third element is present the
 * refusal names it, so an agent acting on an explicit user request does not
 * have to guess the blocklist's shape (Work Board c44eae5d).
 * @type {Array<[RegExp, string] | [RegExp, string, string]>}
 */
const BLOCKED_SHELL_PATTERNS = [
  // ── destructive deletes (both platforms) ──
  [/\brm\s+-rf\b/i, 'recursive force delete (rm -rf)',
    'Delete specific files by name, or move the folder aside (`mv <path> <path>.trash`) and let the owner empty it.'],
  [/\brm\s+-r\b/i, 'recursive delete (rm -r)',
    'Delete specific files by name, or move the folder aside (`mv <path> <path>.trash`) and let the owner empty it.'],
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r)\w*\b/i, 'recursive force delete (rm combined flags)',
    'Delete specific files by name, or move the folder aside (`mv <path> <path>.trash`) and let the owner empty it.'],
  // NB: no \b before the dash — there is no word boundary between a space and
  // '-', so `\b-Recurse\b` never matched and the original inline pattern was
  // dead regex. Found by the first unit test ever pointed at it.
  [/\bRemove-Item\b(?=[^\r\n;]*-Recurse\b)(?=[^\r\n;]*-Force\b)/i, 'recursive force delete (Remove-Item -Recurse -Force)',
    'Drop -Force: `Remove-Item -Recurse <path>` is allowed (it is non-interactive from the Bridge and still removes the folder tree), or delete specific files by name.'],
  [/\bRemove-Item\b[^\r\n;]*(?:[A-Z]:\\(?:\s|$)|[A-Z]:\\\*)/i, 'drive-root delete (Remove-Item)'],
  [/\bdel\s+\/[sS]\b/i, 'recursive delete (del /s)', 'Use PowerShell `Remove-Item -Recurse <path>` (without -Force), or delete specific files by name.'],
  [/\brmdir\s+\/[sS]\b/i, 'recursive directory removal (rmdir /s)', 'Use PowerShell `Remove-Item -Recurse <path>` (without -Force), or delete specific files by name.'],
  [/\brd\s+\/[sS]\b/i, 'recursive directory removal (rd /s)', 'Use PowerShell `Remove-Item -Recurse <path>` (without -Force), or delete specific files by name.'],
  [/\bClear-RecycleBin\b/i, 'recycle bin clear'],

  // ── disk / filesystem destruction ──
  [/\bformat\s+[a-zA-Z]:/i, 'disk format'],
  [/\bclear-disk\b/i, 'disk wipe'],
  [/\bdiskpart\b/i, 'disk partition tool'],
  [/\bmkfs(\.\w+)?\b/i, 'filesystem format (mkfs)'],
  [/\bdd\b[^\r\n;|&]*\bof=\/dev\//i, 'raw write to a device node (dd of=/dev/…)'],
  [/>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk)/i, 'raw write to a block device'],

  // ── power state ──
  // Matched on the code surface (see SURFACE_SCOPED_REASONS) and pinned to
  // command position, optionally path-qualified (/sbin/reboot). A bare
  // \bword\b matched "34 days without a reboot" in a payload string and
  // `reboot-checklist.md` as a filename — card f7d2fe85.
  [/(^|[\s;|&(`'"])Restart-Computer(?![\w.-])/i, 'system restart'],
  [/(^|[\s;|&(`'"])Stop-Computer(?![\w.-])/i, 'system shutdown'],
  [/(^|[\s;|&(`'"])(?:[\w.\/-]*\/)?shutdown(?![\w.-])/i, 'system shutdown'],
  [/(^|[\s;|&(`'"])(?:[\w.\/-]*\/)?reboot(?![\w.-])/i, 'system reboot'],
  [/(^|[\s;|&(`'"])(?:[\w.\/-]*\/)?poweroff(?![\w.-])/i, 'system shutdown'],
  [/(^|[\s;|&(`'"])systemctl\s+(poweroff|reboot|halt|suspend|hibernate)\b/i, 'system power control (systemctl)'],

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
  // Computed once. guardScanTarget hands back the raw text whenever blanking
  // would be unsafe (a shell/interpreter/wrapper survives the blanking, or
  // the command does not parse), so `pwsh -c 'Restart-Computer'` is still
  // matched in full.
  const surface = guardScanTarget(text);
  for (const [pattern, reason, alternative] of BLOCKED_SHELL_PATTERNS) {
    const target = SURFACE_SCOPED_REASONS.has(reason) ? surface : text;
    if (pattern.test(target)) return `Command blocked: ${reason}` + (alternative ? `. Allowed alternative: ${alternative}` : '');
  }
  return null;
}

module.exports = { checkShellCommand, BLOCKED_SHELL_PATTERNS };
