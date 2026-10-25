import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const start = source.indexOf("  var mcpText = '';");
const code = source.slice(start, source.indexOf('// ────── Daemon pane', start));
function harness() {
  const nodes = new Map(); let copied, reply, calls = 0;
  const get = id => { if (!nodes.has(id)) nodes.set(id, { textContent: 'Placeholder', disabled: id === 'mcpCopyConfig', addEventListener(type, fn) { this[type] = fn; } }); return nodes.get(id); };
  vm.runInNewContext(code, { $: get, postJson: () => { calls++; return new Promise(resolve => { reply = resolve; }); },
    escapeHtml: x => x, setStatus: (id, text) => { get(id).textContent = text; }, navigator: { clipboard: { writeText: async value => { copied = value; } } },
  });
  return { get, copied: () => copied, reply: value => reply(value), calls: () => calls };
}
test('copy cannot claim success with placeholder text', async () => {
  const h = harness(); await h.get('mcpCopyConfig').click(); assert.equal(h.copied(), undefined);
  assert.match(h.get('mcpStatus').textContent, /Show config/);
});
test('config generation is single-flight and copying requires a valid server entry', async () => {
  const h = harness(); const pending = h.get('mcpShowConfig').click();
  await h.get('mcpShowConfig').click(); assert.equal(h.calls(), 1);
  h.reply({ snippet: { mcpServers: { bridge: { command: 'fixture', args: ['--mcp'] } } } }); await pending;
  assert.equal(h.get('mcpCopyConfig').disabled, false); await h.get('mcpCopyConfig').click();
  assert.equal(JSON.parse(h.copied()).mcpServers.bridge.command, 'fixture');
});
test('malformed config stays uncopyable and can be retried', async () => {
  const h = harness(); const pending = h.get('mcpShowConfig').click(); h.reply({ snippet: {} }); await pending;
  assert.equal(h.get('mcpCopyConfig').disabled, true); assert.equal(h.get('mcpShowConfig').disabled, false);
  assert.match(h.get('mcpStatus').textContent, /Could not generate config/);
});
