/**
 * CLI "Update now" preflight (Work Board d980815c).
 *
 * Clicking Update on an already-current CLI used to shell out anyway and, on
 * Windows, fail with a raw npm EBUSY stack when another process (one Codex
 * MCP server per open Claude Code session) held the executable open. Nothing
 * was wrong; the pane looked like a corrupted install.
 *
 * decideCliUpdatePreflight() turns what we already know — the installed vs
 * registry versions and the processes holding the CLI's install directory —
 * into one of three verdicts before anything is launched:
 *   current  → nothing to do; say so, run no installer
 *   locked   → refuse with the holders named and the action to take
 *   proceed  → launch the vendor updater as before
 * The verdict is pure so the wording and the edge cases are pinned by tests;
 * the server supplies the version row and the process probe.
 */

'use strict';

/**
 * @param {object} input
 * @param {string} input.provider           'codex', 'gemini', …
 * @param {{status?:string, installedVersion?:string|null, latestVersion?:string|null}|null} input.latestRow
 * @param {Array<{pid:number, name:string, path?:string, parentName?:string|null, parentPid?:number|null}>} [input.holders]
 * @param {boolean} [input.force]           user explicitly asked to reinstall even when current
 */
function decideCliUpdatePreflight({ provider, latestRow, holders = [], force = false }) {
  const row = latestRow || {};
  const installed = row.installedVersion || null;
  const latest = row.latestVersion || null;
  if (!force && row.status === 'current' && installed) {
    return {
      kind: 'current',
      installedVersion: installed,
      latestVersion: latest,
      message: `${provider} is already up to date (${installed}); nothing was installed.`,
    };
  }
  const live = (Array.isArray(holders) ? holders : []).filter((h) => h && Number(h.pid) > 0);
  if (live.length) {
    return {
      kind: 'locked',
      holders: live,
      installedVersion: installed,
      latestVersion: latest,
      message: lockHolderMessage(provider, live),
    };
  }
  return { kind: 'proceed', installedVersion: installed, latestVersion: latest };
}

/**
 * "Close 3 Claude Code sessions running the Codex MCP server, then retry."
 * Groups holders by parent so the user hears which apps to close, not PIDs.
 */
function lockHolderMessage(provider, holders) {
  const byParent = new Map();
  for (const h of holders) {
    const key = (h.parentName || '').replace(/\.exe$/i, '') || h.name || 'process';
    byParent.set(key, (byParent.get(key) || 0) + 1);
  }
  const parts = [...byParent.entries()].map(([parent, count]) => {
    const app = describeParent(parent);
    return `${count} ${app}${count === 1 ? '' : 's'}`;
  });
  const binary = holders[0]?.name ? holders[0].name.replace(/\.exe$/i, '') : provider;
  return `${provider} cannot be updated while its executable is in use: ${parts.join(', ')} still ${holders.length === 1 ? 'has' : 'have'} ${binary} open (PID${holders.length === 1 ? '' : 's'} ${holders.map((h) => h.pid).join(', ')}). Close ${parts.length === 1 && byParent.size === 1 ? 'them' : 'those'}, then click Update again. Nothing was changed.`;
}

function describeParent(parent) {
  const p = String(parent || '').toLowerCase();
  if (p === 'claude') return 'Claude Code session';
  if (p === 'code') return 'VS Code window';
  if (p === 'cursor') return 'Cursor window';
  if (p === 'codex') return 'Codex session';
  if (p === 'windowsterminal' || p === 'wt') return 'Windows Terminal tab';
  if (p === 'powershell' || p === 'pwsh' || p === 'cmd') return 'terminal';
  return `${parent} process`;
}

/**
 * Parse the JSON the Windows probe prints: an array (or single object) of
 * { ProcessId, Name, ExecutablePath, ParentProcessId, ParentName }.
 */
function parseProcessHolders(json) {
  let value;
  try { value = typeof json === 'string' ? JSON.parse(json || '[]') : json; } catch { return []; }
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((p) => ({
      pid: Number(p?.ProcessId ?? p?.pid) || 0,
      name: String(p?.Name ?? p?.name ?? ''),
      path: p?.ExecutablePath ?? p?.path ?? undefined,
      parentPid: Number(p?.ParentProcessId ?? p?.parentPid) || null,
      parentName: p?.ParentName ?? p?.parentName ?? null,
    }))
    .filter((p) => p.pid > 0);
}

/** PowerShell that lists processes whose executable lives under `dir` (with parent names). */
function windowsHolderProbeScript(dir) {
  const escaped = String(dir).replace(/'/g, "''");
  return [
    `$root = '${escaped}'`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, ParentProcessId",
    "$held = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) })",
    "$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p.Name }",
    "$out = @(); foreach ($h in $held) { $out += [pscustomobject]@{ ProcessId = $h.ProcessId; Name = $h.Name; ExecutablePath = $h.ExecutablePath; ParentProcessId = $h.ParentProcessId; ParentName = $byId[[int]$h.ParentProcessId] } }",
    "$out | ConvertTo-Json -Compress",
  ].join('\n');
}

module.exports = { decideCliUpdatePreflight, lockHolderMessage, parseProcessHolders, windowsHolderProbeScript };
