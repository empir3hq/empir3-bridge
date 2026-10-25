'use strict';

const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const command = process.argv[2];
if (!['package', 'make'].includes(command)) {
  throw new Error('Usage: node scripts/run-forge.cjs <package|make>');
}

const shellRoot = resolve(__dirname, '..');
const forgeCli = join(shellRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const forgeArgs = [command];
if (process.env.EMPIR3_DESKTOP_ARCH) {
  forgeArgs.push('--arch', process.env.EMPIR3_DESKTOP_ARCH);
}
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
let executable = process.execPath;
let args = [forgeCli, ...forgeArgs];

// Forge 7.11 currently uses Electron Packager 18, whose extraction process can
// exit early under Node 24. Release CI is pinned to Node 22.17; this fallback
// keeps local Node 24 workstations deterministic until stable Forge adopts the
// Node-24-compatible Packager API.
if (nodeMajor >= 24 || nodeMajor < 22) {
  executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  args = ['--yes', '--package', 'node@22.17.0', 'node', forgeCli, ...forgeArgs];
  console.log(`[desktop-package] Node ${process.versions.node} host; using pinned Node 22.17.0 for Forge`);
}

const result = spawnSync(executable, args, {
  cwd: shellRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
  shell: process.platform === 'win32' && executable.endsWith('.cmd'),
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
