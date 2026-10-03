'use strict';

const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Only used for the unpacked, disposable Linux update acceptance fixture.
function setRuntimeFixtureVersion(runtimeRoot, baseVersion, nextVersion) {
  const packagePath = join(runtimeRoot, 'package.json');
  const markerPath = join(runtimeRoot, '.payload-version');
  const runtimePackage = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(runtimePackage.version, baseVersion, 'Fixture runtime package must match its base desktop');
  assert.equal(readFileSync(markerPath, 'utf8').trim(), baseVersion, 'Fixture runtime marker must match its base desktop');
  runtimePackage.version = nextVersion;
  writeFileSync(packagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
  writeFileSync(markerPath, `${nextVersion}\n`);
}

module.exports = { setRuntimeFixtureVersion };
