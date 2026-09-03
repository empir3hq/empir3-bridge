import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const tray = readFileSync(new URL('../tray/tray.py', import.meta.url), 'utf8');

test('CLI lifecycle endpoints accept provider ids but never request-supplied commands', () => {
  assert.match(server, /url\.pathname === '\/api\/cli\/check-updates'/);
  assert.match(server, /url\.pathname === '\/api\/cli\/update'/);
  assert.match(server, /url\.pathname === '\/api\/cli\/deauthorize'/);
  assert.match(server, /url\.pathname === '\/api\/cli\/verify-auth'/);
  assert.match(server, /cliLifecycleAction\(provider, 'update'\)/);
  assert.match(server, /cliLifecycleAction\(provider, 'deauthorize'\)/);
  assert.doesNotMatch(server, /launchProvider(?:Update|Deauthorize)\([^)]*body\?\.(?:command|args)/);
});

test('Grok live auth verification is explicit and never runs during settings polling', () => {
  assert.match(server, /async function verifyGrokAuthLive/);
  assert.match(server, /data-cli-verify-auth="grok"/);
  assert.match(server, /postJson\('\/api\/cli\/verify-auth', \{ provider: id \}\)/);
  assert.match(server, /CREDENTIALS FOUND · VERIFY/);
});

test('Windows auth and lifecycle actions use a persistent visible terminal', () => {
  assert.match(server, /async function launchVisibleWindowsCommand/);
  assert.match(server, /Start-Process -FilePath 'powershell\.exe'/);
  assert.match(server, /-WindowStyle Normal -PassThru/);
  assert.match(server, /Press Enter to close this window/);
  assert.match(server, /Tee-Object -FilePath/);
  assert.match(server, /launchProviderAuth[\s\S]*launchProviderAction/);
  assert.match(server, /launchProviderInstall[\s\S]*launchVisibleWindowsCommand/);
  assert.match(server, /const tokens = run\.line\.trim\(\)\.split/);
  assert.doesNotMatch(server, /const executable = run\.shell === 'pwsh' \? 'powershell\.exe' : 'cmd\.exe'/);
});

test('visible CLI actions report their real terminal exit outcome', () => {
  assert.match(server, /createCliActionReceipt\(launcherDir, label\)/);
  assert.match(server, /ConvertTo-Json -Compress/);
  assert.match(server, /empir3_cli_exit=\$\{PIPESTATUS\[0\]\}/);
  assert.match(server, /actionId: receipt\.id/);
  assert.match(server, /url\.pathname === '\/api\/cli\/action-status'/);
  assert.match(server, /watchCliAction\(j\.actionId, id, 'update'\)/);
  assert.match(server, /failed with exit code/);
});

test('payload updates relaunch the visible Bridge console', () => {
  assert.match(tray, /EMPIR3_REOPEN_WELCOME_AFTER_UPDATE/);
  assert.match(tray, /def _record_tray_version_and_detect_transition/);
  assert.match(tray, /recorded_transition = _record_tray_version_and_detect_transition\(self\._tray_version\)/);
  assert.match(tray, /reopen_after_update = explicit_reopen or recorded_transition/);
  assert.doesNotMatch(tray, /explicit_reopen or _record_tray_version_and_detect_transition/);
  assert.match(tray, /tray version transition detected/);
  assert.match(tray, /def _restore_welcome_after_update/);
  assert.match(tray, /update-relaunch: restored visible bridge console/);
  assert.match(tray, /_restart_tray\(self\._icon, reopen_welcome=True\)/);
});

test('Windows lifecycle actions can use the OS-owned winget execution alias', () => {
  assert.match(server, /requestedBin\.toLowerCase\(\) === 'winget'/);
  assert.match(server, /bin = 'winget\.exe'/);
});

test('latest checks are explicit, cached, and source-labelled', () => {
  assert.match(server, /CLI_LATEST_TTL_MS = 30 \* 60 \* 1000/);
  assert.match(server, /registry\.npmjs\.org/);
  assert.match(server, /api\.github\.com\/repos/);
  assert.match(server, /\['update', '--check', '--json'\]/);
  assert.match(server, /source: string/);
});

test('CLI lifecycle pane uses the available desktop width without narrow action stacks', () => {
  assert.match(server, /\.pane\[data-pane="clis"\] \{ width:100%; max-width:none; \}/);
  assert.match(server, /\.cli-table \{ min-width:980px; table-layout:fixed; \}/);
  assert.match(server, /<col style="width:26%;">[\s\S]*<th>Actions<\/th>/);
  assert.match(server, /var actionCell = '<div class="cli-actions">'/);
  assert.match(server, /'Update now' : 'Update'/);
  assert.match(server, />Sign out<\/button>/);
  assert.match(server, /\.cli-actions \.btn \{ white-space:nowrap; \}/);
});
