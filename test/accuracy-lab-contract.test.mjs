import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const lab = readFileSync(new URL('../assets/accuracy-lab.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const mcpServer = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

test('Accuracy Lab exposes one immutable 103-target run registry', () => {
  const markup = lab.split('<script>')[0];
  const ids = [...markup.matchAll(/data-target-id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 103);
  assert.equal(new Set(ids).size, 103);
  assert.match(lab, /baselineTargets = targets\(\)/);
  assert.match(lab, /registeredTargets: freezeBaselineTargets\(\)\.length/);
  assert.doesNotMatch(lab, />offline</i);
});

test('Accuracy Lab pass requires trusted page input and Bridge-owned OS click receipts', () => {
  assert.match(lab, /if \(completionPublished \|\| stats\.remaining !== 0\) return/);
  assert.doesNotMatch(lab, /fetch\('\/api\/calibration\/lab-result'/);
  assert.match(lab, /Bridge is validating the trusted OS-click receipts/);
  assert.match(lab, /uniqueHits: hitIds\.size/);
  assert.match(lab, /event\.isTrusted !== true/);
  assert.match(lab, /trusted: event\.isTrusted === true/);
  assert.match(server, /accuracyLabStatsPass\(stats, trustedReceipts\)/);
  assert.match(server, /trustedReceipts = receipts\.filter/);
  assert.match(server, /Accuracy results are saved only by the Bridge trusted physical sweep/);
});

test('the trusted physical sweep is callable through MCP when the owner enables it', () => {
  assert.match(mcpServer, /'browser_accuracy_lab_sweep'/);
  assert.match(mcpServer, /bridgeCommand\(\{ type: 'accuracy_lab_sweep', reset \}\)/);
  assert.match(mcpServer, /fails honestly when physical input or calibration is unavailable/);
  assert.match(server, /case 'accuracy_lab_sweep':\s+return handleAgentBrowser\('accuracy_lab_sweep', cmd\)/);
});

test('physical page clicks raise the matched Chrome window before clicking', () => {
  assert.match(server, /topHandle=\$script:curTop\.ToInt64\(\)/);
  assert.match(server, /\[Empir3WindowCtl\]::SetForegroundWindow\(\$h\)/);
  assert.match(server, /\[Empir3WindowCtl\]::SetWindowPos\(\$h, \[IntPtr\]\(-1\)/);
  assert.match(server, /\[Empir3WindowCtl\]::SetWindowPos\(\$h, \[IntPtr\]\(-2\)/);
  assert.match(server, /focus\?\.focused !== true && focus\?\.raised !== true/);
  assert.match(server, /physical click was not attempted/);
  assert.match(server, /Number\(r\.topHandle\) === topHandle\s*&& Math\.abs/);
});

test('moving and scroll-revealed targets are re-read after an instant reveal', () => {
  assert.match(lab, /scroll-behavior: auto !important/);
  assert.match(lab, /scrollIntoView\(\{ behavior: 'auto'/);
  assert.match(lab, /requestAnimationFrame\(function \(\) \{\s*window\.requestAnimationFrame/);
  assert.match(lab, /resolve\(readTarget\(el\)\)/);
});

test('the calibration CTA is user-owned and opens only bundled local tests', () => {
  assert.match(server, /url\.pathname === '\/api\/calibration\/run'/);
  assert.match(server, /url\.pathname === '\/api\/browser\/open-local'/);
  assert.match(server, /\['\/accuracy-lab', '\/desktop-test'\]\.includes\(localPath\)/);
  assert.match(server, /postJson\('\/api\/calibration\/run', \{\}\)/);
  assert.match(server, /postJson\('\/api\/browser\/open-local', \{ path:'\/accuracy-lab' \}\)/);
  assert.match(server, /Every current monitor must pass calibration/);
  assert.doesNotMatch(
    server.match(/async function openAccuracyLab\(\) \{[\s\S]*?\n  \}/)?.[0] || '',
    /window\.open/,
  );
});

test('monitor bounds, DPI, calibration version, and workflow version invalidate stale passes', () => {
  assert.match(server, /dpiX: Number\(mon\.dpiX \|\| 0\)/);
  assert.match(server, /dpiY: Number\(mon\.dpiY \|\| 0\)/);
  assert.match(server, /Number\(saved\?\.dpiX \|\| 0\) === Number\(current\?\.dpiX \|\| 0\)/);
  assert.match(server, /calibration\?\.version === 2/);
  assert.match(server, /savedPass\?\.version === CALIBRATION_WORKFLOW_VERSION/);
});

test('SVG target centers map through the rendered transform onto exposed geometry', () => {
  assert.match(
    lab,
    /data-visual-center="626,213" data-target-id="canvas-shape-orbit-ring"/,
  );
  assert.match(lab, /svg\.getScreenCTM\(\)/);
  assert.match(lab, /point\.matrixTransform\(matrix\)/);
});

test('calibration status waits for monitor enumeration before committing HTTP 200', () => {
  const routeStart = server.indexOf("if (url.pathname === '/api/calibration/status'");
  const routeEnd = server.indexOf("if (url.pathname === '/api/calibration/run'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'calibration status route must exist');
  const route = server.slice(routeStart, routeEnd);
  const awaitIndex = route.indexOf('await desktopCalibrationWorkflowStatus()');
  const successHeaderIndex = route.indexOf('res.writeHead(200');
  assert.ok(awaitIndex >= 0, 'status route must await monitor enumeration');
  assert.ok(successHeaderIndex > awaitIndex, 'HTTP 200 must not be sent before enumeration succeeds');
});
