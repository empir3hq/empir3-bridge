import { closeSync, existsSync, fstatSync, openSync, readSync } from 'fs';
import { homedir } from 'os';

const MAX_REMOTE_LOG_LINES = 500;
const MAX_REMOTE_LOG_BYTES = 256 * 1024;
const MAX_REMOTE_LINE_CHARS = 2000;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeBridgeLogLine(raw: unknown, home = homedir()): string {
  let line = String(raw ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (home) line = line.replace(new RegExp(escapeRegex(home), 'gi'), '%USERPROFILE%');
  line = line
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|auth_token|token|api_key|key|secret)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:"|')?(?:authorization|access[_-]?token|auth[_-]?token|token|api[_-]?key|secret|password)(?:"|')?\s*[:=]\s*(?:"|')?)[^,"'\s}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|xai|tvly|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  return line.slice(0, MAX_REMOTE_LINE_CHARS);
}

function readFileTail(path: string, maxBytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readSanitizedBridgeLogTail(options: {
  path: string;
  lines?: number;
  actionLines?: string[];
  home?: string;
}): { source: 'bridge.log' | 'action-log' | 'empty'; lines: string[]; truncated: boolean; capturedAt: string } {
  const limit = Math.min(Math.max(Number(options.lines || 200), 10), MAX_REMOTE_LOG_LINES);
  let source: 'bridge.log' | 'action-log' | 'empty' = 'empty';
  let rawLines: string[] = [];
  let truncated = false;
  try {
    if (options.path && existsSync(options.path)) {
      const text = readFileTail(options.path, MAX_REMOTE_LOG_BYTES);
      rawLines = text.split(/\r?\n/).filter(Boolean);
      truncated = Buffer.byteLength(text) >= MAX_REMOTE_LOG_BYTES;
      source = rawLines.length > 0 ? 'bridge.log' : 'empty';
    }
  } catch {}
  if (rawLines.length === 0 && Array.isArray(options.actionLines)) {
    rawLines = options.actionLines.filter(Boolean);
    source = rawLines.length > 0 ? 'action-log' : 'empty';
  }
  return {
    source,
    lines: rawLines.slice(-limit).map((line) => sanitizeBridgeLogLine(line, options.home)),
    truncated,
    capturedAt: new Date().toISOString(),
  };
}
