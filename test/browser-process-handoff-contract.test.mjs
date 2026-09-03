import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

test('tracked Chrome launcher exit is confirmed against CDP before close latches', () => {
  const exitHandler = bridge.match(/launchedProcess\.on\('exit',[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(exitHandler, /confirmChromeProcessExit\(launchGeneration\)/);
  assert.doesNotMatch(exitHandler, /markChromeClosedByUser\('process exit'\)/);

  const confirmation = bridge.match(/async function confirmChromeProcessExit[\s\S]*?\n\}/)?.[0] || '';
  assert.match(confirmation, /chromeLaunchInFlightGeneration === launchGeneration/);
  assert.match(confirmation, /await hasReachablePageTarget\(\)/);
  assert.match(confirmation, /Chrome launcher handed off; browser remains reachable/);
  assert.match(confirmation, /markChromeClosedByUser\('browser process exit confirmed'\)/);
});

test('clean launcher hand-off keeps the CDP launch gate alive', () => {
  const wait = bridge.match(/async function waitForChromeCDP[\s\S]*?\n\}/)?.[0] || '';
  assert.match(wait, /chromeExitCode !== 0 \|\| chromeExitSignal/);
  assert.match(bridge, /chromeLaunchInFlightGeneration = launchGeneration/);
});

test('reachable CDP page clears stale close latch before ordinary tools refuse', () => {
  const ready = bridge.match(/async function ensureChromeReady[\s\S]*?\n\}/)?.[0] || '';
  const proof = ready.indexOf('await hasReachablePageTarget()');
  const refusal = ready.indexOf('chromeClosedByUser && !allowRelaunch');
  assert.ok(proof >= 0 && refusal > proof, 'CDP proof must precede the close-latch refusal');
  assert.match(ready, /chromeClosedByUser = false/);
});

test('target polling can detect a real close after a launcher hand-off', () => {
  const confirm = bridge.match(/async function markClosedIfNoPageTargets[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(confirm, /!chromeProcess/);
  assert.match(confirm, /markChromeClosedByUser\(reason\)/);
});

test('user-requested navigate reopens a zero-page Chrome process before spawning', () => {
  const reopen = bridge.match(/async function reopenTargetOnReachableChrome[\s\S]*?\n\}/)?.[0] || '';
  assert.match(reopen, /\/json\/version/);
  assert.match(reopen, /\/json\/new\?about:blank/);
  assert.match(reopen, /chromeClosedByUser = false/);
  const ready = bridge.match(/async function ensureChromeReady[\s\S]*?\n\}/)?.[0] || '';
  assert.match(ready, /chromeClosedByUser && allowRelaunch && await reopenTargetOnReachableChrome\(\)/);
  const launch = bridge.match(/async function launchChrome[\s\S]*?const chromePath/)?.[0] || '';
  assert.match(launch, /if \(await reopenTargetOnReachableChrome\(\)\) return/);
});

test('status separates daemon availability from verified browser liveness', () => {
  const health = bridge.match(/if \(path === '\/health'\)[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(health, /const browserRunning = await hasReachablePageTarget\(1000\)/);
  assert.match(health, /browserRunning,/);
  assert.match(health, /trackedLauncher,/);
  assert.match(server, /running: cdpConnected,\s+browserRunning: cdpConnected,\s+engine: 'empir3-bridge'/);
  assert.match(mcp, /browserRunning: status\?\.browserRunning \?\? status\?\.running/);
});

test('navigate requires active-page URL verification instead of metadata fallback', () => {
  const navigate = bridge.match(/if \(path === '\/navigate'\)[\s\S]*?sendJSON\(res, \{ title, url: currentUrl, verified: true \}\);/)?.[0] || '';
  assert.match(navigate, /currentUrl = await cdpEvaluate\('location\.href', 2500\)/);
  assert.doesNotMatch(navigate, /try \{ currentUrl = await cdpEvaluate/);
  assert.doesNotMatch(navigate, /currentUrl = currentUrl \|\| String\(target\.url/);
});
