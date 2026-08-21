import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildDeterministicTarGz, extractTarGz } = require('../build/tar-util.js');
const { parseAndVerifyManifest } = require('../desktop-shell/src/updater.cjs');
const { createUpdateAcceptanceFixture } = require('../headless-package/scripts/create-update-acceptance-fixture.cjs');

test('ephemeral fixture produces signed update, rollback, and bad-health packages without a private key', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-update-fixture-test-'));
  try {
    const source = join(root, 'source');
    mkdirSync(join(source, 'runtime', 'src'), { recursive: true });
    mkdirSync(join(source, 'runtime', 'trust'), { recursive: true });
    writeFileSync(join(source, 'install.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(join(source, 'uninstall.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(join(source, 'package-metadata.json'), JSON.stringify({ version: '0.3.55', platform: 'linux', arch: 'x64' }));
    writeFileSync(join(source, 'runtime', '.payload-version'), '0.3.55\n');
    writeFileSync(join(source, 'runtime', 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '0.3.55' }));
    writeFileSync(join(source, 'runtime', 'src', 'headless-entry.js'), 'setInterval(() => {}, 1000);\n');
    writeFileSync(join(source, 'runtime', 'trust', 'update-public-key.json'), '{}\n');
    const baseArchive = join(root, 'base.tar.gz');
    writeFileSync(baseArchive, buildDeterministicTarGz(source));

    const output = join(root, 'fixture');
    const fixture = createUpdateAcceptanceFixture({ baseArchive, outputRoot: output });
    assert.equal(fixture.acceptanceOnly, true);
    assert.equal(fixture.packages.update.name, 'empir3-bridge-linux-headless-x64-0.3.56.tar.gz');
    assert.equal('privateKey' in fixture, false);
    for (const release of Object.values(fixture.releases)) {
      const manifest = parseAndVerifyManifest(
        readFileSync(join(output, release.manifestName)),
        fixture.publicKeyHex,
      );
      assert.equal(manifest.acceptanceOnly, 'true');
    }

    const updateRoot = join(root, 'update-extract');
    extractTarGz(join(output, fixture.packages.update.name), updateRoot);
    assert.equal(readFileSync(join(updateRoot, 'runtime', '.payload-version'), 'utf8').trim(), '0.3.56');
    assert.equal(JSON.parse(readFileSync(join(updateRoot, 'runtime', 'package.json'), 'utf8')).version, '0.3.56');
    const badRoot = join(root, 'bad-extract');
    extractTarGz(join(output, fixture.packages.bad.name), badRoot);
    assert.match(readFileSync(join(badRoot, 'runtime', 'src', 'headless-entry.js'), 'utf8'), /intentional update-acceptance health failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
