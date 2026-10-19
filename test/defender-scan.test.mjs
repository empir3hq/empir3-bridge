import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { scanFiles, assertCleanReceipt } = require('../scripts/defender-scan.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = [{ path: 'C:\\candidate\\tray.exe', sha256: 'a'.repeat(64) }];
const good = () => ({ schemaVersion: 1, clean: true, scanCompleted: true, detections: [], files: expected, error: null });

test('Defender receipts require clean completion and exact unchanged file coverage', () => {
  assert.equal(assertCleanReceipt(good(), expected).clean, true);
  for (const bad of [null, { ...good(), clean: false }, { ...good(), scanCompleted: false },
    { ...good(), detections: [{}] }, { ...good(), files: [] },
    { ...good(), files: [expected[0], expected[0]] },
    { ...good(), files: [{ ...expected[0], sha256: 'b'.repeat(64) }] }]) {
    assert.throws(() => assertCleanReceipt(bad, expected));
  }
});

test('native Defender gate rejects remediated detections, quarantine and changed files despite successful scan command', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'empir3-defender-test-'));
  t.after(() => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  const candidate = join(dir, 'candidate.txt'), planPath = join(dir, 'plan.json'), resultPath = join(dir, 'result.json');
  const driver = join(dir, 'driver.ps1');
  writeFileSync(driver, `param($Scanner,$Plan,$Result,$Case)
$ErrorActionPreference='Stop'
$global:scanFixturePlan=Get-Content -LiteralPath $Plan -Raw|ConvertFrom-Json
function Get-MpComputerStatus { [pscustomobject]@{AMServiceEnabled=$true;AntivirusEnabled=$true;RealTimeProtectionEnabled=($Case -ne 'disabled');AntivirusSignatureVersion='test';AMEngineVersion='test'} }
function Start-MpScan {
 param($ScanType,$ScanPath)
 if($Case -eq 'missing'){Remove-Item -LiteralPath $global:scanFixturePlan.files[0].path}
 if($Case -eq 'changed'){Set-Content -LiteralPath $global:scanFixturePlan.files[0].path -Value 'changed'}
 if($Case -eq 'scan-error'){throw 'Scanner unavailable'}
}
function Get-MpThreatDetection {
 if($Case -eq 'history-error'){throw 'Cannot read threat history'}
 if($Case -in @('detected','unrelated','old')){
  $target=if($Case -eq 'unrelated'){$global:scanFixturePlan.scanPaths[0]+'-other'}else{$global:scanFixturePlan.files[0].path}
  $when=if($Case -eq 'old'){(Get-Date).AddDays(-2)}else{Get-Date}
  [pscustomobject]@{ThreatID=123;ActionSuccess=$true;InitialDetectionTime=$when;LastThreatStatusChangeTime=$when;Resources=@('file:_'+$target)}
 }
}
& $Scanner -PlanPath $Plan -ResultPath $Result
exit $LASTEXITCODE
`);
  for (const scenario of ['clean', 'detected', 'missing', 'changed', 'disabled', 'scan-error', 'history-error', 'unrelated', 'old']) {
    writeFileSync(candidate, 'Harmless scan fixture.');
    const plan = { files: scanFiles([candidate]), scanPaths: [candidate] };
    writeFileSync(planPath, JSON.stringify(plan));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', driver,
      '-Scanner', join(root, 'scripts/verify-defender.ps1'), '-Plan', planPath, '-Result', resultPath, '-Case', scenario], { encoding: 'utf8', windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')) });
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
    const passes = ['clean', 'unrelated', 'old'].includes(scenario);
    assert.equal(receipt.clean, passes, `${scenario}: ${receipt.error || result.stderr}`);
    assert.equal(result.status, passes ? 0 : 1, `${scenario}: ${result.stderr}`);
    if (scenario === 'detected') {
      assert.equal(receipt.scanCompleted, true);
      assert.equal(receipt.detections.length, 1);
      assert.match(receipt.error, /remediation is not a clean release result/);
    }
    if (passes) assertCleanReceipt(receipt, plan.files);
    else assert.throws(() => assertCleanReceipt(receipt, plan.files));
  }
});
