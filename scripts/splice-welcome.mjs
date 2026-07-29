// One-shot splice: replace getWelcomeHtml() in src/server.ts with the
// generated body from scripts/welcome-body.txt (the template-literal
// contents only — no function wrapper).
//
// Why: the old function is ~770 lines; doing this via Edit means moving
// 50KB through the tool, which is fragile. Splicing by line range is
// surgical and obvious — `git diff` shows exactly one block changed.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SRV  = join(ROOT, 'src', 'server.ts');
const BODY = join(here, 'welcome-body.txt');

const src = readFileSync(SRV, 'utf8');
const body = readFileSync(BODY, 'utf8');

const startMarker = "function getWelcomeHtml(apiBase = '') {";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) throw new Error('start marker not found in src/server.ts');

// The function ends at the FIRST line that is just `}` after the start.
// Walk line by line from startIdx.
const before = src.slice(0, startIdx);
let i = startIdx;
let depth = 0;
let inSingle = false, inDouble = false, inBacktick = false, inLine = false, inBlock = false;
let prevCh = '';
let stopAt = -1;
for (; i < src.length; i++) {
  const c = src[i];
  // Comment skipping
  if (inLine) { if (c === '\n') inLine = false; prevCh = c; continue; }
  if (inBlock) { if (prevCh === '*' && c === '/') inBlock = false; prevCh = c; continue; }
  if (!inSingle && !inDouble && !inBacktick) {
    if (c === '/' && src[i+1] === '/') { inLine = true; i++; prevCh = ''; continue; }
    if (c === '/' && src[i+1] === '*') { inBlock = true; i++; prevCh = ''; continue; }
  }
  // String skipping (only outside other strings/comments)
  if (!inDouble && !inBacktick && c === "'" && prevCh !== '\\') { inSingle = !inSingle; prevCh = c; continue; }
  if (!inSingle && !inBacktick && c === '"' && prevCh !== '\\') { inDouble = !inDouble; prevCh = c; continue; }
  if (!inSingle && !inDouble && c === '`' && prevCh !== '\\') { inBacktick = !inBacktick; prevCh = c; continue; }
  if (inSingle || inDouble || inBacktick) { prevCh = c; continue; }
  // Brace tracking
  if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) { stopAt = i + 1; break; }
  }
  prevCh = c;
}
if (stopAt === -1) throw new Error('matching closing brace not found');

const after = src.slice(stopAt);
const newFn = "function getWelcomeHtml(apiBase = '') {\n" + body + "\n}";

writeFileSync(SRV, before + newFn + after);
const oldLen = (src.slice(startIdx, stopAt).match(/\n/g) || []).length + 1;
const newLen = (newFn.match(/\n/g) || []).length + 1;
console.log(`Replaced getWelcomeHtml: ${oldLen} → ${newLen} lines`);
