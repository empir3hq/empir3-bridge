'use strict';
const { lstatSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');

// npm serves both Windows architectures from one archive. Never produce an
// installable-looking package that silently lacks its mandatory supervisor.
function checkCliJobPackage(root = resolve(__dirname, '..')) {
  for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64]]) {
    const file = join(root, 'native', 'cli-job', 'bin', `win32-${arch}`, 'empir3-cli-job.exe');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 256 || stat.size > 20 * 1024 * 1024) throw Error(`Invalid ${arch} CLI supervisor`);
    const data = readFileSync(file), offset = data.readUInt32LE(0x3c);
    if (data.toString('ascii', 0, 2) !== 'MZ' || offset > data.length - 6 || data.readUInt32LE(offset) !== 0x4550
      || data.readUInt16LE(offset + 4) !== machine) throw Error(`CLI supervisor architecture mismatch: ${arch}`);
  }
}
module.exports = { checkCliJobPackage };
if (require.main === module) checkCliJobPackage();
