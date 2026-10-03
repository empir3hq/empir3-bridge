import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHUNK,
  DEFAULT_MIN_CONFIDENCE,
  actionableNodes,
  buildRequest,
  chunk,
  createHttpDecider,
  isIrreversibleLabel,
  operationFor,
  parseAnswer,
  resolveDecisionConfig,
  runBrowserAct,
  snapshotNodes,
} from '../src/browser-act.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CONFIG = { url: 'http://decider.test', model: 'nimble-latest', minConfidence: 0.6, timeoutMs: 2000, source: 'env' };

const FORM = [
  { ref: 'e1_0', role: 'textbox', name: 'Customer name:' },
  { ref: 'e1_1', role: 'textbox', name: 'Telephone:' },
  { ref: 'e1_2', role: 'radio', name: 'Large' },
  { ref: 'e1_3', role: 'checkbox', name: 'Bacon' },
  { ref: 'e1_4', role: 'button', name: 'Submit order' },
  { ref: 'e1_5', role: 'button', name: 'Open account menu' },
];

// A fake daemon that records every command and a fake decision endpoint that
// answers with a scripted choice per call.
function harness({ nodes = FORM, answers = [], status = { title: 'Order form' }, refuse = null, decideError = null } = {}) {
  const sent = [];
  const bodies = [];
  let call = 0;
  const deps = {
    command: async (cmd) => {
      sent.push(cmd);
      if (refuse && cmd.type === refuse.type) throw new Error(refuse.error);
      if (cmd.type === 'act_preflight') return { success: true, ok: true, tool: 'browser_act' };
      if (cmd.type === 'snapshot') return { snapshot: { count: nodes.length, nodes } };
      if (cmd.type === 'status') return status;
      return { success: true, dispatched: true, type: cmd.type };
    },
    decide: async (body) => {
      bodies.push(body);
      if (decideError) throw new Error(decideError);
      const a = typeof answers === 'function' ? answers(body, call) : answers[call];
      call += 1;
      return { answers: { target: a } };
    },
    now: (() => { let t = 1000; return () => (t += 5); })(),
  };
  return { deps, sent, bodies, types: () => sent.map((c) => c.type) };
}

const pickOf = (choice, confidence, probabilities = { [choice]: confidence }) => ({ choice, confidence, probabilities });

test('config: nothing configured means no config at all', () => {
  assert.equal(resolveDecisionConfig({}, {}), null);
  assert.equal(resolveDecisionConfig({ EMPIR3_DECISION_URL: '   ' }, { decisionModel: {} }), null);
});

test('config: env URL with defaults; settings used when env is absent; env wins over settings', () => {
  const env = resolveDecisionConfig({ EMPIR3_DECISION_URL: 'http://spark:8600/' }, {});
  assert.deepEqual(env, { url: 'http://spark:8600', model: 'nimble-latest', minConfidence: DEFAULT_MIN_CONFIDENCE, timeoutMs: 8000, source: 'env' });
  const fromSettings = resolveDecisionConfig({}, { decisionModel: { url: 'https://api.example', apiKey: ' k ', model: 'jev-latest', minConfidence: 0.8 } });
  assert.equal(fromSettings.url, 'https://api.example');
  assert.equal(fromSettings.apiKey, 'k');
  assert.equal(fromSettings.model, 'jev-latest');
  assert.equal(fromSettings.minConfidence, 0.8);
  assert.equal(fromSettings.source, 'settings');
  const both = resolveDecisionConfig({ EMPIR3_DECISION_URL: 'http://env.test', EMPIR3_DECISION_MODEL: 'm2' }, { decisionModel: { url: 'http://settings.test', model: 'm1' } });
  assert.equal(both.url, 'http://env.test');
  assert.equal(both.model, 'm2');
});

test('config: only http(s) URLs; floor and timeout are clamped', () => {
  assert.equal(resolveDecisionConfig({ EMPIR3_DECISION_URL: 'file:///etc/passwd' }, {}), null);
  assert.equal(resolveDecisionConfig({ EMPIR3_DECISION_URL: 'not a url' }, {}), null);
  const c = resolveDecisionConfig({ EMPIR3_DECISION_URL: 'http://x.test', EMPIR3_DECISION_MIN_CONFIDENCE: '7', EMPIR3_DECISION_TIMEOUT_MS: '5' }, {});
  assert.equal(c.minConfidence, 1);
  assert.equal(c.timeoutMs, 500);
});

test('snapshot parsing accepts the compact object, a bare array and its JSON text', () => {
  assert.equal(snapshotNodes({ nodes: FORM }).length, FORM.length);
  assert.equal(snapshotNodes(FORM).length, FORM.length);
  assert.equal(snapshotNodes(JSON.stringify({ nodes: FORM })).length, FORM.length);
  assert.deepEqual(snapshotNodes('not json'), []);
});

