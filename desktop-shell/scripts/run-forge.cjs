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

// Forge 8 uses the current Packager API. Keep packaging on the same maintained
// Node 24 runtime as our checks instead of downloading an old Node at build time.
if (nodeMajor !== 24) throw new Error('Desktop packaging requires Node 24 LTS.');

const result = spawnSync(executable, args, {
  cwd: shellRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
  shell: process.platform === 'win32' && executable.endsWith('.cmd'),
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
