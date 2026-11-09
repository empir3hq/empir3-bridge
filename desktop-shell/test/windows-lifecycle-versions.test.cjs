'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { windowsLifecycleVersions, verifiedInstaller } = require('../scripts/windows-update-fixture.cjs');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
test('Windows lifecycle accepts the current candidate and an explicit older baseline', () => {
  assert.deepEqual(windowsLifecycleVersions('0.4.12','0.4.11'),{candidateVersion:'0.4.12',previousVersion:'0.4.11'});
  assert.deepEqual(windowsLifecycleVersions('0.5.0','0.4.99'),{candidateVersion:'0.5.0',previousVersion:'0.4.99'});
});
test('missing, malformed, same-version and newer rollback baselines fail before installation', () => {
  for (const prior of [undefined,'','v0.4.11','0.04.11','0.4.11-extra','0.4.12','0.5.0'])
    assert.throws(()=>windowsLifecycleVersions('0.4.12',prior));
  assert.throws(()=>windowsLifecycleVersions('not-a-version','0.4.11'));
});
test('rollback mismatch check remains meaningful when candidate is 0.4.99', async () => {
  const directory=mkdtempSync(join(tmpdir(),'empir3-windows-update-policy-'));
  try {
    const source=join(directory,'synthetic-policy-only.exe');writeFileSync(source,'Not an executable; policy/download test bytes only');
    await verifiedInstaller({source,version:'0.4.11',currentVersion:'0.4.99',rollback:true,directory});
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
