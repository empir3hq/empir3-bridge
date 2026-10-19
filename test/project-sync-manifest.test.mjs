import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildProjectManifest, localFileSignature } = require('../src/project-sync-manifest.js');

test('local change signatures use the same size and mtime shape after scan and hydration', () => {
  assert.equal(localFileSignature({ size: 42, mtimeMs: 1234.6, hash: '' }), '42:1235');
  assert.equal(localFileSignature({ size: 42, mtimeMs: 1234.6, hash: 'server-sha256' }), '42:1235');
});

test('project manifest scan yields to account and heartbeat work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-sync-manifest-'));
  try {
    const projectDir = join(root, 'Big Project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.empir3-project.json'), JSON.stringify({
      projectId: 'project-1',
      projectName: 'Big Project',
    }));
    for (let index = 0; index < 500; index += 1) {
      writeFileSync(join(projectDir, `file-${index}.txt`), `value-${index}`);
    }

    let heartbeatRan = false;
    const manifestPromise = buildProjectManifest({
      root,
      metaFileName: '.empir3-project.json',
      shouldIgnorePath: (path) => path === '.empir3-project.json',
      maxFileBytes: 1024,
    });
    await new Promise((resolve) => setTimeout(() => {
      heartbeatRan = true;
      resolve();
    }, 0));
    assert.equal(heartbeatRan, true, 'manifest walk must not block a zero-delay timer');

    const manifest = await manifestPromise;
    assert.equal(manifest['project-1'].files.length, 500);
    assert.equal(manifest['Big Project'], manifest['project-1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project manifest ignores excluded paths but keeps oversized files as membership', async () => {
  // Oversized files MUST stay in the manifest (flagged `oversize`) — dropping
  // them made the sync reconciler read "excluded by size" as "user deleted
  // it" and reverse-delete the server's canonical copy (2026-08-07:
  // runway-turn.mp4 + 24 other server-generated media files phantom-trashed).
  const root = mkdtempSync(join(tmpdir(), 'empir3-sync-filter-'));
  try {
    const projectDir = join(root, 'Filtered');
    mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
    writeFileSync(join(projectDir, '.empir3-project.json'), JSON.stringify({ projectId: 'project-2' }));
    writeFileSync(join(projectDir, 'keep.txt'), 'keep');
    writeFileSync(join(projectDir, 'large.bin'), Buffer.alloc(32));
    writeFileSync(join(projectDir, 'node_modules', 'ignored.js'), 'ignored');
    const skipped = [];

    const manifest = await buildProjectManifest({
      root,
      metaFileName: '.empir3-project.json',
      shouldIgnorePath: (path) => path === '.empir3-project.json' || path.split('/').includes('node_modules'),
      maxFileBytes: 16,
      onSkip: (entry) => skipped.push(entry.path),
    });

    const files = manifest['project-2'].files;
    assert.deepEqual(files.map((file) => file.path).sort(), ['keep.txt', 'large.bin']);
    const large = files.find((file) => file.path === 'large.bin');
    assert.equal(large.oversize, true, 'oversized file must be flagged, not dropped');
    assert.equal(large.size, 32);
    const kept = files.find((file) => file.path === 'keep.txt');
    assert.equal(kept.oversize, undefined, 'in-budget files carry no flag');
    assert.deepEqual(skipped, ['large.bin'], 'onSkip still fires for the size log');
    assert.equal(files.some((file) => file.path.includes('ignored.js')), false, 'ignored paths stay out entirely');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
