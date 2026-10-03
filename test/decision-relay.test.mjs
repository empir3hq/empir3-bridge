import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DecisionRelay, DECISION_RELAY_TIMEOUT_MS } from '../src/decision-relay.ts';
import { defaultEnabledTools, TOOL_FAMILY } from '../src/tool-defaults.ts';
import { createEmpir3Decider, resolveDecisionConfig, runBrowserAct } from '../src/browser-act.ts';

const body = { state: 'Goal: open Talk', questions: { target: { type: 'choice', criteria: { e1: 'Talk', none: 'None' } } } };
const answer = { success: true, answers: { target: { type: 'choice', choice: 'e1', confidence: 0.99, probabilities: { e1: 0.99 } } }, engine: { provider: 'fixture', model: 'jev-fixture' }, backupUsed: true };
function fixture(t, { open = true, timeoutMs = 1000, sendOk = true } = {}) {
  const sent = [], logged = [];
  const relay = new DecisionRelay((type, payload) => { sent.push({ type, payload }); return sendOk; }, () => open, timeoutMs, message => logged.push(message));
  t.after(() => relay.close());
  return { relay, sent, logged };
}

test('relay matches concurrent replies by fresh requestId and drops foreign/duplicate replies', async t => {
  const { relay, sent } = fixture(t);
  const a = relay.request(body), b = relay.request(body);
  assert.equal(DECISION_RELAY_TIMEOUT_MS, 35_000);
  assert.notEqual(sent[0].payload.requestId, sent[1].payload.requestId);
  assert.match(sent[0].payload.requestId, /^act-/);
  assert.equal(sent[0].type, 'decision:request');
  assert.equal(sent[0].payload.purpose, 'browser_act');
  assert.equal(relay.result({ requestId: 'foreign', ...answer }), false);
  relay.result({ requestId: sent[1].payload.requestId, ...answer });
  relay.result({ requestId: sent[0].payload.requestId, success: false, code: 'DISABLED', error: 'Decisions are disabled.' });
  assert.equal((await a).code, 'DISABLED');
  assert.equal((await b).engine.model, 'jev-fixture');
  assert.equal(relay.result({ requestId: sent[1].payload.requestId, ...answer }), false);
});

test('relay times out once and drops the late reply', async t => {
  const { relay, sent } = fixture(t, { timeoutMs: 10 });
  const result = await relay.request(body);
  assert.equal(result.code, 'TIMEOUT');
  assert.match(result.error, /35 seconds/);
  assert.equal(relay.result({ requestId: sent[0].payload.requestId, ...answer }), false);
  assert.equal(sent.length, 1);
});

test('closed socket fails immediately without a pending request or send', async t => {
  const { relay, sent } = fixture(t, { open: false });
  assert.equal((await relay.request(body)).error, 'This Bridge is not connected to Empir3.');
  assert.equal(sent.length, 0);
});

test('socket close settles every pending request and drops old replies', async t => {
  const { relay, sent } = fixture(t);
  const pending = [relay.request(body), relay.request(body)];
  relay.close();
  for (const result of await Promise.all(pending)) assert.equal(result.code, 'NOT_CONNECTED');
  for (const { payload } of sent) assert.equal(relay.result({ requestId: payload.requestId, ...answer }), false);
});

test('a failed send is not queued or retried', async t => {
  const { relay, sent } = fixture(t, { sendOk: false });
  assert.equal((await relay.request(body)).code, 'NOT_CONNECTED');
  assert.equal(sent.length, 1);
});

for (const code of ['INVALID_REQUEST', 'TOO_LARGE']) test(`${code} logs only the request size`, async t => {
  const { relay, sent, logged } = fixture(t);
  const pending = relay.request(body);
  relay.result({ requestId: sent[0].payload.requestId, success: false, code, error: 'Invalid request.' });
  assert.equal((await pending).code, code);
  assert.match(logged[0], /request size \d+ characters/);
  assert.ok(!logged[0].includes('Goal:'));
});

test('selection: explicit local env/settings wins; paired Empir3 needs no key; unpaired stays unconfigured', () => {
  assert.equal(resolveDecisionConfig({ EMPIR3_DECISION_URL: 'http://local' }, {}, true).source, 'env');
  assert.equal(resolveDecisionConfig({}, { decisionModel: { url: 'http://local' } }, true).source, 'settings');
  const paired = resolveDecisionConfig({}, { decisionModel: { minConfidence: 0.75 } }, true);
  assert.equal(paired.source, 'empir3'); assert.equal(paired.minConfidence, 0.75); assert.equal(paired.apiKey, undefined);
  assert.equal(resolveDecisionConfig({}, {}, true).minConfidence, 0.6);
  assert.equal(resolveDecisionConfig({}, {}, false), null);
  assert.equal(resolveDecisionConfig({ EMPIR3_DECISION_URL: 'mistyped local URL' }, {}, true), null);
  assert.equal(resolveDecisionConfig({}, { decisionModel: { url: 'file:///local' } }, true), null);
});