test('only labelled actionable controls are offered, once each; typing narrows to fields', () => {
  const nodes = [...FORM, { ref: 'x1', role: 'div', name: 'wrapper' }, { ref: 'x2', role: 'button', name: '' }, { ref: 'x3', role: 'button', name: 'Large' }, { ref: 'x4', role: 'radio', name: 'large' }];
  const offered = actionableNodes(nodes);
  assert.ok(!offered.some((n) => n.ref === 'x1' || n.ref === 'x2' || n.ref === 'x4'), 'non-actionable, unlabelled and duplicate controls dropped');
  assert.ok(offered.some((n) => n.ref === 'x3'), 'same label, different role is a different control');
  assert.deepEqual(actionableNodes(FORM, { editableOnly: true }).map((n) => n.ref), ['e1_0', 'e1_1']);
});

test('groups stay under the option cap with the none escape', () => {
  assert.equal(CHUNK, 24);
  const groups = chunk(Array.from({ length: 50 }, (_, i) => i));
  assert.deepEqual(groups.map((g) => g.length), [24, 24, 2]);
  const body = buildRequest('open the menu', FORM, 'nimble-latest', 'Order form', false);
  assert.equal(Object.keys(body.questions.target.criteria).length, FORM.length + 1);
  assert.ok('none' in body.questions.target.criteria);
  assert.match(body.state, /Page: Order form\. Goal: open the menu\./);
});

test('irreversible labels are recognised; ordinary ones are not', () => {
  for (const label of ['Submit order', 'Place order', 'Pay now', 'Delete project', 'Send', 'Publish', 'Sign out', 'Log out', 'Checkout', 'Confirm purchase', 'Cancel subscription', 'Post']) {
    assert.ok(isIrreversibleLabel(label), label);
  }
  for (const label of ['Open account menu', 'Large', 'Customer name:', 'Search', 'Next projects', 'Posts', 'Sign in', 'Guided flows', 'Cancel']) {
    assert.ok(!isIrreversibleLabel(label), label);
  }
});

test('the operation comes from the control, not the model', () => {
  assert.equal(operationFor({ ref: 'a', role: 'textbox', name: 'Email' }, 'x@y.z'), 'type');
  assert.equal(operationFor({ ref: 'a', role: 'textbox', name: 'Email' }), 'click');
  assert.equal(operationFor({ ref: 'b', role: 'button', name: 'Go' }, 'x'), 'click');
});

test('answers: confidence falls back to the chosen probability; malformed replies are rejected', () => {
  assert.deepEqual(parseAnswer({ answers: { target: { choice: 'e1', probabilities: { e1: 0.7, none: 0.3 } } } }), { choice: 'e1', confidence: 0.7, probabilities: { e1: 0.7, none: 0.3 } });
  assert.equal(parseAnswer({}), null);
  assert.equal(parseAnswer({ answers: { target: { probabilities: { e1: 1 } } } }), null);
});

test('no decision model: refuses without sending a single command', async () => {
  const h = harness();
  const r = await runBrowserAct({ goal: 'open the account menu' }, null, h.deps);
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'no_decision_model');
  assert.match(r.error, /EMPIR3_DECISION_URL/);
  assert.deepEqual(h.sent, []);
});

test('a refused browser_act switch stops everything before the snapshot', async () => {
  const h = harness({ refuse: { type: 'act_preflight', error: 'MCP tool disabled locally: browser_act' } });
  await assert.rejects(runBrowserAct({ goal: 'open the account menu' }, CONFIG, h.deps), /disabled locally: browser_act/);
  assert.deepEqual(h.types(), ['act_preflight']);
});

test('happy path: the picked control is clicked through click_ref', async () => {
  const h = harness({ answers: [pickOf('e1_5', 0.95)] });
  const r = await runBrowserAct({ goal: 'open the account menu' }, CONFIG, h.deps);
  assert.equal(r.success, true);
  assert.equal(r.acted, true);
  assert.equal(r.operation, 'click');
  assert.equal(r.pick.ref, 'e1_5');
  assert.deepEqual(h.types(), ['act_preflight', 'snapshot', 'status', 'click_ref']);
  assert.equal(h.sent.at(-1).ref, 'e1_5');
});

test('typing: only fields are offered, text goes to type_ref and never to the decision model', async () => {
  const h = harness({ answers: [pickOf('e1_1', 0.99)] });
  const r = await runBrowserAct({ goal: 'the phone number field', text: '555-0142 secret', submit: true }, CONFIG, h.deps);
  assert.equal(r.operation, 'type');
  assert.equal(r.submitted, true);
  assert.deepEqual(Object.keys(h.bodies[0].questions.target.criteria).sort(), ['e1_0', 'e1_1', 'none']);
  assert.ok(!JSON.stringify(h.bodies).includes('555-0142'), 'typed text never leaves for the decision endpoint');
  assert.deepEqual(h.types().slice(-2), ['type_ref', 'press']);
  assert.deepEqual(h.sent.at(-2), { type: 'type_ref', ref: 'e1_1', text: '555-0142 secret' });
  assert.deepEqual(h.sent.at(-1), { type: 'press', text: 'Enter' });
});

