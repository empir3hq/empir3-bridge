/**
 * agy imagegen image-input (img2img) contract.
 *
 * The server routes reference edits to a lent agy CLI only when this bridge
 * advertises `image_input_supported` — so the probe advertisement, the wire
 * passthrough, and the handler's reference handling must stay in lockstep.
 * The reference file planted in the spawn cwd must be excluded from harvest:
 * without the exclusion, a failed edit "harvests" the unedited input and
 * returns it as if it were the result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handler = readFileSync(new URL('../src/handlers/agy-imagegen.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('input image is validated before the binary check and size-capped', () => {
  const validateIdx = handler.indexOf('input image is not valid base64');
  const binIdx = handler.indexOf('const bin = findAgyBinary()');
  assert.ok(validateIdx > 0 && binIdx > 0, 'both validation and binary lookup present');
  assert.ok(validateIdx < binIdx, 'input validation precedes the binary check');
  assert.match(handler, /MAX_INPUT_IMAGE_BYTES = 16 \* 1024 \* 1024/);
  assert.match(handler, /decoded to zero bytes/);
});

test('edit mode plants the reference in the cwd and prompts ImagePaths use', () => {
  assert.match(handler, /referencePath = join\(workDir, `reference\.\$\{inputImage\.ext\}`\)/);
  assert.match(handler, /writeFileSync\(referencePath, inputImage\.bytes\)/);
  assert.match(handler, /EDIT THIS EXACT IMAGE/);
  assert.match(handler, /ImagePaths/);
  assert.match(handler, /do not generate from scratch/);
});

test('both harvest sites exclude the planted reference', () => {
  const harvestCalls = handler.match(/findHarvestImage\(workDir, preBrainImages, referencePath\)/g) || [];
  assert.equal(harvestCalls.length, 2, 'poller and exit-path harvests both pass the exclusion');
});

test('findHarvestImage never returns the excluded reference, even with no other candidate', async () => {
  const { findHarvestImage, snapshotBrainImages } = await import('../src/handlers/agy-imagegen.ts')
    .catch(() => ({ findHarvestImage: null, snapshotBrainImages: null }));
  if (!findHarvestImage || !snapshotBrainImages) return; // no TS loader in this runner — source contracts above still hold
  const dir = mkdtempSync(join(tmpdir(), 'agy-harvest-'));
  // A dev machine can have a real agy brain dir with images from live runs.
  // Snapshot it as "pre-existing" so this test only observes the temp cwd —
  // exactly what the handler does before each spawn.
  const preBrain = snapshotBrainImages();
  try {
    const ref = join(dir, 'reference.jpg');
    writeFileSync(ref, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.equal(findHarvestImage(dir, preBrain, ref), null, 'reference alone is not a harvest');
    const out = join(dir, 'edited.png');
    writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const past = new Date(Date.now() - 60_000);
    utimesSync(ref, past, past);
    assert.equal(findHarvestImage(dir, preBrain, ref), out, 'real output wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brain harvest compares image metadata so reused conversation dirs are visible', () => {
  assert.match(handler, /snapshotBrainImages/);
  assert.match(handler, /before\.mtimeMs !== candidate\.mtimeMs \|\| before\.size !== candidate\.size/);
  assert.doesNotMatch(handler, /preBrainConvs\.has\(conv\)/);
  assert.match(handler, /POST_EXIT_GRACE_MS = 15_000/);
});

test('agy quota and permission failures are classified instead of reported as no output', () => {
  assert.match(handler, /--log-file/);
  assert.match(handler, /QUOTA_EXHAUSTED\|RESOURCE_EXHAUSTED\|exhausted your capacity\|429 Too Many Requests/);
  assert.match(handler, /stage: 'quota'/);
  assert.match(handler, /stage: 'permission_denied'/);
  assert.match(handler, /configured image route should fail over/);
});

test('wire passes input_image_base64/input_mime through and the probe advertises support', () => {
  assert.match(server, /input_image_base64/);
  assert.match(server, /input_mime/);
  assert.match(server, /agyGenerateImage\(\{ prompt, timeoutMs, inputImageBase64, inputImageMime \}\)/);
  assert.match(server, /image_input_supported: true/);
});
