'use strict';

const { createRequire } = require('node:module');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');

const bridgeRoot = resolve(__dirname, '..');

function stageBridgeRuntime({
  runtimeRoot,
  platform = process.platform,
  hostArch = process.arch,
  packageArch = hostArch,
  target = 'node22',
} = {}) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  const output = resolve(runtimeRoot);
  const allowedParents = [
    resolve(bridgeRoot, 'desktop-shell', '.runtime'),
    resolve(bridgeRoot, 'headless-package', 'out'),
  ];
  const isAllowed = allowedParents.some((parent) => {
    const rel = relative(parent, output);
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  if (!isAllowed || output === bridgeRoot || dirname(output) === output) {
    throw new Error(`Refusing unsafe runtime staging path: ${output}`);
  }
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`Unsupported Bridge runtime platform: ${platform}`);
  }
  if (!['x64', 'arm64', 'universal'].includes(packageArch)) {
    throw new Error(`Unsupported Bridge runtime architecture: ${packageArch}`);
  }
  if (packageArch === 'universal' && platform !== 'darwin') {
    throw new Error('Only macOS may use a universal Bridge runtime');
  }
  if (platform !== process.platform) {
    throw new Error(`Native runtime must be staged on ${platform}, not ${process.platform}`);
  }
  if (packageArch !== 'universal' && packageArch !== hostArch) {
    throw new Error(`Native runtime ${platform}/${packageArch} must be staged on matching ${hostArch} hardware`);
  }

  const bridgePackage = JSON.parse(readFileSync(join(bridgeRoot, 'package.json'), 'utf8'));
  const fromBridge = createRequire(join(bridgeRoot, 'package.json'));
  const { buildSync } = fromBridge('esbuild');

  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'src'), { recursive: true });
  mkdirSync(join(output, 'dist'), { recursive: true });

  for (const [input, bundle] of [
    ['src/bridge.ts', 'dist/bundle-bridge.js'],
    ['src/server.ts', 'dist/bundle-server.js'],
    ['src/mcp-server.ts', 'dist/bundle-mcp-server.js'],
    // Same bundle name the Windows payload ships (build/build.js), so the
    // install-link `--pair <code>` flow exists on every host type.
    ['src/pair-claim.ts', 'dist/bundle-pair-claim.js'],
  ]) {
    buildSync({
      entryPoints: [join(bridgeRoot, input)],
      outfile: join(output, bundle),
      bundle: true,
      platform: 'node',
      target,
      format: 'cjs',
      external: ['node-pty'],
      logLevel: 'info',
    });
  }

  for (const file of ['headless-entry.js', 'proc-util.js', 'platform-profile.js', 'account-profile.js']) {
    cpSync(join(bridgeRoot, 'src', file), join(output, 'src', file));
  }
  const accuracyLab = join(bridgeRoot, 'assets', 'accuracy-lab.html');
  if (existsSync(accuracyLab)) cpSync(accuracyLab, join(output, 'dist', 'accuracy-lab.html'));
  const iconSource = join(bridgeRoot, 'assets', 'icons');
  if (!existsSync(join(iconSource, 'bridge-tray-connected.png'))) {
    throw new Error(`Generated Bridge icons are missing at ${iconSource}; run npm --prefix desktop-shell run icons`);
  }
  mkdirSync(join(output, 'assets'), { recursive: true });
  cpSync(iconSource, join(output, 'assets', 'icons'), { recursive: true });

  const nodePtySource = join(bridgeRoot, 'node_modules', 'node-pty');
  if (!existsSync(nodePtySource)) {
    throw new Error('node-pty is not installed in the Bridge root; run npm install first');
  }
  const nodePtyTarget = join(output, 'node_modules', 'node-pty');
  mkdirSync(nodePtyTarget, { recursive: true });
  for (const name of ['package.json', 'LICENSE', 'lib']) {
    const source = join(nodePtySource, name);
    if (existsSync(source)) cpSync(source, join(nodePtyTarget, name), { recursive: true });
  }

  const prebuildNames = platform === 'darwin' && packageArch === 'universal'
    ? ['darwin-arm64', 'darwin-x64']
    : [`${platform}-${packageArch}`];
  const copiedPrebuilds = [];
  for (const prebuildName of prebuildNames) {
    const source = join(nodePtySource, 'prebuilds', prebuildName);
    if (!existsSync(source)) continue;
    cpSync(source, join(nodePtyTarget, 'prebuilds', prebuildName), {
      recursive: true,
      filter: (path) => !path.toLowerCase().endsWith('.pdb'),
    });
    copiedPrebuilds.push(prebuildName);
  }
  const releaseSource = join(nodePtySource, 'build', 'Release');
  const copiedReleaseFallback = existsSync(releaseSource);
  if (copiedReleaseFallback) {
    cpSync(releaseSource, join(nodePtyTarget, 'build', 'Release'), {
      recursive: true,
      filter: (path) => !path.toLowerCase().endsWith('.pdb'),
    });
  }
  if (copiedPrebuilds.length !== prebuildNames.length && !copiedReleaseFallback) {
    throw new Error(`node-pty native runtime missing for ${prebuildNames.join(', ')}`);
  }
  if (packageArch === 'universal' && copiedPrebuilds.length !== prebuildNames.length) {
    throw new Error('Universal macOS runtime requires both node-pty prebuild architectures');
  }

  writeFileSync(join(output, 'package.json'), JSON.stringify({
    name: '@empir3/bridge-runtime',
    version: bridgePackage.version,
    private: true,
    engines: { node: '>=22' },
  }, null, 2));
  writeFileSync(join(output, '.payload-version'), `${bridgePackage.version}\n`);

  return {
    ok: true,
    version: bridgePackage.version,
    platform,
    hostArch,
    packageArch,
    runtimeRoot: output,
    copiedPrebuilds,
    copiedReleaseFallback,
  };
}

module.exports = { bridgeRoot, stageBridgeRuntime };