test('below the floor: no input, candidates returned', async () => {
  const h = harness({ answers: [pickOf('e1_2', 0.41, { e1_2: 0.41, e1_3: 0.33, none: 0.26 })] });
  const r = await runBrowserAct({ goal: 'choose a large pizza' }, CONFIG, h.deps);
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'low_confidence');
  assert.equal(r.candidates[0].ref, 'e1_2');
  assert.ok(!h.types().includes('click_ref'));
});

test('per-call floor override is honoured', async () => {
  const h = harness({ answers: [pickOf('e1_2', 0.41)] });
  const r = await runBrowserAct({ goal: 'choose a large pizza', minConfidence: 0.4 }, CONFIG, h.deps);
  assert.equal(r.acted, true);
});

test('none: no input, says it may be off-screen', async () => {
  const h = harness({ answers: [pickOf('none', 0.9)] });
  const r = await runBrowserAct({ goal: 'pay with a credit card' }, CONFIG, h.deps);
  assert.equal(r.reason, 'no_match');
  assert.match(r.error, /scroll/);
  assert.ok(!h.types().includes('click_ref'));
});

test('irreversible controls are suggested, never clicked', async () => {
  const h = harness({ answers: [pickOf('e1_4', 0.99)] });
  const r = await runBrowserAct({ goal: 'submit the order' }, CONFIG, h.deps);
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'irreversible');
  assert.equal(r.pick.ref, 'e1_4');
  assert.match(r.error, /browser_click_ref with ref e1_4/);
  assert.ok(!h.types().includes('click_ref'));
});

test('dry run decides without acting', async () => {
  const h = harness({ answers: [pickOf('e1_5', 0.95)] });
  const r = await runBrowserAct({ goal: 'open the account menu', dryRun: true }, CONFIG, h.deps);
  assert.equal(r.success, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.operation, 'click');
  assert.ok(!h.types().includes('click_ref'));
});

test('large pages: every group is asked and the most confident non-none answer wins', async () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ ref: `e9_${i}`, role: 'link', name: `Story ${i}` }));
  const h = harness({ nodes, answers: [pickOf('e9_3', 0.7), pickOf('e9_27', 0.94)] });
  const r = await runBrowserAct({ goal: 'open story 27' }, CONFIG, h.deps);
  assert.equal(h.bodies.length, 2);
  for (const b of h.bodies) assert.ok(Object.keys(b.questions.target.criteria).length <= 25);
  assert.equal(r.groups, 2);
  assert.equal(r.pick.ref, 'e9_27');
  assert.equal(h.sent.at(-1).ref, 'e9_27');
});

test('decision endpoint failure: nothing clicked, clear fallback', async () => {
  const h = harness({ decideError: 'connect ECONNREFUSED' });
  const r = await runBrowserAct({ goal: 'open the account menu' }, CONFIG, h.deps);
  assert.equal(r.reason, 'decision_unavailable');
  assert.match(r.error, /ECONNREFUSED.*browser_click_ref/);
  assert.ok(!h.types().includes('click_ref'));
});

test('an unreadable reply never clicks', async () => {
  const h = harness({ answers: [{ nonsense: true }] });
  const r = await runBrowserAct({ goal: 'open the account menu' }, CONFIG, h.deps);
  assert.equal(r.reason, 'decision_unreadable');
  assert.ok(!h.types().includes('click_ref'));
});

test('the HTTP decider posts to /v1/systemone with the key as a bearer token', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ answers: {} }) }; };
  await createHttpDecider({ ...CONFIG, apiKey: 'sk-test' }, fakeFetch)({ model: 'm' });
  assert.equal(calls[0].url, 'http://decider.test/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  await createHttpDecider(CONFIG, fakeFetch)({ model: 'm' });
  assert.equal(calls[1].init.headers.Authorization, undefined);
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(createHttpDecider(CONFIG, failing)({}), /answered 503/);
});

test('contract: the daemon gates browser_act like click_ref and the MCP layer registers it', () => {
  const server = read('../src/server.ts');
  const defaults = read('../src/tool-defaults.ts');
  const mcp = read('../src/mcp-server.ts');
  assert.match(server, /act_preflight: 'browser_act',/);
  assert.match(server, /browser_act: 'execute',/);
  const policy = server.indexOf('const policyError = enforceCommandPolicy(cmd, source);');
  const gate = server.indexOf("if(cmd.type==='act_preflight')return");
  assert.ok(policy > 0 && gate > policy, 'act_preflight answers only after the command policy has run');
  assert.match(defaults, /\{ name: 'browser_act',\s+group: 'interact', defaultEnabled: false,/);
  assert.match(mcp, /server\.tool\(\s*'browser_act'/);
  assert.match(mcp, /const targetableTools=new Set\(\[[^\]]*'browser_act'/);
  assert.doesNotMatch(read('../src/browser-act.ts'), /\b100\.\d+\.\d+\.\d+\b/, 'no private endpoint is baked into the public source');
});
