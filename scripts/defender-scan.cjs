const { createHash, randomUUID } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function scanFiles(paths) {
  const files = new Map();
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Defender scan refuses a linked path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (stat.isFile()) {
      files.set(path, { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    } else throw new Error(`Unsupported scan target: ${path}`);
  }
  paths.forEach(visit);
  if (!files.size) throw new Error('No files to scan');
  return [...files.values()];
}

function assertCleanReceipt(receipt, expected) {
  if (receipt?.schemaVersion !== 1 || receipt.clean !== true || receipt.scanCompleted !== true
    || !Array.isArray(receipt.detections) || receipt.detections.length || receipt.error) {
    throw new Error(`Defender release scan failed: ${receipt?.error || 'missing clean scan evidence'}`);
  }
  const files = new Map((receipt.files || []).map(file => [file.path, file.sha256]));
  if (files.size !== expected.length || receipt.files.length !== expected.length
    || expected.some(file => files.get(file.path) !== file.sha256)) {
    throw new Error('Defender scan receipt does not cover unchanged candidate files');
  }
  return receipt;
}

function scanWithDefender({ paths, receiptPath }) {
  if (process.platform !== 'win32') throw new Error('Windows payload publishing requires the native Windows Defender gate');
  const scanPaths = [...new Set(paths.map(path => resolve(path)))];
  const plan = { scanPaths, files: scanFiles(scanPaths) };
  const stem = join(tmpdir(), `empir3-defender-${randomUUID()}`);
  const planPath = `${stem}.plan.json`, resultPath = `${stem}.result.json`;
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(__dirname, 'verify-defender.ps1'),
      '-PlanPath', planPath, '-ResultPath', resultPath], { windowsHide: true, encoding: 'utf8', timeout: 20 * 60_000,
      // A PowerShell 7 parent can supply an incompatible module search path to
      // Windows PowerShell 5.1. Let the native host initialize its own defaults.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')) });
    if (!existsSync(resultPath)) throw new Error(`Defender scan produced no receipt: ${result.error?.message || result.stderr || result.status}`);
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
    if (receiptPath) writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    if (result.error || result.status !== 0) throw new Error(`Defender release scan failed: ${receipt.error || result.error?.message || result.status}`);
    return assertCleanReceipt(receipt, plan.files);
  } finally {
    for (const file of [planPath, resultPath]) if (existsSync(file)) unlinkSync(file);
  }
}
module.exports = { scanFiles, assertCleanReceipt, scanWithDefender };
