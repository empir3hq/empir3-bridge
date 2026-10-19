'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function stopInstalledProcesses(bridgeRoot, appRoot) {
  if (process.platform !== 'win32') return 0;
  const packed = path.join(__dirname, 'uninstall-processes.ps1');
  const script = fs.existsSync(packed) ? packed : path.join(__dirname, 'bootstrap-go', 'uninstall-processes.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fs.readFileSync(script, 'utf8')], {
    windowsHide: true, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, EMPIR3_UNINSTALL_BRIDGE_ROOT: bridgeRoot,
      EMPIR3_UNINSTALL_APP_ROOT: appRoot, EMPIR3_UNINSTALL_CALLER_PID: String(process.pid) },
  });
  if (result.error || result.status !== 0) throw new Error(`Cannot safely stop this installation: ${result.error?.message || result.stderr || result.status}`);
  const receipt = JSON.parse(result.stdout.trim());
  if (receipt.ok !== true || !Array.isArray(receipt.killed)) throw new Error('Missing installation process cleanup receipt');
  return receipt.killed.length;
}
module.exports = { stopInstalledProcesses };
