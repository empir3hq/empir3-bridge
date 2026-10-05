import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const start = source.indexOf('  function setPairing(active)');
const code = source.slice(start, source.indexOf("  $('signIn').addEventListener", start));
function harness({ legacyWorks = false, clipboardAbsent = false } = {}) {
  const nodes = new Map(); let posts = 0, status = {}, failure, copied, clipboardDenied = false, resolvePost, legacyCalls = 0;
  const node = () => ({ children: [], disabled: false, textContent: '', value: '', attrs: {}, style: {},
    appendChild(n) { this.children.push(n); }, getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this[k] = fn; }, select() { this.selected = true; }, focus() { this.focused = true; } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = vm.createContext({ pairing: false, pairChecking: false, pairDeadline: 0, pairStatusId: 'signInStatus', $: get, document: { createElement: node, execCommand: action => { assert.equal(action, 'copy'); legacyCalls++; return legacyWorks; } },
    setStatus: (id, text, tone) => { const n = get(id); n.textContent = text; n.tone = tone; n.children = []; },
    postJson: () => { posts++; return new Promise(resolve => { resolvePost = resolve; }); },
    getJson: async () => { if (failure) throw Error('offline'); return status; }, loadRelay: async () => {},
    navigator: { clipboard: clipboardAbsent ? undefined : { writeText: async value => { if (clipboardDenied) throw Error('denied'); copied = value; } } },
  });
  vm.runInContext(code, context);
  return { context, get, posts: () => posts, copied: () => copied, legacyCalls: () => legacyCalls, denyClipboard: () => { clipboardDenied = true; },
    resolve: () => resolvePost({ ok: true, redirectUrl: 'https://app.example/connect-bridge?code=FIXTURE' }),
    status: s => { status = s; }, offline: () => { failure = true; } };
}
test('sign-in is single-flight and leaves a reachable, selectable link on the console', async () => {
  const h = harness(); const pending = h.context.startSignIn('signInStatus');
  await h.context.startSignIn('signInStatus'); assert.equal(h.posts(), 1); assert.equal(h.get('signIn').disabled, true);
  h.resolve(); await pending;
  const children = h.get('signInStatus').children[0].children;
  assert.equal(children[0].textContent, 'Continue sign-in'); assert.equal(children[0].target, '_blank');
  assert.equal(children[1].readOnly, true);
  h.denyClipboard(); await children[2].click();
  assert.equal(children[1].selected, true);
  assert.equal(children[1].focused, true);
  assert.equal(h.legacyCalls(), 1);
  assert.match(children[3].textContent, /Could not copy automatically.*Command\+C.*Ctrl\+C/);
});

for (const clipboardAbsent of [false, true]) test(`setup copy falls back to legacy copying; absent API=${clipboardAbsent}`, async () => {
  const h = harness({ legacyWorks: true, clipboardAbsent });
  const pending = h.context.startSignIn('signInStatus'); h.resolve(); await pending;
  const children = h.get('signInStatus').children[0].children;
  h.denyClipboard(); await children[2].click();
  assert.equal(h.legacyCalls(), 1);
  assert.equal(children[2].textContent, 'Copied');
  assert.equal(children[3].textContent, 'Link copied.');
});
for (const lastStatus of ['save_failed', 'expired', 'timed_out', 'invalid_response']) test(`sign-in ${lastStatus} enables a new attempt and displays the saved reason`, async () => {
  const h = harness(); const pending = h.context.startSignIn('signInStatus'); h.resolve(); await pending;
  h.status({ polling: false, lastStatus, lastError: 'Fixture recovery reason' }); await h.context.checkPairing();
  assert.equal(h.get('signIn').disabled, false); assert.equal(h.get('signInStatus').textContent, 'Fixture recovery reason');
});
test('a restart keeps recovery link available, but an unreachable Bridge cannot leave sign-in waiting forever', async () => {
  const h = harness(); const pending = h.context.startSignIn('signInStatus'); h.resolve(); await pending;
  h.offline(); await h.context.checkPairing(); assert.equal(h.get('signInStatus').children.length, 1);
  h.context.pairDeadline = 1; await h.context.checkPairing(); assert.equal(h.get('signIn').disabled, false);
  assert.match(h.get('signInStatus').textContent, /new link/);
});
