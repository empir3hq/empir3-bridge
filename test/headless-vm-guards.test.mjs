import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('disposable VM harness refuses implicit local execution, wrong bytes, and optimized guards before starting a VM', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-vm-guard-test-'));
  const host = fileURLToPath(new URL('../headless-package/scripts/acceptance-vm-host.py', import.meta.url));
  const guest = fileURLToPath(new URL('../headless-package/scripts/acceptance-vm-guest.py', import.meta.url));
  try {
    const archive = join(root, 'wrong.tar.gz');
    const receipt = join(root, 'identity.json');
    writeFileSync(archive, 'deliberately incorrect candidate bytes');
    writeFileSync(receipt, JSON.stringify({
      archiveSha256: '0'.repeat(64), candidateSource: '0'.repeat(40), version: '0.4.12',
    }));
    const invoke = (args) => {
      const result = spawnSync('python3', args, {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_TEMP: root },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      return result.stderr;
    };
    assert.match(invoke([host, archive]), /Explicit local disposable-VM mode is required/);
    assert.match(invoke([host, archive, '--local-disposable', '--candidate-receipt', receipt]), /Candidate archive hash mismatch/);
    for (const script of [host, guest]) {
      assert.match(invoke(['-O', script]), /Optimized Python would disable acceptance guards/);
    }
    // A non-root process cannot invoke the destructive guest stages, even with
    // a plausible phase and nonce. No service or filesystem changes are made.
    assert.match(invoke([guest, 'install', 'not-a-guest-nonce']), /AssertionError/);

    // Cross-architecture execution must not silently copy the host's Node or
    // accept an archive for a different target. Both checks happen before QEMU.
    const metadata = JSON.stringify({ version: '0.4.12', platform: 'linux', arch: 'arm64' });
    const pack = spawnSync('python3', ['-c',
      'import io,sys,tarfile; data=sys.argv[2].encode(); t=tarfile.open(sys.argv[1],"w:gz"); m=tarfile.TarInfo("package-metadata.json"); m.size=len(data); t.addfile(m,io.BytesIO(data)); t.close()',
      archive, metadata], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(pack.error);
    assert.equal(pack.status, 0, pack.stderr);
    const identity = {
      archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      candidateSource: '0'.repeat(40), version: '0.4.12', arch: 'x64',
    };
    writeFileSync(receipt, JSON.stringify(identity));
    const flags = [host, archive, '--local-disposable', '--candidate-receipt', receipt];
    assert.match(invoke(flags), /Candidate architecture mismatch/);
    writeFileSync(receipt, JSON.stringify({ ...identity, arch: 'arm64' }));
    const fakeNode = join(root, 'node');
    const elf = Buffer.alloc(20);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
    elf.writeUInt16LE(62, 18); // x64 Node cannot execute in an ARM64 guest.
    writeFileSync(fakeNode, elf);
    assert.match(invoke([...flags, '--guest-node', fakeNode]), /Explicit guest Node requires its SHA-256/);
    assert.match(invoke([...flags, '--guest-node', fakeNode, '--guest-node-sha256', '0'.repeat(64)]), /Guest Node hash mismatch/);
    assert.match(invoke([...flags, '--guest-node', fakeNode, '--guest-node-sha256', createHash('sha256').update(elf).digest('hex')]), /Guest Node architecture mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
