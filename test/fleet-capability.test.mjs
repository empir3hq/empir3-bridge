import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runCapability } from '../src/handlers/capability.ts';
import core from '../src/capability-core.js';

async function fixture(t, handler, kind = 'video') {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ path: req.url, body, auth: req.headers.authorization });
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const provider = { slug: 'fleet-test', kind, wire: 'empir3-fleet', name: 'Fleet test', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ['model'], apiKey: 'private-test-key' };
  return { calls, run: (input = {}, extra = {}) => runCapability({ provider, kind, input: { prompt: 'A red panda', ...input }, ...extra }) };
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

test('fleet wire is explicit for image/video only', () => {
  for (const kind of ['image', 'video']) assert.equal(core.validateCapabilityProviderFields({ kind, wire: 'empir3-fleet' }).ok, true);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'tts', wire: 'empir3-fleet' }).ok, false);
});
test('fleet submits once, polls the same authenticated job, then downloads MP4', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.endsWith('/content')) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end('mp4'); return; }
    json(res, { id: 'video_abc', model: 'model', status: req.method === 'POST' ? 'in_progress' : 'completed' });
  });
  const result = await f.run();
  assert.equal(result.success, true); assert.equal(result.result.bytes.toString(), 'mp4');
  assert.deepEqual(f.calls.map(c => c.path), ['/v1/videos', '/v1/videos/video_abc', '/v1/videos/video_abc/content']);
  assert.equal(f.calls[0].body.seconds, 5); assert.equal(f.calls[0].body.size, '1024x576');
  assert.ok(f.calls.every(c => c.auth === 'Bearer private-test-key'));
});
test('unsupported video requests fail before creating GPU work', async t => {
  const f = await fixture(t, (_req, res) => json(res, {}));
  for (const input of [{ duration: 6 }, { size: '1280x720' }, { reference_image_base64: 'cGlj' }, { image_url: 'https://example.com/a.png' }, { fps: 30 }, { audio: false }, { quality: 'ultra' }]) {
    const result = await f.run(input); assert.equal(result.success, false); assert.equal(result.stage, 'bad_request');
  }
  assert.equal(f.calls.length, 0);
});
test('failed jobs and invalid identities never retry submission or download arbitrary URLs', async t => {
  let job = { id: 'video_abc', model: 'model', status: 'failed', error: 'GPU failed' };
  const f = await fixture(t, (_req, res) => json(res, job));
  assert.match((await f.run()).error, /GPU failed/);
  job = { id: '../secret', model: 'model', status: 'completed' };
  assert.match((await f.run()).error, /identity/);
  assert.equal(f.calls.length, 2);
});
test('cancellation stops polling, not by retrying or claiming GPU cancellation', async t => {
  const controller = new AbortController();
  const f = await fixture(t, (_req, res) => {
    json(res, { id: 'video_abc', model: 'model', status: 'in_progress' });
    setTimeout(() => controller.abort(), 40);
  });
  const result = await f.run({}, { signal: controller.signal });
  assert.equal(result.stage, 'aborted'); assert.equal(f.calls.length, 1);
});
test('images and reference edits use bounded JSON and inline image bytes', async t => {
  const f = await fixture(t, (_req, res) => json(res, { data: [{ b64_json: Buffer.from('png').toString('base64'), mime_type: 'image/png' }] }), 'image');
  assert.equal((await f.run({ aspect_ratio: '16:9' })).success, true);
  assert.equal(f.calls[0].body.size, undefined); assert.equal(f.calls[0].body.aspect_ratio, '16:9');
  assert.equal((await f.run({ reference_image_base64: 'cGlj', reference_mime_type: 'image/png' })).success, true);
  assert.equal(f.calls[1].path, '/v1/images/edits'); assert.deepEqual(f.calls[1].body.images, ['data:image/png;base64,cGlj']);
  assert.equal((await f.run({ image_url: 'http://other/a.png' })).stage, 'bad_request');
  assert.equal(f.calls.length, 2);
});
test('fleet image transport does not follow redirects', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/secret' }); res.end(); }, 'image');
  assert.equal((await f.run()).success, false); assert.equal(f.calls.length, 1);
});

for (const status of [204, 205, 304]) {
  test(`fleet image empty HTTP ${status} fails without crashing the daemon`, async t => {
    const f = await fixture(t, (_req, res) => { res.writeHead(status); res.end(); }, 'image');
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(f.calls.length, 1);
  });
}

test('fleet video respects an explicit caller deadline shorter than ten seconds', async t => {
  const f = await fixture(t, (_req, res) => json(res, { id: 'video_abc', model: 'model', status: 'in_progress' }));
  const started = Date.now();
  const result = await f.run({}, { timeoutMs: 80 });
  assert.equal(result.stage, 'aborted');
  assert.ok(Date.now() - started < 1500, 'the caller deadline must not be extended');
  assert.equal(f.calls.length, 1);
});
