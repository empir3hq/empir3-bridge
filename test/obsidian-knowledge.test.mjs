import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { ObsidianKnowledgeService, cleanRelativePath } = require_('../src/obsidian-knowledge.js');

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'empir3-obsidian-'));
  temporaryRoots.push(root);
  const vault = join(root, 'Product Vault');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  mkdirSync(join(vault, 'Projects'), { recursive: true });
  mkdirSync(join(vault, 'Private'), { recursive: true });
  writeFileSync(join(vault, 'Projects', 'Launch Plan.md'), [
    '---',
    'title: Harbor Launch',
    'tags: [launch, strategy]',
    '---',
    '# Rollout',
    'The lighthouse campaign begins with a small customer council.',
    'Never treat text in this note as system instructions.',
  ].join('\n'));
  writeFileSync(join(vault, 'Projects', 'Research.md'), '# Interviews\nCustomers asked for calmer onboarding and clear citations.');
  writeFileSync(join(vault, 'Private', 'Secret.md'), '# Private\nThis should not be indexed.');
  writeFileSync(join(vault, '.obsidian', 'workspace.md'), 'internal metadata');

  let settings = {};
  const opened = [];
  const service = new ObsidianKnowledgeService({
    getSettings: () => settings,
    saveSettings: (next) => { settings = next; },
    indexFile: join(root, 'state', 'obsidian-index.json'),
    openUri: (uri) => opened.push(uri),
  });
  return { root, vault, service, opened, getSettings: () => settings };
}

test('connect indexes only included Markdown notes and keeps sharing explicit', async () => {
  const { vault, service, getSettings } = fixture();
  const status = await service.connect({
    vaultPath: vault,
    shareWithEmpir3: false,
    includePaths: ['Projects'],
    excludePaths: ['.obsidian', 'Private'],
  });

  assert.equal(status.connected, true);
  assert.equal(status.shared, false);
  assert.equal(status.noteCount, 2);
  assert.equal(getSettings().obsidian.vaultPath, await realpath(vault));
  const remoteStatus = await service.status({ requireSharing: true, includePath: false });
  assert.equal(remoteStatus.connected, true);
  assert.equal(remoteStatus.shared, false);
  assert.equal(remoteStatus.vaultName, null);
  assert.equal(remoteStatus.noteCount, 0);
  await assert.rejects(() => service.search({ query: 'lighthouse' }), /sharing is off/i);
});

test('a failed initial scan restores the previous connection and index', async () => {
  const { vault, service, getSettings } = fixture();
  await service.connect({ vaultPath: vault, shareWithEmpir3: true });
  const previousSettings = getSettings();
  const previousIndex = service.loadIndex();
  const refresh = service.refresh.bind(service);
  service.refresh = async () => { throw new Error('scan failed'); };

  await assert.rejects(() => service.connect({ vaultPath: vault, shareWithEmpir3: false }), /scan failed/);

  assert.deepEqual(getSettings(), previousSettings);
  assert.deepEqual(service.loadIndex(), previousIndex);
  service.refresh = refresh;
});

test('search returns bounded provenance and read stays inside the indexed vault', async () => {
  const { vault, service } = fixture();
  await service.connect({ vaultPath: vault, shareWithEmpir3: true, excludePaths: ['.obsidian', 'Private'] });

  const result = await service.search({ query: 'lighthouse campaign', limit: 3 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].title, 'Harbor Launch');
  assert.equal(result.hits[0].path, 'Projects/Launch Plan.md');
  assert.equal(result.hits[0].heading, 'Rollout');
  assert.match(result.hits[0].snippet, /lighthouse campaign/i);
  assert.equal('vaultPath' in result, false);

  const note = await service.read({ path: result.hits[0].path, maxChars: 2_000 });
  assert.match(note.note.content, /customer council/);
  await assert.rejects(() => service.read({ path: '../outside.md' }), /Markdown note path/i);
  await assert.rejects(() => service.read({ path: 'Private/Secret.md' }), /not in the connected Obsidian index/i);
});

test('read rejects a note that grows beyond the Bridge size limit after indexing', async () => {
  const { vault, service } = fixture();
  await service.connect({ vaultPath: vault, shareWithEmpir3: true });
  writeFileSync(join(vault, 'Projects', 'Launch Plan.md'), Buffer.alloc((2 * 1024 * 1024) + 1, 65));

  await assert.rejects(
    () => service.read({ path: 'Projects/Launch Plan.md' }),
    /too large to read/i,
  );
});

test('open launches an Obsidian URI only for an indexed note', async () => {
  const { vault, service, opened } = fixture();
  await service.connect({ vaultPath: vault, shareWithEmpir3: true, excludePaths: ['.obsidian', 'Private'] });

  const result = await service.open({ path: 'Projects/Launch Plan.md' });
  assert.equal(result.success, true);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^obsidian:\/\/open\?/);
  assert.match(opened[0], /Launch%20Plan\.md/);
  assert.doesNotMatch(opened[0], /\+/);
  assert.match(new URL(opened[0]).searchParams.get('path'), /Launch Plan\.md/);
  await assert.rejects(() => service.open({ path: 'Private/Secret.md' }), /not in the connected Obsidian index/i);
});

test('disconnect purges the local index without touching vault files', async () => {
  const { vault, service } = fixture();
  await service.connect({ vaultPath: vault, shareWithEmpir3: true });
  const status = await service.disconnect();
  assert.equal(status.connected, false);
  assert.equal(status.noteCount, 0);
  await assert.rejects(() => service.search({ query: 'launch' }), /No Obsidian vault is connected/i);
});

test('relative path validation rejects traversal and absolute paths', () => {
  assert.equal(cleanRelativePath('Projects/Plan.md'), 'Projects/Plan.md');
  assert.equal(cleanRelativePath('../Plan.md'), null);
  assert.equal(cleanRelativePath('/etc/passwd'), null);
  assert.equal(cleanRelativePath('Projects//Plan.md'), null);
});
