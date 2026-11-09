import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A successful initialize alone does not prove the SDK can serialize every
// registered Zod schema. Exercise the real entrypoint and tools/list without
// attaching to the installed Bridge, opening a browser, or controlling a device.
test('the real MCP process lists every tool with the installed SDK and Zod', { timeout: 20_000 }, async () => {
  const requests = [];
  const service = createServer((req,res) => {
    requests.push(req.url);
    res.writeHead(req.url === '/api/health' ? 200 : 404, {'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,engine:'empir3-bridge'}));
  });
  service.listen(0,'127.0.0.1');
  await once(service,'listening');
  const root = fileURLToPath(new URL('..',import.meta.url));
  const transport = new StdioClientTransport({
    command:process.execPath,
    args:[resolve(root,'node_modules/tsx/dist/cli.mjs'),resolve(root,'src/mcp-server.ts')],
    cwd:root,
    env:{...process.env,BRIDGE_URL:`http://127.0.0.1:${service.address().port}`,EMPIR3_BRIDGE_NONCE:'isolated-test-only'},
    stderr:'pipe',
  });
  let diagnostic = '';
  transport.stderr?.on('data',b=>{diagnostic += b.toString()});
  const client = new Client({name:'schema-compatibility-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const {tools} = await client.listTools();
    assert.ok(tools.length > 50,`Expected the complete tool catalog: ${diagnostic}`);
    for (const tool of tools) assert.equal(tool.inputSchema.type,'object',tool.name);
    for (const name of ['browser_status','browser_click','desktop_click','bridge_safety_status']) {
      assert.ok(tools.some(tool=>tool.name===name),`Missing ${name}`);
    }
    assert.deepEqual(requests,['/api/health']);
    assert.doesNotMatch(diagnostic,/auto-launching|Fatal:/);
  } finally {
    await client.close();
    service.closeAllConnections();
    await new Promise(done=>service.close(done));
  }
});
