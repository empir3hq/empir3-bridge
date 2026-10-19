import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runCapability } from '../src/handlers/capability.ts';
import core from '../src/capability-core.js';

const wav = (length = 44) => {
  const bytes = Buffer.alloc(length); bytes.write('RIFF'); bytes.writeUInt32LE(length - 8, 4); bytes.write('WAVE', 8);
  return bytes;
};
const complete = { id: 'music_abc-123', model: 'acestep-v15', status: 'completed', result: { dit_model: 'dit', lm_model: 'lm', seed: '42', prompt: 'private', lyrics: 'private', metas: {}, generation_info: 'private' } };
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function fixture(t, handler, options = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = req.method === 'POST' ? JSON.parse(bytes) : undefined;
    calls.push({ path: req.url, method: req.method, body, bytes: bytes.length, headers: req.headers });
    if (req.url === '/v1/models') return json(res, { data: options.models ?? [{ id: 'acestep-v15', capabilities: ['musicgen'] }] });
    if (req.url === '/upload') return json(res, { upload_id: 'uploaded-song' });
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = { slug: 'music-test', name: 'Music', kind: 'music', wire: 'empir3-fleet', models: ['acestep-v15'], apiBaseUrl: base + (options.v1 ? '/v1' : ''), apiKey: 'gateway-test-key' };
  return { calls, provider, grant: { upload_url: base + '/upload', upload_token: 'upload-test-key', max_bytes: 128 * 1024 * 1024, device_id: 'test-device' },
    run: (input = {}, extra = {}) => runCapability({ provider, kind: 'music', input: { prompt: 'Quiet piano', duration: 20, ...input }, ...extra }) };
}
function completedHandler(req, res) {
  if (req.url.endsWith('/content')) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav()); }
  else json(res, complete);
}

test('music is a closed provider kind with only the fleet wire and musicgen capability', () => {
  assert.equal(core.normalizeProviderKind('MUSIC'), 'music');
  assert.equal(core.validateCapabilityProviderFields({ kind: 'music', wire: 'empir3-fleet' }).ok, true);
  assert.equal(core.validateCapabilityProviderFields({ kind: 'music', wire: 'openai-speech' }).ok, false);
  assert.deepEqual(core.capabilitiesForKind('music'), ['musicgen']);
  assert.equal(core.capabilityProbePath('music', 'empir3-fleet'), '/models');
});

test('one authenticated song submission, two polls, WAV content and only allowlisted metadata', async t => {
  let polls = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url.endsWith('/content')) return completedHandler(req, res);
    json(res, { ...complete, status: req.method === 'POST' || ++polls < 2 ? 'in_progress' : 'completed', url: 'http://untrusted.invalid/song.wav' });
  }, { v1: true });
  const progress = [];
  const input = { lyrics: '[Verse]\nA song', instrumental: false, bpm: 120, quality: 'draft', seed: 42, vocal_language: 'en' };
  const result = await f.run(input, { onProgress: value => progress.push(value) });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.result.bytes, wav());
  assert.equal(result.result.mimeType, 'audio/wav');
  assert.deepEqual(result.result.metadata, { dit_model: 'dit', lm_model: 'lm', seed: '42' });
  assert.deepEqual(f.calls.map(c => c.path), ['/v1/models', '/v1/music', '/v1/music/music_abc-123', '/v1/music/music_abc-123', '/v1/music/music_abc-123/content']);
  assert.deepEqual(f.calls[1].body, { model: 'acestep-v15', prompt: 'Quiet piano', duration: 20, ...input });
  assert.ok(f.calls.every(c => c.headers.authorization === 'Bearer gateway-test-key'));
  assert.ok(f.calls.every(c => c.headers.connection === 'close'), 'music must not reuse a socket across the five-second idle boundary');
  assert.match(progress[0].status, /stopping the wait does not cancel the GPU job/);
  assert.equal(progress.at(-1).percent, 100);
});

test('invalid fields fail before discovery or any GPU job; boundary values are preserved', async t => {
  const f = await fixture(t, completedHandler);
  const invalid = [{ duration: 9 }, { duration: 601 }, { duration: 10.5 }, { duration: '20' }, { duration: null },
    { prompt: '' }, { prompt: 123 }, { prompt: 'x'.repeat(2001) }, { lyrics: '' }, { lyrics: 'x'.repeat(6001) },
    { instrumental: 'true' }, { bpm: 39 }, { bpm: 241 }, { bpm: '120' }, { quality: 'ultra' }, { seed: -1 }, { seed: 1.5 }, { vocal_language: '' }, { vocal_language: {} }, { vocal_language: 'x'.repeat(33) },
    { image_url: 'http://foreign.invalid' }, { model: 'other' }, { model: {} }, { reference_image_base64: 'abc' }];
  for (const input of invalid) assert.equal((await f.run(input)).stage, 'bad_request', JSON.stringify(input));
  assert.equal(f.calls.length, 0);
  for (const input of [{ duration: 10, bpm: 40, quality: 'draft', instrumental: true }, { duration: 600, bpm: 240, quality: 'final', lyrics: 'x'.repeat(6000), prompt: 'x'.repeat(2000), seed: 0 }]) {
    assert.equal((await f.run(input)).success, true);
    for (const [key, value] of Object.entries(input)) assert.equal(f.calls.at(-2).body[key], value);
  }
});

