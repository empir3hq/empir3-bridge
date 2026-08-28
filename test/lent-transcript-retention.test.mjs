import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeProjectSlug,
  normalizeRetentionDays,
  payloadRootOf,
  sweepLentTranscripts,
} from '../src/lent-transcript-retention.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeFile(path, ageDays, now) {
  await writeFile(path, 'transcript', 'utf-8');
  const at = new Date(now - ageDays * DAY_MS);
  await utimes(path, at, at);
}

test('claude project slug matches Claude Code directory naming', () => {
  assert.equal(claudeProjectSlug('d:\\Github\\empir3-bridge'), 'd--Github-empir3-bridge');
  assert.equal(claudeProjectSlug('C:\\Users\\vault\\.empir3-bridge\\payload\\0.3.85'), 'C--Users-vault--empir3-bridge-payload-0-3-85');
  assert.equal(payloadRootOf('C:\\Users\\vault\\.empir3-bridge\\payload\\0.3.85'), 'C:\\Users\\vault\\.empir3-bridge\\payload');
  assert.equal(payloadRootOf('C:\\Users\\vault\\projects\\demo'), null);
  assert.equal(payloadRootOf('/opt/empir3/payload/0.3.94'), '/opt/empir3/payload');
});

test('retention days normalize with an explicit-zero off switch', () => {
  assert.equal(normalizeRetentionDays(undefined), 7);
  assert.equal(normalizeRetentionDays('garbage'), 7);
  assert.equal(normalizeRetentionDays(3), 3);
  assert.equal(normalizeRetentionDays(0), 0);
  assert.equal(normalizeRetentionDays(-5), 0);
  assert.equal(normalizeRetentionDays(10_000), 365);
});

test('sweep removes only old transcripts in Bridge-owned lent dirs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-retention-'));
  try {
    const now = Date.now();
    const projects = join(root, 'projects');
    const payloadRoot = 'C:\\Users\\vault\\.empir3-bridge\\payload';
    const payloadCwd = `${payloadRoot}\\0.3.85`;
    const olderPayloadSlug = claudeProjectSlug(`${payloadRoot}\\0.3.72`);
    const homeCwd = 'C:\\Users\\vault\\Documents\\Empir3';
    const ownerProjectSlug = claudeProjectSlug('D:\\Github\\owner-repo');

    for (const slug of [claudeProjectSlug(payloadCwd), olderPayloadSlug, claudeProjectSlug(homeCwd), ownerProjectSlug]) {
      await mkdir(join(projects, slug), { recursive: true });
      await makeFile(join(projects, slug, 'old-turn.jsonl'), 30, now);
      await makeFile(join(projects, slug, 'fresh-turn.jsonl'), 1, now);
      await makeFile(join(projects, slug, 'not-a-transcript.txt'), 30, now);
    }

    const cliRuns = join(root, 'cli-runs');
    await mkdir(cliRuns, { recursive: true });
    await makeFile(join(cliRuns, 'run-old.json'), 30, now);
    await makeFile(join(cliRuns, 'run-old.prompt.txt'), 30, now);
    await makeFile(join(cliRuns, 'run-fresh.json'), 1, now);

    const result = await sweepLentTranscripts({
      claudeProjectsDir: projects,
      cliRunsDir: cliRuns,
      lentCwds: [payloadCwd, homeCwd],
      lentCwdRoots: [payloadRoot],
      retentionDays: 7,
      now,
    });

    assert.equal(result.enabled, true);
    // 3 lent project dirs (payload cwd, older payload version via root prefix,
    // home dir) + the cli-runs dir.
    assert.equal(result.scannedDirs, 4);
    // One old .jsonl per lent project dir + two old cli-runs files.
    assert.equal(result.deletedFiles, 5);

    // Fresh transcripts and non-jsonl files survive in swept dirs.
    for (const slug of [claudeProjectSlug(payloadCwd), olderPayloadSlug, claudeProjectSlug(homeCwd)]) {
      const remaining = (await readdir(join(projects, slug))).sort();
      assert.deepEqual(remaining, ['fresh-turn.jsonl', 'not-a-transcript.txt']);
    }
    // The owner's own project directory is untouched, old files included.
    assert.equal((await readdir(join(projects, ownerProjectSlug))).length, 3);
    assert.deepEqual((await readdir(cliRuns)).sort(), ['run-fresh.json']);

    // retentionDays 0 disables the sweep entirely.
    const disabled = await sweepLentTranscripts({
      claudeProjectsDir: projects,
      cliRunsDir: cliRuns,
      lentCwds: [payloadCwd],
      retentionDays: 0,
      now,
    });
    assert.deepEqual(disabled, { enabled: false, scannedDirs: 0, deletedFiles: 0, retentionDays: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli-see one-transcript dirs age out by root prefix and prune when empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-retention-see-'));
  try {
    const now = Date.now();
    const projects = join(root, 'projects');
    // Each claude :see call spawns with a mkdtemp temp dir as cwd, so every
    // caption leaves one single-file project dir behind (observed live:
    // 27/day on the Vault). They share the cli-see root's slug prefix.
    const seeRoot = 'C:\\Users\\vault\\.empir3-bridge\\cli-see';
    const oldSee = claudeProjectSlug(`${seeRoot}\\empir3-claude-see-abc123`);
    const freshSee = claudeProjectSlug(`${seeRoot}\\empir3-claude-see-xyz789`);
    await mkdir(join(projects, oldSee), { recursive: true });
    await makeFile(join(projects, oldSee, 'turn.jsonl'), 30, now);
    await mkdir(join(projects, freshSee), { recursive: true });
    await makeFile(join(projects, freshSee, 'turn.jsonl'), 1, now);

    const result = await sweepLentTranscripts({
      claudeProjectsDir: projects,
      lentCwds: [],
      lentCwdRoots: [seeRoot],
      retentionDays: 7,
      now,
    });

    assert.equal(result.deletedFiles, 1);
    assert.equal(result.prunedDirs, 1);
    const remaining = (await readdir(projects)).sort();
    assert.deepEqual(remaining, [freshSee]); // emptied dir pruned, fresh one intact
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('drive-letter case differences still match the lent slug', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empir3-retention-case-'));
  try {
    const now = Date.now();
    const projects = join(root, 'projects');
    // Claude normalized the drive letter to lowercase; the Bridge saw uppercase.
    const slug = claudeProjectSlug('c:\\Users\\vault\\Documents\\Empir3');
    await mkdir(join(projects, slug), { recursive: true });
    await makeFile(join(projects, slug, 'old.jsonl'), 30, now);

    const result = await sweepLentTranscripts({
      claudeProjectsDir: projects,
      lentCwds: ['C:\\Users\\vault\\Documents\\Empir3'],
      retentionDays: 7,
      now,
    });
    assert.equal(result.deletedFiles, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
