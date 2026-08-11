'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { staleVersionArtifacts } = require('../src/artifact-receipt.cjs');

test('artifact receipts reject stale versioned distributables while allowing fixed names', () => {
  const files = [
    'out/make/Empir3 Bridge.dmg',
    'out/make/RELEASES',
    'out/make/Empir3 Bridge-0.3.56 Setup.exe',
    'out/make/empir3_bridge-0.3.56-full.nupkg',
    'out/make/Empir3 Bridge-win32-x64-0.3.56.zip',
    'out/make/Empir3 Bridge-win32-x64-0.3.55.zip',
  ];

  assert.deepEqual(staleVersionArtifacts(files, '0.3.56'), [files.at(-1)]);
});

test('artifact receipt version validation requires an explicit release version', () => {
  assert.throws(() => staleVersionArtifacts([], ''), /release version is required/);
});
