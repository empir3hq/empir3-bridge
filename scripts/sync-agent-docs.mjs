#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = join(root, 'AGENTS.md');
const canonical = readFileSync(canonicalPath, 'utf8');
const targets = ['CLAUDE.md', 'GEMINI.md'];
const check = process.argv.includes('--check');
const drift = [];

for (const target of targets) {
  const path = join(root, target);
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Missing generated files are drift in check mode and are created in sync mode.
  }
  if (current === canonical) continue;
  if (check) drift.push(target);
  else {
    writeFileSync(path, canonical);
    console.log(`synced ${target} from AGENTS.md`);
  }
}

if (drift.length) {
  console.error(`Agent instruction drift: ${drift.join(', ')}. Run npm run agents:sync.`);
  process.exit(1);
}

if (check) console.log('AGENTS.md, CLAUDE.md, and GEMINI.md are byte-identical.');
