'use strict';
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { setRuntimeFixtureVersion } = require('../scripts/update-fixture-version.cjs');

test('Linux update fixture advances both runtime identities and rejects a mismatched base before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-fixture-version-'));
  try {
    const packagePath = join(root, 'package.json');
    const markerPath = join(root, '.payload-version');
    writeFileSync(packagePath, JSON.stringify({ name: 'runtime-fixture', version: '0.3.123' }));
    writeFileSync(markerPath, '0.3.122\n');
    assert.throws(() => setRuntimeFixtureVersion(root, '0.3.123', '0.3.124'), /marker must match/);
    assert.equal(JSON.parse(readFileSync(packagePath)).version, '0.3.123');
    assert.equal(readFileSync(markerPath, 'utf8'), '0.3.122\n');
    writeFileSync(markerPath, '0.3.123\n');
    setRuntimeFixtureVersion(root, '0.3.123', '0.3.124');
    assert.deepEqual(JSON.parse(readFileSync(packagePath)), { name: 'runtime-fixture', version: '0.3.124' });
    assert.equal(readFileSync(markerPath, 'utf8'), '0.3.124\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
