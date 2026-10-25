import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Owner, 2026-09-30: signed in to Higgsfield several times and the tray kept
// saying NEEDS AUTH. The CLI was signed in fine — `auth login` had cleared the
// billing workspace, so `model list` exited "No workspace selected", which the
// Bridge classified as a generic cli_error.
const handler = readFileSync(new URL('../src/handlers/higgsfield-cli.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

function recovery(workspaces, setExitCode = 0) {
  const calls = [];
  const tree = ts.createSourceFile('higgsfield-cli.ts', handler, ts.ScriptTarget.Latest, true);
  const functions = ['selectSoleWorkspace', 'spawnCapture'].map(name => tree.statements
    .find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(tree)).join('\n');
  const result = (exitCode, stdout = '', stderr = '') => ({ exitCode, stdout, stderr, timedOut: false, elapsedMs: 1 });
  const context = vm.createContext({
    NO_WORKSPACE_PATTERN: /no workspace selected/i, LIST_TIMEOUT_MS: 30000,
    safeJsonParse: JSON.parse, console: { log() {} },
    spawnCaptureOnce: async (_bin, args) => {
      calls.push([...args]);
      if (args[0] === 'workspace') return args[1] === 'list'
        ? result(0, JSON.stringify(workspaces)) : result(setExitCode);
      return calls.length === 1 ? result(1, '', 'No workspace selected') : result(0, 'ready');
    },
  });
  vm.runInContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { calls, run: args => context.spawnCapture('fixture', args, 1000) };
}

test('workspace recovery executes one selection and one retry after a definitive rejection', async () => {
  const f = recovery({ items: [{ id: 'only-workspace' }] });
  assert.equal((await f.run(['model', 'list'])).exitCode, 0);
  assert.deepEqual(f.calls, [['model', 'list'], ['workspace', 'list', '--json'], ['workspace', 'set', 'only-workspace'], ['model', 'list']]);
});

test('workspace recovery leaves a multiple-workspace account unchanged', async () => {
  const f = recovery([{ id: 'first' }, { id: 'second' }]);
  assert.equal((await f.run(['model', 'list'])).exitCode, 1);
  assert.deepEqual(f.calls, [['model', 'list'], ['workspace', 'list', '--json']]);
});

test('a failed workspace selection never retries a billed command', async () => {
  const f = recovery([{ id: 'only-workspace' }], 1);
  assert.equal((await f.run(['generate', 'model', 'prompt'])).exitCode, 1);
  assert.equal(f.calls.filter(args => args[0] === 'generate').length, 1);
});

test('workspace and login commands cannot recursively trigger recovery', async () => {
  for (const args of [['workspace', 'set', 'chosen'], ['auth', 'login']]) {
    const f = recovery([{ id: 'only-workspace' }]);
    await f.run(args);
    assert.equal(f.calls.length, 1);
  }
});

test('"No workspace selected" is its own failure, not a sign-in failure', () => {
  assert.match(handler, /const NO_WORKSPACE_PATTERN = \/no workspace selected\/i;/);
  assert.match(handler, /stage: 'no_workspace', recoverable: true/);
  // Checked before the generic fallback, so it can never become cli_error.
  assert.ok(handler.indexOf("stage: 'no_workspace'") < handler.indexOf("stage: 'cli_error'"));
});

test('a sole workspace is selected automatically and the command runs again, once', () => {
  const wrapper = handler.slice(handler.indexOf('async function spawnCapture('), handler.indexOf('function spawnCaptureOnce('));
  assert.match(wrapper, /NO_WORKSPACE_PATTERN\.test/);
  assert.match(wrapper, /selectSoleWorkspace\(bin\)/);
  assert.match(wrapper, /healed\.selected \? spawnCaptureOnce\(bin, argv, timeoutMs\) : r/);
  // Workspace and auth commands never recurse into the heal.
  assert.match(wrapper, /argv\[0\] !== 'workspace' && argv\[0\] !== 'auth'/);
  const pick = handler.slice(handler.indexOf('async function selectSoleWorkspace('), handler.indexOf('async function spawnCapture('));
  assert.match(pick, /if \(ids\.length !== 1\) return \{ selected: false/);
  assert.match(pick, /\['workspace', 'set', ids\[0\]\]/);
});

test('every Higgsfield command goes through the healing wrapper', () => {
  const raw = [...handler.matchAll(/spawnCaptureOnce\(bin, /g)].length;
  // Only the wrapper itself and the two workspace commands call the raw spawn.
  assert.equal(raw, 4);
});

test('the tray says PICK A WORKSPACE, not NEEDS AUTH, when several workspaces need a choice', () => {
  assert.match(handler, /reason: `no_workspace: \$\{HIGGSFIELD_WORKSPACE_HINT\}`/);
  assert.match(server, /row\.id === 'higgsfield' && \/\^no_workspace\/\.test\(String\(p\.auth_reason \|\| ''\)\)/);
  assert.match(server, /PICK A WORKSPACE/);
  assert.ok(server.indexOf('PICK A WORKSPACE') < server.indexOf("'<span class=\"tag warn\">NEEDS AUTH</span>'"));
});
