'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

function configuredPattern() {
  // Evaluate the shipping configuration without staging a runtime or signing.
  const filename = path.join(__dirname, '..', 'forge.config.cjs');
  const context = {
    __dirname: path.dirname(filename), process: { platform: 'darwin' }, module: { exports: {} },
    require(name) {
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === './src/signing-config.cjs') return { resolveSigningConfig: () => ({ packagerConfig: {}, hooks: {}, squirrelConfig: {} }) };
      return require(name);
    },
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports.packagerConfig.osxUniversal.x64ArchFiles;
}

test('universal packaging preserves both known node-pty prebuild locations, including hidden runtime', async () => {
  const { matchGlob } = await import(pathToFileURL(path.join(path.dirname(require.resolve('@electron/universal')), 'file-utils.js')).href);
  const pattern = configuredPattern();
  for (const root of ['Contents/Resources/bridge', 'Contents/Resources/app.asar.unpacked/.runtime/bridge']) {
    for (const arch of ['arm64', 'x64']) {
      for (const name of ['pty.node', 'spawn-helper']) {
        const file = `${root}/node_modules/node-pty/prebuilds/darwin-${arch}/${name}`;
        assert.equal(matchGlob(file, pattern), true, file);
      }
    }
  }
  for (const file of [
    'Contents/MacOS/empir3-bridge',
    'Contents/Resources/bridge/node_modules/other/native.node',
    'Contents/Resources/bridge/node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'Contents/Resources/app.asar.unpacked/.other/bridge/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  ]) assert.equal(matchGlob(file, pattern), false, file);
});
