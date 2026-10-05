'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createFakeCodexCli } = require('../scripts/smoke-codex-cli-fixture.cjs');

test('packaged Codex fixture separates model discovery from chat execution', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'empir3-codex-smoke-fixture-'));
  try {
    const fixture = createFakeCodexCli(scratch);
    const env = {
      ...process.env,
      EMPIR3_DESKTOP_SMOKE_CLI_RECEIPT: fixture.receiptPath,
      EMPIR3_DESKTOP_SMOKE_NODE: process.execPath,
    };
    const execArgs = [
      fixture.driverPath,
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-',
    ];
    const executed = spawnSync(process.execPath, execArgs, {
      env,
      input: 'hello packaged cli',
      encoding: 'utf8',
    });
    assert.equal(executed.status, 0, executed.stderr);
    const executionReceipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
    assert.equal(executionReceipt.valid, true);

    const catalog = spawnSync(process.execPath, [fixture.driverPath, 'debug', 'models'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.deepEqual(JSON.parse(catalog.stdout).models.map((model) => model.slug), ['smoke-model']);
    assert.deepEqual(JSON.parse(readFileSync(fixture.receiptPath, 'utf8')), executionReceipt);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
