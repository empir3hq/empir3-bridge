#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(repoRoot, 'test');
const testFiles = readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => join(testDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error('No test/*.test.mjs files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start the Node test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
