import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
const { blockedCredentialReadPath, canonicalReadablePath } = createRequire(import.meta.url)('../src/path-guard.js');

test('Bridge and CLI credentials are denied on Windows, Linux, and macOS', () => {
  for (const path of [
    'C:\\Users\\fixture\\AppData\\Roaming\\Empir3\\bridge-auth.json',
    'C:\\Users\\fixture\\.codex\\auth.json', 'C:\\Users\\fixture\\.claude\\.credentials.json',
    '/home/fixture/.codex/auth.json', '/home/fixture/.claude/.credentials.json',
    '/Users/fixture/.grok/auth.json', '/Users/fixture/.empir3-bridge/config.json.bak',
    '/home/fixture/.config/gemini/credentials.json', '/home/fixture/.claude/secrets.md',
    '/home/fixture/.gemini/oauth_creds.json',
    'C:\\Users\\fixture\\AppData\\Local\\Google\\Chrome\\User Data\\Local State',
  ]) assert.ok(blockedCredentialReadPath(path, path.startsWith('C:') ? 'win32' : 'linux'), path);
  for (const path of ['/home/fixture/project/auth.json', '/home/fixture/.claude/skills/work/SKILL.md', 'C:\\work\\authentication.md']) {
    assert.equal(blockedCredentialReadPath(path), null, path);
  }
  assert.ok(blockedCredentialReadPath('C:\\work\\file.txt:secret', 'win32'));
  assert.ok(blockedCredentialReadPath('\\\\server\\share\\file.txt', 'win32'));
});

test('canonical containment rejects directory junctions, renamed hard links, and credential aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-read-guard-'));
  try {
    const allowed = join(root, 'project');
    const outside = join(root, 'outside');
    const creds = join(root, '.codex');
    for (const dir of [allowed, outside, creds]) mkdirSync(dir);
    writeFileSync(join(allowed, 'notes.txt'), 'ordinary fixture');
    writeFileSync(join(outside, 'private.txt'), 'synthetic');
    writeFileSync(join(creds, 'auth.json'), 'synthetic, not a credential');
    symlinkSync(outside, join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(creds, join(allowed, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(canonicalReadablePath(join(allowed, 'notes.txt'), { allowedRoots: [allowed] }).ok, true);
    assert.equal(canonicalReadablePath(join(allowed, 'escape', 'private.txt'), { allowedRoots: [allowed] }).ok, false);
    assert.equal(canonicalReadablePath(join(allowed, 'alias', 'auth.json')).ok, false);
    linkSync(join(creds, 'auth.json'), join(allowed, 'innocent.txt'));
    assert.equal(canonicalReadablePath(join(allowed, 'innocent.txt')).ok, false);
    assert.equal(canonicalReadablePath(join(allowed, 'notes.txt'), { protectedPaths: [join(allowed, 'notes.txt')] }).ok, false);
  } finally {
    // root is a freshly created fixture directory. Node removes junctions
    // themselves, never follows them to their targets.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('empir3-read-guard-'));
    rmSync(root, { recursive: true, force: true });
  }
});