test('a shared gateway cannot substitute an image or video model for music', async t => {
  const f = await fixture(t, completedHandler, { models: [{ id: 'acestep-v15', capabilities: ['videogen'] }] });
  assert.equal((await f.run()).stage, 'bad_request');
  assert.deepEqual(f.calls.map(c => c.path), ['/v1/models']);
});

test('failed jobs, wrong identities, unknown states and HTTP failure never replay POST', async t => {
  let job = complete, status = 200;
  const f = await fixture(t, (_req, res) => json(res, job, status));
  for (const value of [{ ...complete, status: 'failed', error: 'GPU failed' }, { ...complete, id: '../secret' }, { ...complete, model: 'other' }, { ...complete, status: 'queued' }, null]) {
    job = value; const result = await f.run(); assert.equal(result.success, false);
  }
  status = 500; assert.equal((await f.run()).success, false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 6);
  assert.equal(f.calls.some(c => c.path.endsWith('/content')), false);
});

test('identity changes on polling are rejected before content download', async t => {
  const f = await fixture(t, (req, res) => json(res, req.method === 'POST' ? { ...complete, status: 'in_progress' } : { ...complete, model: 'other' }));
  assert.match((await f.run()).error, /identity changed/);
  assert.equal(f.calls.some(c => c.path.endsWith('/content')), false);
});

test('WAV requires both MIME and RIFF/WAVE magic; declared and streamed size limits are enforced', async t => {
  let mode = 'mime';
  const f = await fixture(t, (req, res) => {
    if (!req.url.endsWith('/content')) return json(res, complete);
    const headers = { 'Content-Type': mode === 'mime' ? 'text/html' : 'audio/wav' };
    if (mode === 'declared') headers['Content-Length'] = String(128 * 1024 * 1024 + 1);
    res.writeHead(200, headers);
    res.end(mode === 'magic' ? Buffer.alloc(44) : wav());
  });
  assert.match((await f.run()).error, /non-WAV/);
  mode = 'magic'; assert.match((await f.run()).error, /invalid WAV/);
  mode = 'declared'; assert.match((await f.run({}, { upload: f.grant })).error, /maximum/);
  mode = 'streamed'; assert.match((await f.run({}, { upload: { ...f.grant, max_bytes: 20 } })).error, /exceeds|maximum/);
  assert.equal(f.calls.some(c => c.path === '/upload'), false);
});

test('60- and 600-second WAVs use the upload grant, preserve metadata and stay off the inline relay', async t => {
  let bytes;
  const f = await fixture(t, (req, res) => {
    if (!req.url.endsWith('/content')) return json(res, complete);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.length) }); res.end(bytes);
  });
  for (const duration of [60, 600]) {
    bytes = wav(duration * 48000 * 2 * 2 + 44);
    const result = await f.run({ duration }, { upload: f.grant });
    assert.equal(result.success, true, result.error);
    assert.equal(result.result.tier, 'upload'); assert.equal(result.result.uploadId, 'uploaded-song'); assert.equal(result.result.bytes, undefined);
    assert.equal(result.result.metadata.seed, '42');
    const upload = f.calls.at(-1); assert.equal(upload.bytes, bytes.length); assert.equal(upload.headers.authorization, 'Bearer upload-test-key');
    assert.equal(upload.headers['content-type'], 'audio/wav');
  }
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('caller deadlines and cancellation stop waiting without resubmitting or cancelling GPU work', async t => {
  const f = await fixture(t, (_req, res) => json(res, { ...complete, status: 'in_progress' }));
  assert.equal((await f.run({}, { timeoutMs: 80 })).stage, 'aborted');
  const controller = new AbortController();
  const result = await f.run({}, { signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(result.stage, 'aborted');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
  assert.equal(f.calls.some(c => c.method === 'DELETE' || c.path.includes('/content')), false);
  const before = f.calls.length; assert.equal((await f.run({}, { signal: controller.signal })).stage, 'aborted'); assert.equal(f.calls.length, before);
});
