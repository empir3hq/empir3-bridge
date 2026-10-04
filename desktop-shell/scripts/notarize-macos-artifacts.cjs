'use strict';

const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
}

async function signAndNotarizeMacDisks(makeResults, { identity, notarize: notarizeOptions }) {
  if (process.platform !== 'darwin') throw new Error('DMG signing and notarization require macOS');
  const dmgs = makeResults.flatMap((result) => result.artifacts || [])
    .filter((artifact) => artifact.toLowerCase().endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error(`Expected exactly one macOS DMG, found ${dmgs.length}`);
  const { notarize } = require('@electron/notarize');
  for (const dmg of dmgs) {
    if (!existsSync(dmg)) throw new Error(`DMG does not exist: ${dmg}`);
    run('codesign', ['--force', '--timestamp', '--sign', identity, dmg]);
    run('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
    await notarize({ appPath: dmg, ...notarizeOptions });
    run('xcrun', ['stapler', 'validate', '-v', dmg]);
  }
}

module.exports = { signAndNotarizeMacDisks };
