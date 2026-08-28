'use strict';

const {
  chmodSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const driverSource = `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('codex-cli 0.0.0-empir3-smoke');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT (Empir3 smoke)');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [{
    slug: 'smoke-model',
    display_name: 'Smoke Model',
    visibility: 'list',
    supported_in_api: false,
    context_window: 128000,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  }] }));
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const valid = args[0] === 'exec'
    && args.includes('--json')
    && args.includes('--skip-git-repo-check')
    && args.includes('--sandbox')
    && args.at(-1) === '-'
    && input === 'hello packaged cli';
  fs.writeFileSync(process.env.EMPIR3_DESKTOP_SMOKE_CLI_RECEIPT, JSON.stringify({ args, input, valid }));
  if (!valid) process.exit(42);
  console.log(JSON.stringify({ type: 'agent_message', text: 'smoke-cli: hello packaged cli' }));
});
`;

function createFakeCodexCli(scratch) {
  const binDir = join(scratch, 'fake-cli-bin');
  const receiptPath = join(scratch, 'fake-codex-receipt.json');
  mkdirSync(binDir, { recursive: true });
  const driverPath = join(binDir, 'codex-smoke.cjs');
  writeFileSync(driverPath, driverSource);
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'codex.cmd'),
      '@echo off\r\n"%EMPIR3_DESKTOP_SMOKE_NODE%" "%~dp0codex-smoke.cjs" %*\r\n',
    );
  } else {
    const launcher = join(binDir, 'codex');
    writeFileSync(launcher, '#!/bin/sh\nexec "$EMPIR3_DESKTOP_SMOKE_NODE" "$(dirname "$0")/codex-smoke.cjs" "$@"\n');
    chmodSync(launcher, 0o755);
  }
  return { binDir, driverPath, receiptPath };
}

module.exports = { createFakeCodexCli };
