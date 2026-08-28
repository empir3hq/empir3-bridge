'use strict';

const { randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const ACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function receiptDir(launcherDir) {
  return path.join(launcherDir, 'results');
}

function receiptPaths(launcherDir, id) {
  const dir = receiptDir(launcherDir);
  return {
    dir,
    pending: path.join(dir, `${id}.pending.json`),
    temp: path.join(dir, `${id}.result.tmp`),
    result: path.join(dir, `${id}.result.json`),
    output: path.join(dir, `${id}.output.log`),
  };
}

function trimReceipts(dir, now = Date.now()) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}\.(?:pending\.json|result\.json|result\.tmp|output\.log)$/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > RETENTION_MS) unlinkSync(file);
    } catch {}
  }
}

function createCliActionReceipt(launcherDir, label) {
  const id = randomUUID();
  const paths = receiptPaths(launcherDir, id);
  mkdirSync(paths.dir, { recursive: true });
  trimReceipts(paths.dir);
  writeFileSync(paths.pending, JSON.stringify({ id, label: String(label || 'CLI action').slice(0, 100), startedAt: new Date().toISOString() }), 'utf8');
  return { id, ...paths };
}

function abandonCliActionReceipt(receipt) {
  for (const file of [receipt?.pending, receipt?.temp, receipt?.output]) {
    try { if (file && existsSync(file)) unlinkSync(file); } catch {}
  }
}

function safeOutputTail(file, maxChars = 2400) {
  if (!file || !existsSync(file)) return '';
  try {
    const raw = readFileSync(file, 'utf8')
      .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .trim();
    if (!raw) return '';
    return raw.length > maxChars ? `…${raw.slice(-maxChars)}` : raw;
  } catch {
    return '';
  }
}

function markCliActionProcess(receipt, pid) {
  const numericPid = Number(pid);
  if (!receipt?.pending || !Number.isInteger(numericPid) || numericPid <= 0 || existsSync(receipt.result)) return;
  try {
    const pending = JSON.parse(readFileSync(receipt.pending, 'utf8'));
    writeFileSync(receipt.pending, JSON.stringify({ ...pending, pid: numericPid }), 'utf8');
  } catch {}
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readCliActionReceipt(launcherDir, id) {
  if (!ACTION_ID_RE.test(String(id || ''))) return { ok: false, status: 'unknown', error: 'Invalid CLI action id.' };
  const paths = receiptPaths(launcherDir, id);
  if (existsSync(paths.result)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.result, 'utf8'));
      const exitCode = Number(parsed?.exitCode);
      if (!Number.isInteger(exitCode)) throw new Error('invalid exit code');
      const success = exitCode === 0;
      const output = success ? '' : safeOutputTail(paths.output);
      return {
        ok: true,
        status: 'completed',
        exitCode,
        success,
        ...(output ? { error: output } : {}),
      };
    } catch {
      return { ok: false, status: 'unknown', error: 'CLI action receipt is unreadable.' };
    }
  }
  if (existsSync(paths.pending)) {
    try {
      const pending = JSON.parse(readFileSync(paths.pending, 'utf8'));
      if (Number.isInteger(pending?.pid) && !processIsAlive(pending.pid)) {
        return {
          ok: true,
          status: 'completed',
          success: false,
          exitCode: null,
          error: 'Visible terminal closed before the CLI action produced a completion receipt.',
        };
      }
      return { ok: true, status: 'running', label: pending?.label, startedAt: pending?.startedAt };
    } catch {
      return { ok: true, status: 'running' };
    }
  }
  return { ok: false, status: 'unknown', error: 'CLI action is unknown or its receipt expired.' };
}

module.exports = {
  ACTION_ID_RE,
  abandonCliActionReceipt,
  createCliActionReceipt,
  markCliActionProcess,
  readCliActionReceipt,
  receiptPaths,
};
