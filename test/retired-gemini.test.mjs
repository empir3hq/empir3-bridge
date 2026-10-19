import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const { CLI_INSTALL_CATALOG, CLI_LIFECYCLE_CATALOG } = require('../src/cli-platform.js');
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
function functionSource(name) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}

test('retired Gemini has no install, lifecycle, sign-in, or console row; Antigravity stays', () => {
  assert.equal(CLI_INSTALL_CATALOG.gemini, undefined);
  assert.equal(CLI_LIFECYCLE_CATALOG.gemini, undefined);
  assert.ok(CLI_INSTALL_CATALOG.agy);
  assert.ok(CLI_LIFECYCLE_CATALOG.agy);
  assert.doesNotMatch(functionSource('authLaunchSpec'), /case 'gemini'/);
  assert.match(functionSource('authLaunchSpec'), /case 'agy'/);
  const rowStart = source.indexOf('var CLI_ROWS =');
  assert.ok(rowStart >= 0);
  const rows = source.slice(rowStart, source.indexOf('];', rowStart));
  assert.ok(rows.length > 0);
  assert.doesNotMatch(rows, /id:\s*'gemini'/);
  assert.match(rows, /id:\s*'agy'/);
  // Old permission receipts and Google's API/Antigravity auth remain compatible.
  assert.match(source, /type.startsWith\('gemini:cli:'\)/);
  assert.match(source, /gemini:antigravity/);
  assert.match(source, /function geminiProviderMessages/);
});

test('discovery and restart/update indexing agree after removing Gemini', async () => {
  const expected = ['claude', 'codex', 'grok', 'agy', 'higgsfield', 'github'];
  const called = [];
  const c = vm.createContext({ Date, Promise, _cliProbeCache: null, _cliProbeInFlight: null, CLI_PROBE_TTL_MS: 30000,
    githubDeviceOptedIn: () => false, githubScopes: () => [],
    probeGeminiCli: () => assert.fail('retired CLI must not be probed'),
  });
  for (const id of expected) c[`probe${id[0].toUpperCase()}${id.slice(1)}Cli`] = async () => { called.push(id); return { id }; };
  vm.runInContext(transformSync(functionSource('probeAllClis'), { loader: 'ts', format: 'cjs' }).code, c);
  const rows = await c.probeAllClis();
  assert.deepEqual(called, expected);
  assert.deepEqual(Array.from(rows, r => r.id), expected);
  const ids = source.match(/const CLI_RESTART_IDS = (\[[^;]+\]);/);
  assert.deepEqual(JSON.parse(ids[1].replaceAll("'", '"')), expected);
  assert.doesNotMatch(functionSource('buildSettingsState'), /\bgemini\b/);
  assert.doesNotMatch(functionSource('checkCliLatestVersions'), /'gemini'/);
});
