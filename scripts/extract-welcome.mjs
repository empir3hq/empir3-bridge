// Reverse of splice-welcome.mjs: regenerate scripts/welcome-body.txt FROM the
// current getWelcomeHtml() body in src/server.ts. Use this to re-sync the
// template after the function was edited directly in server.ts, so a later
// `node scripts/splice-welcome.mjs` is a no-op instead of clobbering live code.
//
// Boundary contract MUST mirror splice-welcome.mjs exactly:
//   spliced server.ts contains  "function getWelcomeHtml(apiBase = '') {\n" + body + "\n}"
//   => body = src.slice(bodyStart, stopAt - 2)   (strip the leading "\n" after "{"
//      and the trailing "\n}" the splicer adds).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SRV  = join(ROOT, 'src', 'server.ts');
const BODY = join(here, 'welcome-body.txt');

const src = readFileSync(SRV, 'utf8');

const startMarker = "function getWelcomeHtml(apiBase = '') {";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) throw new Error('start marker not found in src/server.ts');

// Identical brace/string/comment walk to splice-welcome.mjs.
let i = startIdx;
let depth = 0;
let inSingle = false, inDouble = false, inBacktick = false, inLine = false, inBlock = false;
let prevCh = '';
let stopAt = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (inLine) { if (c === '\n') inLine = false; prevCh = c; continue; }
  if (inBlock) { if (prevCh === '*' && c === '/') inBlock = false; prevCh = c; continue; }
  if (!inSingle && !inDouble && !inBacktick) {
    if (c === '/' && src[i+1] === '/') { inLine = true; i++; prevCh = ''; continue; }
    if (c === '/' && src[i+1] === '*') { inBlock = true; i++; prevCh = ''; continue; }
  }
  if (!inDouble && !inBacktick && c === "'" && prevCh !== '\\') { inSingle = !inSingle; prevCh = c; continue; }
  if (!inSingle && !inBacktick && c === '"' && prevCh !== '\\') { inDouble = !inDouble; prevCh = c; continue; }
  if (!inSingle && !inDouble && c === '`' && prevCh !== '\\') { inBacktick = !inBacktick; prevCh = c; continue; }
  if (inSingle || inDouble || inBacktick) { prevCh = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { stopAt = i + 1; break; } }
  prevCh = c;
}
if (stopAt === -1) throw new Error('matching closing brace not found');

// Skip the newline sequence right after the "{" (CRLF or LF).
let bodyStart = startIdx + startMarker.length;
if (src[bodyStart] === '\r') bodyStart++;
if (src[bodyStart] === '\n') bodyStart++;
else throw new Error(`expected newline right after function signature, got ${JSON.stringify(src.slice(startIdx + startMarker.length, startIdx + startMarker.length + 2))}`);

// The closing "}" is at stopAt-1; trim the newline sequence (\r?\n) before it.
let bodyEnd = stopAt - 1; // index of '}'
if (src[bodyEnd - 1] === '\n') bodyEnd--;
if (src[bodyEnd - 1] === '\r') bodyEnd--;

const body = src.slice(bodyStart, bodyEnd);
writeFileSync(BODY, body);
const lines = (body.match(/\n/g) || []).length + 1;
console.log(`Extracted getWelcomeHtml body -> welcome-body.txt (${lines} lines, ${body.length} bytes)`);
