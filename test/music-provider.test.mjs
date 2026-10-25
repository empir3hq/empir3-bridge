import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import core from '../src/capability-core.js';

const source = ts.createSourceFile('server.ts', readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function load(names, bindings = {}) {
  const declarations = names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(source));
  assert.ok(declarations.every(Boolean));
  const context = vm.createContext({ setTimeout, clearTimeout, AbortController, Buffer, ...core, ...bindings });
  vm.runInContext(ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
const provider = { slug: 'music-local', name: 'Local music', kind: 'music', wire: 'empir3-fleet', apiBaseUrl: 'http://gateway.test:8890', apiKey: 'private-test-key', lend: true };
const catalog = { data: [{ id: 'image-model', capabilities: ['imagegen'] }, { id: 'acestep-v15', capabilities: ['musicgen'] }, { id: 'uncategorized' }] };
const probeNames = ['probeCustomProviderUncached', 'readProviderJson', 'readProviderResponseText'];
function probeContext(fetch) {
  return load(probeNames, { fetch, PROVIDER_PROBE_TIMEOUT_MS: 40, CUSTOM_PROVIDER_MAX_PROBE_BYTES: 2_000_000, CUSTOM_PROVIDER_MAX_MODELS: 250 });
}

test('Music Test discovers only musicgen models at the root or v1 base with local auth', async () => {
  const urls = [];
  const context = probeContext(async (url, init) => {
    urls.push(url); assert.equal(init.headers.Authorization, 'Bearer private-test-key'); assert.equal(init.redirect, 'error');
    return Response.json(catalog);
  });
  for (const apiBaseUrl of [provider.apiBaseUrl, provider.apiBaseUrl + '/v1/']) {
    const result = await context.probeCustomProviderUncached({ ...provider, apiBaseUrl });
    assert.equal(result.available, true); assert.deepEqual(plain(result.models), ['acestep-v15']);
  }
  assert.deepEqual(urls, ['http://gateway.test:8890/v1/models', 'http://gateway.test:8890/v1/models']);
  const invalid = await context.probeCustomProviderUncached({ ...provider, models: ['image-model'] });
  assert.equal(invalid.available, false); assert.deepEqual(plain(invalid.models), []);
});

test('missing catalog and stalled response body never advertise Music online', async () => {
  let calls = 0;
  let context = probeContext(async () => { calls++; return new Response('', { status: 404 }); });
  assert.equal((await context.probeCustomProviderUncached(provider)).available, false); assert.equal(calls, 1);
  context = probeContext(async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
  } })));
  assert.equal((await context.probeCustomProviderUncached(provider)).available, false);
  context = probeContext(async () => Response.json({ data: [] }));
  assert.equal((await context.probeCustomProviderUncached(provider)).available, false);
});

test('advertisement contains the discovered music allowlist and no local URL, key or foreign models', async () => {
  const context = load(['buildLentCustomProvidersState'], {
    readCustomProviders: () => [{ ...provider, models: ['acestep-v15', 'image-model'] }], readConfiguredApiProviders: () => [],
    probeCustomProvider: async () => ({ available: true, models: ['acestep-v15'] }),
    CUSTOM_PROVIDER_MAX_ENTRIES: 25, CUSTOM_PROVIDER_MAX_MODELS: 250,
    customProviderConcurrencyKey: p => `custom:${p.slug}`, providerConcurrencySnapshot: () => ({ limit: 1 }),
  });
  const [advert] = plain(await context.buildLentCustomProvidersState());
  assert.equal(advert.kind, 'music'); assert.equal(advert.wire, 'empir3-fleet'); assert.equal(advert.available, true);
  assert.deepEqual(advert.capabilities, ['musicgen']); assert.deepEqual(advert.models, ['acestep-v15']);
  assert.equal(advert.apiKey, undefined); assert.equal(advert.apiBaseUrl, undefined);
});

test('music admission defaults to one and other custom providers retain their capacity', () => {
  const context = load(['providerConcurrencyDefault'], { process, readCustomProviders: () => [provider] });
  assert.equal(context.providerConcurrencyDefault('custom:music-local'), 1);
  assert.equal(context.providerConcurrencyDefault('custom:other'), 4);
});

test('the dispatcher accepts Music, forwards upload/deadline and returns metadata with one released lease', async () => {
  let releases = 0, dispatched = 0;
  const events = [];
  const activeCapabilityRuns = new Map();
  const context = load(['handleCapabilityCommand'], {
    loadConfig: () => ({ enabledTools: { custom_capability: true } }), readCustomProviders: () => [provider], activeCapabilityRuns,
    providerConcurrencyLimit: () => 1, providerConcurrencyGate: { tryAcquire: () => ({ release: () => releases++ }) },
    runCapability: async params => {
      dispatched++; assert.equal(params.kind, 'music'); assert.equal(params.timeoutMs, 1234); assert.equal(params.upload.max_bytes, 128 * 1024 * 1024);
      params.onProgress({ status: 'generating song' });
      return { success: true, result: { uploadId: 'song-upload', mimeType: 'audio/wav', tier: 'upload', metadata: { dit_model: 'dit', lm_model: 'lm', seed: '4' }, durationMs: 50 } };
    },
  });
  await context.handleCapabilityCommand('run', { id: 'test', slug: provider.slug, kind: 'music', input: { prompt: 'song', duration: 60 }, timeout_ms: 1234, upload: { max_bytes: 128 * 1024 * 1024 } }, (type, body) => events.push({ type, ...plain(body) }));
  assert.equal(dispatched, 1); assert.equal(releases, 1); assert.equal(activeCapabilityRuns.size, 0);
  assert.deepEqual(events.at(-1), { type: 'custom:cap:done', id: 'test', upload_id: 'song-upload', mime_type: 'audio/wav', tier: 'upload', metadata: { dit_model: 'dit', lm_model: 'lm', seed: '4' }, duration_ms: 50 });
  await context.handleCapabilityCommand('run', { id: 'wrong', slug: provider.slug, kind: 'image' }, (type, body) => events.push({ type, ...plain(body) }));
  assert.equal(events.at(-1).stage, 'bad_request'); assert.equal(dispatched, 1);
});
