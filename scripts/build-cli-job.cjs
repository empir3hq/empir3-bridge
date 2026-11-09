'use strict';
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');

function buildCliJob({ arch = process.arch } = {}) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw Error('CLI job helper requires a Windows x64/arm64 build');
  const source = resolve(__dirname, '..', 'native', 'cli-job');
  const output = join(source, 'bin', `win32-${arch}`);
  mkdirSync(output, { recursive: true });
  const binary = join(output, 'empir3-cli-job.exe');
  execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', binary, '.'], {
    cwd: source, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, GOOS: 'windows', GOARCH: arch === 'x64' ? 'amd64' : 'arm64', CGO_ENABLED: '0' },
  });
  return binary;
}
module.exports = { buildCliJob };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--arch')) throw Error('Usage: build-cli-job.cjs [--arch x64|arm64]');
  console.log(buildCliJob({ arch: args[1] || process.arch }));
}
