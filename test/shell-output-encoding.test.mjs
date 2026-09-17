/**
 * A Windows shell's stdout is UTF-8, so a clean file reads as a clean file
 * (customer card c31eac25, jjeckart@protonmail.com, 2026-09-13).
 *
 * WHAT HAPPENED. An agent audited this customer's UTF-8 notes with
 * `Get-Content -Raw` over bridge_job, saw byte garbage where the em-dashes and
 * curly apostrophes were, and reported "encoding damage" in HER FILES. A later
 * check against the raw bytes found zero U+FFFD and every character intact:
 * the files had always been clean. The mangling was introduced between the
 * PowerShell child and us — the child writes its stdout in the console code
 * page and `runProcess` decodes that stream as UTF-8. The false reading was
 * passed to the customer's local model and became a recommendation that had to
 * be retracted.
 *
 * REFUSAL PROOF. The round-trip test below runs the SAME command twice: once
 * with the preamble the daemon now prepends, once without. The "without" case
 * is the bug, and the test asserts it actually mangles — so if the preamble is
 * ever removed, the contract test goes red AND the round-trip has already
 * demonstrated what removing it costs. On a non-Windows box the round trip is
 * skipped; the source contract still runs everywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Windows honors explicit pwsh and reports its fallback accurately', () => {
  const source = server.slice(server.indexOf('const PS_UTF8_PREAMBLE'), server.indexOf('async function handleNotifyCommand'));
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const executable of ['C:/PowerShell/pwsh.exe', null]) {
    const context = vm.createContext({ process: { platform: 'win32' }, resolveExecutable: () => executable, existsSync: () => true });
    vm.runInContext(code, context);
    const result = context.resolveExecShell('pwsh', 'Write-Output $sample');
    assert.equal(result.file, executable || 'powershell.exe');
    assert.equal(result.shell, executable ? 'pwsh' : 'powershell');
    assert.ok(result.args.at(-1).endsWith('Write-Output $sample'));
    assert.equal(context.resolveExecShell('powershell', 'exit 7').file, 'powershell.exe');
    assert.equal(context.resolveExecShell('', 'exit 7').file, 'powershell.exe');
    assert.equal(context.resolveExecShell('cmd', 'exit 7').file, 'cmd.exe');
  }
});

test('resolveExecShell pins UTF-8 output for both Windows shells', () => {
  assert.match(
    server,
    /const PS_UTF8_PREAMBLE = "\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8; \$OutputEncoding=\[Text\.Encoding\]::UTF8; ";/,
  );
  assert.match(server, /const CMD_UTF8_PREAMBLE = 'chcp 65001>nul & ';/);
  // The preamble is PREPENDED, never wrapped: the command's own text, quoting
  // and exit code must be untouched.
  assert.match(server, /args: \['\/c', `\$\{CMD_UTF8_PREAMBLE\}\$\{command\}`\], shell: 'cmd'/);
  assert.match(server, /args: \['-NoProfile', '-NonInteractive', '-Command', `\$\{PS_UTF8_PREAMBLE\}\$\{command\}`\]/);
  // The bug: a bare -Command with the raw command and no encoding pin, inside
  // the win32 branch. (The POSIX `pwsh` branch below it keeps the raw command
  // on purpose — pwsh on Linux/macOS already speaks UTF-8.)
  const at = server.indexOf('function resolveExecShell(');
  const win32Branch = server.slice(at, server.indexOf('// POSIX. bash is preferred', at));
  assert.ok(at > 0 && win32Branch.length > 0, 'resolveExecShell win32 branch located');
  assert.doesNotMatch(win32Branch, /'-NonInteractive', '-Command', command\]/);
  assert.doesNotMatch(win32Branch, /args: \['\/c', command\]/);
});

function psPreambleFromSource() {
  const m = /const PS_UTF8_PREAMBLE = "([^"]+)";/.exec(server);
  assert.ok(m, 'PS_UTF8_PREAMBLE is defined in server.ts');
  return m[1];
}

function runPowerShell(command) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

test('a UTF-8 file round-trips exactly with the preamble, and is mangled without it', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e3-enc-'));
  const file = join(dir, 'notes.txt');
  const original = 'em dash — and curly ’ apostrophe';
  writeFileSync(file, original, 'utf8');
  try {
    // Read the bytes as UTF-8 explicitly, so the only variable under test is
    // what happens to the characters on their way OUT of the shell.
    const read = `[IO.File]::ReadAllText(${JSON.stringify(file)},[Text.Encoding]::UTF8)`;

    const withPin = (await runPowerShell(psPreambleFromSource() + read)).replace(/\r?\n$/, '');
    assert.equal(withPin, original);
    assert.equal((withPin.match(/�/g) || []).length, 0);

    const without = (await runPowerShell(read)).replace(/\r?\n$/, '');
    // This is the defect, reproduced: the console code page silently rewrites
    // the characters and hands back something that reads like a damaged file.
    assert.notEqual(without, original, 'unpinned stdout must still demonstrate the corruption this preamble prevents');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
