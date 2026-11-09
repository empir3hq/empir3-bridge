'use strict';

const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function applyPackagingPatches(root = resolve(__dirname, '..'), platform = process.platform) {
  // appdmg is an optional macOS-only dependency. Its callback API needs a
  // narrow adapter to the patched image-size parser; never skip it on a Mac.
  if (platform !== 'darwin') return;
  if (!existsSync(join(root, 'node_modules/appdmg/package.json'))) {
    throw new Error('macOS packaging requires appdmg and its security compatibility patch. Reinstall desktop dependencies with optional packages.');
  }
  const result = spawnSync(process.execPath, [join(root, 'node_modules/patch-package/index.js'), '--error-on-fail'], {
    cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Packaging dependency patch failed; refusing to build.');
}

module.exports = { applyPackagingPatches };
if (require.main === module) applyPackagingPatches();