const nodes = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, role: 'link', name: `Link ${i}` }));
const command = async cmd => cmd.type === 'snapshot' ? { nodes } : { success: true };
for (const code of ['NOT_A_BRIDGE', 'DISABLED', 'NO_ENGINE', 'RATE_LIMITED', 'ENGINE_UNAVAILABLE', 'INVALID_REQUEST', 'TOO_LARGE']) {
  test(`${code} reaches browser_act with safe text and no same-call retry`, async () => {
    let calls = 0;
    const decide = createEmpir3Decider(async cmd => {
      calls++; assert.equal(cmd.type, 'decision_relay'); assert.equal(cmd.model, undefined);
      return { success: false, code, error: 'Customer-safe refusal.', ...(code === 'RATE_LIMITED' ? { retryAfterMs: 1234 } : {}) };
    });
    const result = await runBrowserAct({ goal: 'open Talk', dryRun: true }, resolveDecisionConfig({}, {}, true), { command, decide });
    assert.equal(result.success, false); assert.equal(result.acted, false); assert.equal(result.code, code);
    assert.match(result.error, /Customer-safe refusal\./); assert.equal(calls, 1);
    if (code === 'RATE_LIMITED') assert.equal(result.retryAfterMs, 1234);
  });
}

test('act reports the winning engine and backup, and keeps typed text out of the relay', async () => {
  const sent = [];
  const decide = createEmpir3Decider(async cmd => { sent.push(cmd); return answer; });
  const result = await runBrowserAct({ goal: 'the name field', text: 'PRIVATE_TYPED_TEXT', dryRun: true }, resolveDecisionConfig({}, {}, true), {
    command: async cmd => cmd.type === 'snapshot' ? { nodes: [{ ref: 'e1', role: 'textbox', name: 'Name' }] } : { success: true }, decide,
  });
  assert.equal(result.model, 'jev-fixture'); assert.equal(result.backupUsed, true); assert.equal(result.pick.ref, 'e1');
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_TYPED_TEXT'));
});

test('multiple groups report the engine of the winning pick, rather than the last reply', async () => {
  let group = 0;
  const result = await runBrowserAct({ goal: 'open Talk', dryRun: true }, resolveDecisionConfig({}, {}, true), {
    command,
    decide: async () => {
      const first = group++ === 0;
      return { ...answer, answers: { target: { choice: first ? 'e1' : 'none', confidence: 0.99 } },
        engine: { model: first ? 'winning-engine' : 'last-engine' }, backupUsed: first };
    },
  });
  assert.equal(result.model, 'winning-engine'); assert.equal(result.backupUsed, true);
});

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
function policyHarness({ enabled = false, execute = true } = {}) {
  const names = ['COMMAND_TOOL_MAP', 'TOOL_PERMISSION_REQUIREMENTS', 'commandToolName', 'requiredBridgePermission', 'sourceUsesLocalMcpPolicy', 'enforceCommandPolicy', 'enforceHandlerFamilyGate', 'executeCommandCore'];
  const declarations = names.map(name => {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) ? n.name?.text === name : ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree) === name));
    assert.ok(node, name); return node.getText(tree);
  }).join('\n');
  let spent = 0;
  const context = vm.createContext({
    TOOL_FAMILY, loadConfig: () => ({ enabledTools: { ...defaultEnabledTools(), browser_act: enabled } }),
    hasBridgePermission: () => execute, permissionDenied: () => ({ success: false, error: 'Execute denied' }),
    parseRelayStyleDesktopCommand: () => null, readBridgeSettings: () => ({}),
    decisionRelay: { request: async () => { spent++; return answer; } },
  });
  vm.runInContext(ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, spent: () => spent };
}

for (const source of ['mcp', 'http', 'ws:cli', 'relay']) test(`disabled browser_act refuses the actual relay command before spend; source=${source}`, async () => {
  const h = policyHarness();
  const result = await h.context.executeCommandCore({ type: 'decision_relay', ...body }, source);
  assert.equal(result.success, false); assert.match(result.error, /disabled locally: browser_act/); assert.equal(h.spent(), 0);
});
test('global Execute refuses relay even when browser_act is enabled', async () => {
  const h = policyHarness({ enabled: true, execute: false });
  assert.equal((await h.context.executeCommandCore({ type: 'decision_relay', ...body }, 'http')).success, false); assert.equal(h.spent(), 0);
});
test('opted-in relay reaches the actual daemon handler', async () => {
  const h = policyHarness({ enabled: true });
  assert.equal((await h.context.executeCommandCore({ type: 'decision_relay', ...body }, 'http')).success, true); assert.equal(h.spent(), 1);
});
