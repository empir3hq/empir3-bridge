import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const start = source.indexOf('function buildMcpSnippet(');
const code = transformSync(source.slice(start, source.indexOf('function clearBridgeAuth(', start)), { loader: 'ts' }).code;
function snippet(exe, files = []) {
  const context = vm.createContext({ resolveBootstrapExe: () => exe, __dirname: '/fixture', join: path.posix.join,
    existsSync: file => files.includes(file), PORT: 3306, process: { execPath: '/runtime/node', env: { EMPIR3_BRIDGE_CONFIG_DIR: '/fixture/config' } },
  });
  vm.runInContext(code, context); return context.buildMcpSnippet().mcpServers['empir3-bridge'];
}
test('desktop MCP config uses the resolved product, with the intended endpoint', () => {
  const s = snippet('/installed/Empir3'); assert.equal(s.command, '/installed/Empir3'); assert.deepEqual(Array.from(s.args), ['--mcp']);
  assert.equal(s.env.BRIDGE_URL, 'http://127.0.0.1:3306');
});
test('source and npm installs advertise a real script rather than an imaginary Windows installer', () => {
  const s = snippet(null, ['/fixture/mcp-entry.js']); assert.equal(s.command, '/runtime/node');
  assert.deepEqual(Array.from(s.args), ['/fixture/mcp-entry.js']); assert.equal(s.env.EMPIR3_BRIDGE_CONFIG_DIR, '/fixture/config');
});
test('bundled headless MCP config selects its shipped bundle', () => {
  assert.deepEqual(Array.from(snippet(null, ['/fixture/bundle-mcp-server.js']).args), ['/fixture/bundle-mcp-server.js']);
});
test('an installation without either entry point reports repair instead of fake readiness', () => {
  assert.throws(() => snippet(null), /Reinstall the Bridge/);
});
