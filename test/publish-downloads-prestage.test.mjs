import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  buildCandidate,
  buildPrestageReceipt,
  finalizeReceipt,
  validatePrestageReceipt,
} = require('../scripts/publish-receipt.cjs');

function candidate(overrides = {}) {
  return buildCandidate({
    releaseKind: 'live',
    version: '0.3.105',
    target: {
      server: 'publisher@example',
      remoteDir: '/srv/downloads',
      jumpHost: '',
      publicBase: 'https://example.test/downloads',
    },
    immutableFiles: [{ name: 'bridge-v0.3.105.zip', sha256: 'a'.repeat(64), bytes: 123 }],
    fixedFiles: [
      { name: 'bridge-version.json', sha256: 'b'.repeat(64), bytes: 456 },
      { name: 'Empir3Setup.exe', sha256: 'c'.repeat(64), bytes: 789 },
    ],
    ...overrides,
  });
}

test('pre-stage receipt accepts only the exact unused candidate and target', () => {
  const expected = candidate();
  const receipt = buildPrestageReceipt(expected, '2026-09-03T00:00:00.000Z');
  assert.equal(validatePrestageReceipt(receipt, expected), receipt);

  const wrongTarget = candidate({
    target: { ...expected.target, remoteDir: '/srv/wrong' },
  });
  assert.throws(() => validatePrestageReceipt(receipt, wrongTarget), /exact local candidate and publish target/);

  const driftedArtifact = candidate({
    immutableFiles: [{ ...expected.immutableFiles[0], sha256: 'd'.repeat(64) }],
  });
  assert.throws(() => validatePrestageReceipt(receipt, driftedArtifact), /exact local candidate and publish target/);

  const driftedFixedFile = candidate({
    fixedFiles: [{ ...expected.fixedFiles[0], bytes: 457 }, expected.fixedFiles[1]],
  });
  assert.throws(() => validatePrestageReceipt(receipt, driftedFixedFile), /exact local candidate and publish target/);

  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.candidate.immutableFiles = [];
  assert.throws(() => validatePrestageReceipt(tamperedReceipt, expected), /exact local candidate and publish target/);
});

test('a finalized pre-stage receipt cannot be reused', () => {
  const expected = candidate();
  const receipt = finalizeReceipt(
    buildPrestageReceipt(expected, '2026-09-03T00:00:00.000Z'),
    '2026-09-03T00:01:00.000Z',
  );
  assert.throws(() => validatePrestageReceipt(receipt, expected), /unused schema 1 receipt/);
});

test('pre-stage exits before either fixed manifest or stable installer upload', () => {
  const source = readFileSync(new URL('../scripts/publish-downloads.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(prestage && finalize\) fail\('--prestage and --finalize are mutually exclusive'\)/);
  assert.match(source, /desktopReleaseMetadataFiles = desktopFiles\.filter\(\(file\) => basename\(file\.path\) === 'RELEASES'\)/);
  assert.match(source, /desktopImmutableFiles = desktopFiles\.filter\(\(file\) => basename\(file\.path\) !== 'RELEASES'\)/);
  assert.match(source, /if \(prestage\) \{[\s\S]*?writePrestageReceipt\(receiptPath, candidate\);[\s\S]*?process\.exit\(0\);[\s\S]*?uploadAndVerify\('Stage 2: signed desktop rollout manifest'/);
  assert.match(source, /if \(prestage\) \{[\s\S]*?writePrestageReceipt\(receiptPath, candidate\);[\s\S]*?process\.exit\(0\);[\s\S]*?uploadAndVerify\('Stage 2: signed desktop manifest, then legacy manifest'/);
  assert.match(source, /uploadAndVerify\('Stage 3: Empir3Setup\.exe'/);
});
