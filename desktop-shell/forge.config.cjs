'use strict';

const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { resolveSigningConfig } = require('./src/signing-config.cjs');

const runtimeRoot = resolve(__dirname, '.runtime', 'bridge');
const iconRoot = resolve(__dirname, '..', 'assets', 'icons');
const packageIcon = process.platform === 'win32'
  ? join(iconRoot, 'bridge.ico')
  : process.platform === 'darwin'
    ? join(iconRoot, 'bridge.icns')
    : join(iconRoot, 'bridge.png');
if (!existsSync(runtimeRoot)) {
  throw new Error(`Desktop runtime has not been staged at ${runtimeRoot}. Run npm run stage first.`);
}
const signing = resolveSigningConfig();

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.empir3.bridge',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'empir3-bridge',
    icon: packageIcon,
    extraResource: [
      runtimeRoot,
      resolve(__dirname, '..', 'build', 'payload-signing-pub.json'),
    ],
    osxUniversal: {
      // Each architecture build intentionally carries both node-pty prebuilds so
      // the final universal app can select the matching binary at runtime. The
      // files are therefore identical between the two app halves and must not
      // be merged with lipo a second time.
      x64ArchFiles: '**/node-pty/prebuilds/darwin-*/*',
    },
    ...signing.packagerConfig,
  },
  rebuildConfig: {},
  hooks: signing.hooks,
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'empir3_bridge',
        authors: 'Empir3',
        description: 'Connect local LLM providers and CLI subscriptions to Empir3.',
        noMsi: true,
        setupIcon: join(iconRoot, 'bridge.ico'),
        ...signing.squirrelConfig,
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'Empir3 Bridge',
        format: 'ULFO',
        icon: join(iconRoot, 'bridge.icns'),
      },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          maintainer: 'Empir3',
          homepage: 'https://app.empir3.com',
          bin: 'empir3-bridge',
          categories: ['Utility', 'Development'],
          icon: join(iconRoot, 'bridge.png'),
        },
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin', 'linux'],
      config: {},
    },
  ],
};
