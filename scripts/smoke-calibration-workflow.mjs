#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = mkdtempSync(join(tmpdir(), 'empir3-calibration-smoke-'));
const port = Number(process.env.EMPIR3_CALIBRATION_SMOKE_PORT || 4306);
const bridgePort = Number(process.env.EMPIR3_CALIBRATION_SMOKE_BRIDGE_PORT || 10967);
const stdoutPath = join(testRoot, 'stdout.log');
const stderrPath = join(testRoot, 'stderr.log');
const child = spawn(process.execPath, [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'server.ts')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PW_PORT: String(port),
    EMPIR3_BRIDGE_PORT: String(bridgePort),
    APPDATA: testRoot,
    EMPIR3_BRIDGE_RUNTIME_DATA_DIR: join(testRoot, 'runtime'),
    EMPIR3_SERVER: 'http://127.0.0.1:65534',
    EMPIR3_BRIDGE_ACCURACY_LAB: join(repoRoot, 'assets', 'accuracy-lab.html'),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

async function waitForJson(pathname, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (response.ok) return response.json();
      lastError = new Error(`${pathname} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw lastError || new Error(`${pathname} did not become ready`);
}

try {
  const status = await waitForJson('/api/status');
  const calibration = await waitForJson('/api/calibration/status');
  const lab = await fetch(`http://127.0.0.1:${port}/accuracy-lab`);
  const labText = await lab.text();
  if (!lab.ok || !labText.includes('Accuracy Lab')) throw new Error('Accuracy Lab asset was not served');
  if (process.platform === 'win32') {
    if (!calibration.monitors?.count) throw new Error('Windows monitor inventory is empty');
    if (!calibration.monitors?.signature?.includes('dpiX')) throw new Error('Monitor signature does not include DPI');
  }
  console.log(JSON.stringify({
    ok: true,
    version: status.version,
    calibrationState: calibration.state,
    monitorCount: calibration.monitors?.count || 0,
    monitorIds: calibration.monitors?.ids || [],
    missing: calibration.monitors?.missing || [],
    labBytes: Buffer.byteLength(labText),
  }));
} catch (error) {
  console.error(stdout.join(''));
  console.error(stderr.join(''));
  throw error;
} finally {
  child.kill();
  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    child.once('exit', resolvePromise);
    setTimeout(resolvePromise, 3_000).unref();
  });
  rmSync(testRoot, { recursive: true, force: true });
}
