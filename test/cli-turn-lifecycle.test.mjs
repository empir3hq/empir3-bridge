import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import lifecycleModule from '../src/cli-turn-lifecycle.ts';
import journalModule from '../src/cli-turn-journal.ts';

const { CliTurnLifecycle } = lifecycleModule;
const { CliTurnJournal, cliTurnHash } = journalModule;
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const names = ['spawnCli', 'startCliTurnWithProviderCapacity', 'startClaudeCliTurn', 'abortClaudeCliTurn',
  'startCodexCliTurn', 'abortCodexCliTurn', 'startPlainCliTurn', 'abortPlainCliTurn', 'startPtyCliTurn', 'abortPtyCliTurn'];
const bodies = names.map(name => {
  const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `actual ${name} implementation must exist`);
  return node.getText(parsed);
});
const compiled = ts.transpileModule(bodies.join('\n') + `\nglobalThis.api={${names.join(',')}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Child extends EventEmitter {
  constructor() {
    super(); this.stdout = new BoundEmitter(); this.stderr = new BoundEmitter();
    this.stdin = { on() {}, write() {}, end() {} };
  }
  on(name, fn) { return super.on(name, AsyncResource.bind(fn)); }
}
class BoundEmitter extends EventEmitter {
  on(name, fn) { return super.on(name, AsyncResource.bind(fn)); }
}

function fixture({ pause = '', attached = true, journal, supervise, onSpawn = () => {} } = {}) {
  const lifecycle = new CliTurnLifecycle(journal ? () => ({ store: journal, binding: cliTurnHash('fixture-binding') }) : undefined, supervise), entered = gate(), resume = gate();
  const events = [], children = [], timers = []; let releases = 0, cleanups = 0;
  const shim = { url: 'http://fixture.invalid/mcp', tools: [{ name: 'Read' }], attach: { listed: attached } };
  const pauseHere = async where => { if (pause === where) { entered.resolve(); await resume.promise; } };
  const spawn = () => { onSpawn(); const child = new Child(); children.push(child); return child; };
  const pty = { spawn: () => { const child = spawn(); child.onData = fn => { child.stdout.on('data', fn); return { dispose() {} }; };
    child.onExit = fn => { child.on('exit', fn); return { dispose() {} }; }; return child; } };
  const fakeFs = { mkdtemp: async () => '/fixture/turn', rm: async () => { cleanups++; }, rmSync: () => { cleanups++; }, writeFile: async () => {} };
  const sandbox = {
    cliTurnLifecycle: lifecycle, process: { platform: 'linux', env: {}, cwd: () => '/fixture' }, console: { log() {}, warn() {} },
    setTimeout: (fn, ms) => { const timer = { fn: AsyncResource.bind(fn), ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
    require: id => { if (id === 'fs/promises' || id === 'fs') return fakeFs; if (id === 'os') return { tmpdir: () => '/fixture' }; if (id === 'node-pty') return pty; throw Error('Unexpected import: ' + id); },
    join, basename, Buffer, spawn, normalizeCliShim: x => x, registerOwnedCliProcess: x => x, unregisterOwnedCliProcess() {},
    acquireProviderLeaseWithRefreshPatience: async () => { await pauseHere('lease'); return { release() { releases++; } }; },
    providerConcurrencyBusyResult: () => ({ success: false }),
    activeClaudeCliRuns: new Map(), activeCodexCliRuns: new Map(), abortedCliTurns: new Set(), cliPendingToolCalls: new Map(),
    claudeDeviceOptedIn: () => true, codexDeviceOptedIn: () => true, findPreferredExecutable: async () => '/fixture/cli',
    buildClaudeCliStdin: async () => ({ stdin: 'private prompt', imageTempDir: null }),
    startClaudeCliMcpShim: async () => { await pauseHere('shim'); return shim; },
    startCliMcpShim: async () => { await pauseHere('shim'); return shim; },
    teardownClaudeCliMcpShim() { cleanups++; }, teardownCliMcpShim() { cleanups++; },
    writeFileSync() {}, claudeCliEnv: () => ({}), codexCliEnv: () => ({}),
    CLAUDE_CLI_DISALLOWED_BUILTINS: [], MCP_TOOL_CALL_TIMEOUT_MS: 10000,
    materializeTurnImages: async () => ({ refs: [], absPaths: [], tempDir: null }),
    buildCodexBridgePrompt: () => 'private prompt', buildPlainCliPrompt: () => 'private prompt', cliTomlStringValue: x => x,
    appendPtyPromptArg: async () => ({ cleanup: async () => {} }), buildPtySpawnShape: (file, args) => ({ file, args }),
    CLI_ATTACH_HOLD_MAX_MS: 10000, CLI_ATTACH_HOLD_MAX_BYTES: 10000, CLI_MAX_ATTACH_ATTEMPTS: 2,
    terminateCliProcessTree: async () => ({ ok: true }), killPtyProcess() {}, stripAnsiForBridge: x => x,
    classifyGrokAuthFailure: () => null, markGrokAuthVerified() {},
  };
  vm.runInNewContext(compiled, sandbox);
  const spec = prefix => ({ wirePrefix: prefix, cliName: prefix, optedInCheck: () => true, baseArgs: [], activeRunMap: new Map(),
    mcpSetup: async () => ({ extraArgs: [], cleanup: async () => { cleanups++; } }), verifyMcpAttach: true });
  const specs = Object.fromEntries(['gemini', 'grok', 'agy'].map(p => [p, spec(p)]));
  const emit = (type, payload) => events.push({ type, payload });
  const start = prefix => (payload, output) => prefix === 'claude' ? sandbox.api.startClaudeCliTurn(payload, output)
    : prefix === 'codex' ? sandbox.api.startCodexCliTurn(payload, output)
    : prefix === 'agy' ? sandbox.api.startPtyCliTurn(payload, output, specs[prefix])
    : sandbox.api.startPlainCliTurn(payload, output, specs[prefix]);
  const abort = (prefix, id) => prefix === 'claude' ? sandbox.api.abortClaudeCliTurn({ id }, emit)
    : prefix === 'codex' ? sandbox.api.abortCodexCliTurn({ id }, emit)
    : prefix === 'agy' ? sandbox.api.abortPtyCliTurn({ id }, emit, specs[prefix])
    : sandbox.api.abortPlainCliTurn({ id }, emit, specs[prefix]);
  const run = (prefix, id = prefix + '-fixture') => sandbox.api.startCliTurnWithProviderCapacity(prefix, prefix,
    { id, messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'Read' }] }, emit, start(prefix));
  return { lifecycle, entered, resume, run, abort, events, children, timers, api: sandbox.api,
    releases: () => releases, cleanups: () => cleanups };
}

for (const prefix of ['claude', 'codex', 'gemini', 'grok', 'agy']) {
  for (const pause of ['lease', 'shim']) test(`${prefix}: Stop during ${pause} prevents the actual runner from spawning`, async () => {
    const f = fixture({ pause }), pending = f.run(prefix).catch(error => ({ success: false, error: error.message }));
    await Promise.race([f.entered.promise, pending.then(result => { throw Error('Runner did not reach wait: ' + JSON.stringify(result)); })]);
    f.abort(prefix, prefix + '-fixture');
    // There is no five-minute expiry capable of renewing this permission.
    assert.equal(f.timers.length, 0);
    f.resume.resolve();
    const result = await pending;
    assert.equal(result.success, false); assert.match(result.error, /cancelled before process start/);
    assert.equal(f.children.length, 0); assert.equal(f.releases(), 1);
    if (pause === 'shim') assert.ok(f.cleanups() > 0, 'prepared resources cleaned');
  });

  test(`${prefix}: authorized actual runner starts and releases once on completion`, async () => {
    const f = fixture(), result = await f.run(prefix);
    assert.equal(result.success, true); assert.equal(f.children.length, 1); assert.equal(f.releases(), 0);
    const child = f.children[0];
    if (prefix === 'agy') child.emit('exit', { exitCode: 0 }); else child.emit('close', 0);
    for (let i = 0; i < 20 && !f.releases(); i++) await new Promise(setImmediate);
    assert.equal(f.releases(), 1); assert.equal(f.events.filter(e => e.type === prefix + ':cli:done').length, 1);
  });
}

for (const prefix of ['claude', 'codex', 'gemini', 'grok', 'agy']) test(`${prefix}: actual runner commits native journal before spawn and refuses replay after reopen`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'empir3-runner-journal-')), file = join(dir, 'turns.sqlite');
  const journal = new CliTurnJournal(file), reader = new DatabaseSync(file);
  let reopened;
  t.after(() => {
    for (const db of [journal, reader, reopened]) try { db?.close(); } catch {}
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); rmdirSync(dir);
  });
  const saved = () => reader.prepare('SELECT phase,outcome FROM cli_turns WHERE provider=? AND id=?').get(prefix, prefix + '-fixture');
  let witnessedIssue = false;
  const controls = [];
  const f = fixture({ pause: 'lease', journal, supervise: (command, args, options, receipt) => {
    assert.equal(saved().phase, 'issued'); assert.equal(receipt.provider, prefix);
    const control = { command, args, attached: false, cancelled: false,
      attach() { this.attached = true; }, cancel() { this.cancelled = true; }, discardLaunch() { this.cancel(); }, async waitForStop() {} };
    controls.push(control); return control;
  }, onSpawn: () => {
    assert.equal(saved().phase, 'issued', 'independent connection sees issued before child creation'); witnessedIssue = true;
  } });
  const pending = f.run(prefix);
  await Promise.race([f.entered.promise, pending.then(() => { throw Error('runner did not wait for lease'); })]);
  assert.equal(saved().phase, 'preparing'); assert.equal(f.children.length, 0);
  f.resume.resolve(); assert.equal((await pending).success, true); assert.equal(witnessedIssue, true);
  if (prefix === 'agy') f.children[0].emit('exit', { exitCode: 0 }); else f.children[0].emit('close', 0);
  for (let i = 0; i < 20 && !f.releases(); i++) await new Promise(setImmediate);
  assert.equal(f.releases(), 1); assert.equal(saved().phase, 'uncertain'); assert.equal(saved().outcome, 'done');
  assert.equal(controls.length, 1, 'every provider runner crosses the containment factory');
  assert.equal(controls[0].attached, true); assert.equal(controls[0].cancelled, true);
  journal.close(); reopened = new CliTurnJournal(file);
  const replacement = fixture({ journal: reopened });
  await assert.rejects(replacement.run(prefix), /already admitted/);
  assert.equal(replacement.children.length, 0);
});

for (const prefix of ['claude', 'codex']) test(`${prefix}: cancellation cannot become an MCP attachment retry`, async () => {
  const f = fixture({ attached: false }); assert.equal((await f.run(prefix)).success, true);
  f.abort(prefix, prefix + '-fixture');
  if (prefix === 'claude') f.children[0].stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'empir3', status: 'failed' }] }) + '\n'));
  else f.children[0].emit('close', 0);
  for (let i = 0; i < 20 && !f.releases(); i++) await new Promise(setImmediate);
  assert.equal(f.children.length, 1); assert.equal(f.releases(), 1);
  assert.ok(f.events.some(e => /cancelled before process start/.test(e.payload.error || '')));
});

test('duplicate preparing identity refuses without replacing its cancellation scope', async () => {
  const f = fixture({ pause: 'lease' }), first = f.run('codex').catch(error => error);
  await f.entered.promise;
  await assert.rejects(f.run('codex'), /already active/);
  f.abort('codex', 'codex-fixture'); f.resume.resolve();
  assert.match((await first).message, /cancelled/); assert.equal(f.children.length, 0); assert.equal(f.releases(), 1);
});

test('actual wrapper refuses a success event when the durable completion write fails', async () => {
  const journal = { prepare: () => ({}), issue() {}, finish() { throw Error('disk unavailable'); } };
  const f = fixture({ journal }); assert.equal((await f.run('codex')).success, true);
  f.children[0].emit('close', 0);
  assert.equal(f.events.some(e => e.type === 'codex:cli:done'), false);
  assert.equal(f.events.at(-1).payload.stage, 'receipt'); assert.equal(f.releases(), 1);
});

test('late callbacks keep their original closed scope even if the wire ID is reused', async () => {
  const lifecycle = new CliTurnLifecycle(), first = lifecycle.begin('codex', 'same'), resume = gate();
  const late = first.run(async () => { await resume.promise; lifecycle.assertCanSpawn(); });
  first.close(); const second = lifecycle.begin('codex', 'same');
  second.run(() => lifecycle.assertCanSpawn()); resume.resolve();
  await assert.rejects(late, /already settled/); second.close();
});

test('cancellation is scoped to one provider and original turn; local utilities stay separate', () => {
  const lifecycle = new CliTurnLifecycle(), a = lifecycle.begin('codex', 'same'), b = lifecycle.begin('claude', 'same');
  assert.equal(lifecycle.cancel('codex', 'same'), true);
  assert.throws(() => a.run(() => lifecycle.assertCanSpawn()), /cancelled/);
  b.run(() => lifecycle.assertCanSpawn()); lifecycle.assertCanSpawn();
  assert.equal(lifecycle.cancel('grok', 'unknown'), false); a.close(); b.close();
});

test('actual relay handler honors Stop after Execute is revoked while refusing new work and tool results', () => {
  const handler = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleEmpir3Message');
  assert.ok(handler);
  const js = ts.transpileModule(handler.getText(parsed) + '\nglobalThis.receive=handleEmpir3Message;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const dispatched = [], denied = [];
  const context = { READ_ONLY_CLI_ACTIONS: new Set(['probe']), hasEmpir3Permission: () => false,
    readBridgeSettings: () => ({ deviceId: 'original-device' }), empir3PermissionDenied: () => ({ error: 'Execute revoked' }),
    sendEmpir3: (type, payload) => denied.push({ type, payload }) };
  for (const name of ['Claude', 'Codex', 'Gemini', 'Grok', 'Agy']) context['handle' + name + 'CliCommand'] = async (action, payload) => dispatched.push({ name, action, id: payload.id });
  vm.runInNewContext(js, context);
  for (const prefix of ['claude', 'codex', 'gemini', 'grok', 'agy']) {
    const before = dispatched.length;
    context.receive({ type: prefix + ':cli:abort', _targetDeviceId: 'other-device', payload: { id: 'original' } });
    assert.equal(dispatched.length, before, 'other device cannot be stopped');
    context.receive({ type: prefix + ':cli:abort', _targetDeviceId: 'original-device', payload: { id: 'original' } });
    assert.equal(dispatched.length, before + 1); assert.equal(dispatched.at(-1).action, 'abort');
    for (const action of ['turn', 'tool:result']) {
      context.receive({ type: prefix + ':cli:' + action, payload: { id: 'original' } });
      assert.equal(dispatched.length, before + 1); assert.equal(denied.at(-1).payload.error, 'Execute revoked');
    }
  }
});

test('production lifecycle factory retains enrollment and checks owner permission after setup', () => {
  const declaration = parsed.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [])
    .find(n => ts.isIdentifier(n.name) && n.name.text === 'cliTurnLifecycle');
  assert.ok(declaration);
  const enrollment = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'cliJournalEnrollment');
  assert.ok(enrollment);
  const js = ts.transpileModule(enrollment.getText(parsed) + '\nconst ' + declaration.getText(parsed) + ';\nglobalThis.lifecycle=cliTurnLifecycle;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let enabled = true, optedIn = true, account = 'original', stored = 0;
  const journal = { prepare() { stored++; return {}; }, issue() {}, inspect: () => ({ phase: 'issued', cancelled: false }), cancel() {}, finish() {} };
  const sandbox = { process: { platform: 'linux' }, CliTurnLifecycle, CliTurnJournal: class { constructor() { return journal; } }, cliTurnJournal: undefined,
    SETTINGS_DIR: '/fixture', join, cliTurnHash: value => JSON.stringify(value), EMPIR3_AUTH_TOKEN: 'synthetic', EMPIR3_SERVER: 'https://fixture.invalid',
    empir3RestartRequired: false, hasEmpir3Permission: () => enabled, readBridgeAuth: () => ({ user: { id: account } }), readBridgeSettings: () => ({ deviceId: 'device' }) };
  for (const name of ['claude', 'codex', 'gemini', 'grok', 'agy']) sandbox[name + 'DeviceOptedIn'] = () => optedIn;
  vm.runInNewContext(js, sandbox);
  const scope = sandbox.lifecycle.begin('codex', 'owner', {}); let check;
  scope.run(() => { sandbox.lifecycle.assertCanSpawn(); check = sandbox.lifecycle.captureToolAuthority(); });
  check(); enabled = false; assert.throws(check, /owner execution permission/);
  enabled = true; optedIn = false; assert.throws(check, /owner execution permission/);
  optedIn = true; account = 'replacement'; assert.throws(check, /enrollment identity changed/);
  account = 'original'; sandbox.empir3RestartRequired = true; assert.throws(check, /owner execution permission/);
  assert.equal(sandbox.lifecycle.cancel('codex', 'owner'), true); scope.close('error'); assert.equal(stored, 1);
});
