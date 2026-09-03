import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const {
  abandonCliActionReceipt,
  createCliActionReceipt,
  markCliActionProcess,
  readCliActionReceipt,
} = require('../src/cli-action-receipt.js');

function fixture() {
  return join(tmpdir(), `e3-cli-receipt-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

test('a launched CLI action is running until its terminal writes a final receipt', () => {
  const root = fixture();
  try {
    const receipt = createCliActionReceipt(root, 'Update Grok');
    assert.match(receipt.id, /^[0-9a-f-]{36}$/i);
    const running = readCliActionReceipt(root, receipt.id);
    assert.equal(running.ok, true);
    assert.equal(running.status, 'running');
    assert.equal(running.label, 'Update Grok');
    assert.match(running.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('success and failure exit codes are preserved for the dashboard', () => {
  for (const exitCode of [0, 37]) {
    const root = fixture();
    try {
      const receipt = createCliActionReceipt(root, 'CLI action');
      writeFileSync(receipt.result, JSON.stringify({ exitCode }), 'utf8');
      const result = readCliActionReceipt(root, receipt.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.success, exitCode === 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a failed action returns a bounded redacted output tail', () => {
  const root = fixture();
  try {
    const receipt = createCliActionReceipt(root, 'Update Claude');
    writeFileSync(receipt.output, `npm error authorization=Bearer-secret\napi_key=very-secret\nnpm error install failed`, 'utf8');
    writeFileSync(receipt.result, JSON.stringify({ exitCode: 1 }), 'utf8');
    const result = readCliActionReceipt(root, receipt.id);
    assert.equal(result.success, false);
    assert.match(result.error, /npm error install failed/);
    assert.match(result.error, /authorization=\[redacted\]/i);
    assert.match(result.error, /api_key=\[redacted\]/i);
    assert.doesNotMatch(result.error, /very-secret|Bearer-secret/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unknown ids fail closed and an abandoned launch loses its pending receipt', () => {
  const root = fixture();
  try {
    assert.equal(readCliActionReceipt(root, '../escape').ok, false);
    const receipt = createCliActionReceipt(root, 'Auth');
    abandonCliActionReceipt(receipt);
    assert.equal(readCliActionReceipt(root, receipt.id).status, 'unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('closing the visible terminal early becomes an explicit failed result', () => {
  const root = fixture();
  try {
    const receipt = createCliActionReceipt(root, 'Update');
    markCliActionProcess(receipt, 2_000_000_000);
    const result = readCliActionReceipt(root, receipt.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.success, false);
    assert.match(result.error, /closed before/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
