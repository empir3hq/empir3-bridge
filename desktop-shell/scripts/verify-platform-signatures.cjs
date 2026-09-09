'use strict';

const { existsSync, mkdtempSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, extname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const shellRoot = resolve(__dirname, '..');

function walk(root, files = []) {
  if (!existsSync(root)) return files;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function verifyWindows() {
  const packageRoots = readdirSync(join(shellRoot, 'out'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-win32-x64$/i.test(entry.name))
    .map((entry) => join(shellRoot, 'out', entry.name));
  if (packageRoots.length !== 1) throw new Error(`Expected one packaged Windows app, found ${packageRoots.length}`);
  const toolsRoot = resolve(shellRoot, '..', 'build', 'signing', 'tools');
  const signTool = walk(toolsRoot).filter((file) => basename(file).toLowerCase() === 'signtool.exe')
    .filter((file) => file.toLowerCase().includes(`${join('x64', 'signtool.exe')}`.toLowerCase()))
    .sort().at(-1);
  if (!signTool) throw new Error('signtool.exe is missing; run build/signing/setup-tools.ps1');

  const signable = [
    ...walk(packageRoots[0]).filter((file) => ['.exe', '.dll', '.node'].includes(extname(file).toLowerCase())),
    ...walk(join(shellRoot, 'out', 'make')).filter((file) => extname(file).toLowerCase() === '.exe'),
  ];
  if (signable.length === 0) throw new Error('No Windows binaries were found for signature verification');
  const nupkgs = walk(join(shellRoot, 'out', 'make')).filter((file) => file.toLowerCase().endsWith('.nupkg'));
  if (nupkgs.length !== 1) throw new Error(`Expected one Squirrel update package, found ${nupkgs.length}`);
  const scratch = mkdtempSync(join(tmpdir(), 'empir3-signed-nupkg-'));
  try {
    run('tar.exe', ['-xf', nupkgs[0], '-C', scratch]);
    signable.push(...walk(scratch).filter((file) => ['.exe', '.dll', '.node'].includes(extname(file).toLowerCase())));
    for (const file of [...new Set(signable)].sort()) run(signTool, ['verify', '/pa', '/all', file]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    signed: true,
    signingScheme: 'authenticode-azure-trusted-signing',
    verifiedFiles: new Set(signable).size,
  };
}

function verifyMacos() {
  const appRoots = readdirSync(join(shellRoot, 'out'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /-darwin-universal$/i.test(entry.name))
    .map((entry) => join(shellRoot, 'out', entry.name))
    .flatMap((root) => readdirSync(root).filter((name) => name.endsWith('.app')).map((name) => join(root, name)));
  if (appRoots.length !== 1) throw new Error(`Expected one packaged universal macOS app, found ${appRoots.length}`);
  const dmgs = walk(join(shellRoot, 'out', 'make')).filter((file) => file.toLowerCase().endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error(`Expected one notarized macOS DMG, found ${dmgs.length}`);

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appRoots[0]]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appRoots[0]]);
  run('xcrun', ['stapler', 'validate', '-v', appRoots[0]]);
  run('codesign', ['--verify', '--strict', '--verbose=2', dmgs[0]]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgs[0]]);
  run('xcrun', ['stapler', 'validate', '-v', dmgs[0]]);
  return {
    signed: true,
    signingScheme: 'apple-developer-id-notarized-stapled',
    verifiedFiles: 2,
  };
}

function verifyPlatformSignatures(platform = process.platform) {
  if (platform === 'win32') return verifyWindows();
  if (platform === 'darwin') return verifyMacos();
  throw new Error('Linux packages are authenticated by the signed release manifest, not an OS-native desktop signature');
}

if (require.main === module) {
  console.log(JSON.stringify({ ok: true, platform: process.platform, ...verifyPlatformSignatures() }));
}

module.exports = { verifyPlatformSignatures };
