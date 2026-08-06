/**
 * Generic Bridge capability rail.
 *
 * Wire contract:
 *   server -> bridge  custom:cap:run      {id, slug, kind, input, timeout_ms, upload}
 *   bridge -> server  custom:cap:progress {id, status, percent?}
 *                     custom:cap:done     {id, text? | bytes_base64? | upload_id?, mime_type?, duration_ms, tier?}
 *                     custom:cap:error    {id, stage, error}
 *   server -> bridge  custom:cap:abort    {id}
 *
 * Provider URLs and keys never cross the relay. This module receives the
 * already-resolved local provider entry from server.ts and speaks only one of
 * the enumerated wire adapters below.
 */

import {
  decodeInboundBase64,
  parseWorkflowJson,
  substituteWorkflowValues,
  type RuntimeCapabilityKind,
} from '../capability-core.js';
import { deliverAsset, type AssetUploadGrant } from '../asset-transport.js';
import { MAX_SYNC_FILE_BYTES } from '../sync-limits.js';

export interface CapabilityProvider {
  slug: string;
  name: string;
  apiBaseUrl: string;
  apiKey?: string;
  models?: string[];
  kind?: 'chat' | RuntimeCapabilityKind;
  wire?: string;
  workflowJson?: string;
}

export interface CapabilityResult {
  text?: string;
  bytes?: Buffer;
  mimeType?: string;
  uploadId?: string;
  tier?: 'inline' | 'upload';
  durationMs: number;
}

export interface CapabilityOutcome {
  success: boolean;
  result?: CapabilityResult;
  stage?: string;
  error?: string;
}

export interface RunCapabilityParams {
  provider: CapabilityProvider;
  kind: RuntimeCapabilityKind;
  input: Record<string, any>;
  timeoutMs?: number;
  signal?: AbortSignal;
  upload?: AssetUploadGrant;
  onProgress?: (progress: { status: string; percent?: number }) => void;
}

const TIMEOUTS: Record<RuntimeCapabilityKind, { defaultMs: number; minMs: number; hardCapMs: number }> = {
  stt: { defaultMs: 60_000, minMs: 1_000, hardCapMs: 180_000 },
  tts: { defaultMs: 60_000, minMs: 1_000, hardCapMs: 180_000 },
  image: { defaultMs: 300_000, minMs: 5_000, hardCapMs: 900_000 },
};
const MAX_TEXT_CHARS = 200_000;
const SMALL_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

const queues = new Map<RuntimeCapabilityKind, Promise<unknown>>();

function enqueue<T>(kind: RuntimeCapabilityKind, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(kind) || Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(kind, next.then(() => undefined, () => undefined));
  return next;
}

function clampTimeout(kind: RuntimeCapabilityKind, raw?: number): number {
  const limits = TIMEOUTS[kind];
  const requested = Number.isFinite(raw) && Number(raw) > 0 ? Number(raw) : limits.defaultMs;
  return Math.min(Math.max(requested, limits.minMs), limits.hardCapMs);
}

function endpoint(baseUrl: string, path: string, ensureV1 = false): string {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (ensureV1 && !/\/v1$/i.test(base)) return `${base}/v1/${path.replace(/^\/+/, '')}`;
  return `${base}/${path.replace(/^\/+/, '')}`;
}

function authHeaders(provider: CapabilityProvider, accept?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (accept) headers.Accept = accept;
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

async function readBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`provider response is ${declared} bytes; maximum is ${maxBytes}`);
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`provider response is ${bytes.length} bytes; maximum is ${maxBytes}`);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`provider response exceeds ${maxBytes} bytes`);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

async function readJson(response: Response, maxBytes = SMALL_JSON_RESPONSE_BYTES): Promise<any> {
  const bytes = await readBytes(response, maxBytes);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('provider returned invalid JSON'); }
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
  throw new Error(`provider HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

function mimeFromResponse(response: Response, fallback: string): string {
  return String(response.headers.get('content-type') || fallback).split(';')[0].trim() || fallback;
}

function maxOutputBytes(upload?: AssetUploadGrant): number {
  const granted = Number(upload?.max_bytes);
  return Number.isSafeInteger(granted) && granted > 0 ? granted : MAX_SYNC_FILE_BYTES;
}

function base64JsonLimit(outputBytes: number): number {
  // Base64 is 4/3 of the binary plus a small provider-response envelope.
  return Math.ceil(outputBytes * 4 / 3) + 512 * 1024;
}

async function runStt(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
): Promise<{ text: string }> {
  const decoded = decodeInboundBase64(input.audio_base64 ?? input.audioBase64, 'STT audio');
  if (!decoded.ok || !decoded.bytes) throw Object.assign(new Error(decoded.error || 'invalid STT audio'), { stage: 'bad_request' });
  const form = new FormData();
  const mime = String(input.mime_type || input.mimeType || 'audio/wav');
  const filename = String(input.filename || 'speech.wav').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'speech.wav';
  const audioField = provider.wire === 'openai-transcriptions' ? 'file' : 'audio';
  form.append(audioField, new Blob([new Uint8Array(decoded.bytes)], { type: mime }), filename);
  if (provider.wire === 'openai-transcriptions') {
    form.append('model', String(input.model || provider.models?.[0] || 'whisper-1'));
  }
  const path = provider.wire === 'openai-transcriptions' ? 'audio/transcriptions' : 'transcribe';
  const response = await fetch(endpoint(provider.apiBaseUrl, path), {
    method: 'POST', headers: authHeaders(provider, 'application/json'), body: form, signal,
  });
  const body = await readJson(await requireOk(response), 2 * 1024 * 1024);
  const text = String(body?.text || body?.transcript || '').trim();
  if (!text) throw new Error('speech endpoint returned no transcript');
  return { text };
}

async function runTts(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
  outputLimit: number,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const text = String(input.text || '').trim();
  if (!text) throw Object.assign(new Error('TTS text is required'), { stage: 'bad_request' });
  if (text.length > MAX_TEXT_CHARS) throw Object.assign(new Error(`TTS text exceeds ${MAX_TEXT_CHARS} characters`), { stage: 'bad_request' });
  const voice = String(input.voice || input.voice_id || provider.models?.[0] || 'alloy');
  const speed = Number.isFinite(Number(input.speed)) ? Number(input.speed) : 1;
  const native = provider.wire === 'kokoro-native';
  const response = await fetch(endpoint(provider.apiBaseUrl, native ? 'tts' : 'audio/speech'), {
    method: 'POST',
    headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
    body: JSON.stringify(native
      ? { text, voice, speed }
      : { model: String(input.model || 'tts-1'), voice, input: text, speed }),
    signal,
  });
  await requireOk(response);
  const mimeType = mimeFromResponse(response, native ? 'audio/wav' : 'audio/mpeg');
  return { bytes: await readBytes(response, outputLimit), mimeType };
}

function imageDimensions(input: Record<string, any>): { width: number; height: number } {
  const size = String(input.size || '1024x1024');
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(size);
  const width = Math.max(64, Math.min(8192, Number(input.width || match?.[1] || 1024)));
  const height = Math.max(64, Math.min(8192, Number(input.height || match?.[2] || 1024)));
  return { width, height };
}

async function pollA1111Progress(provider: CapabilityProvider, signal: AbortSignal, onProgress?: RunCapabilityParams['onProgress']) {
  while (!signal.aborted) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); }, { once: true });
    });
    try {
      const response = await fetch(endpoint(provider.apiBaseUrl, 'sdapi/v1/progress'), {
        headers: authHeaders(provider, 'application/json'), signal,
      });
      if (!response.ok) continue;
      const body = await readJson(response, 256 * 1024);
      const percent = Math.max(0, Math.min(99, Math.round(Number(body?.progress || 0) * 100)));
      onProgress?.({ status: String(body?.state?.job || 'generating'), ...(percent ? { percent } : {}) });
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
}

async function runA1111(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
  onProgress?: RunCapabilityParams['onProgress'],
  outputLimit = MAX_SYNC_FILE_BYTES,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('image prompt is required'), { stage: 'bad_request' });
  const initRaw = input.init_image_base64 ?? input.reference_image_base64 ?? input.referenceImageBase64;
  let initBase64: string | undefined;
  if (initRaw) {
    const decoded = decodeInboundBase64(initRaw, 'reference image');
    if (!decoded.ok || !decoded.bytes) throw Object.assign(new Error(decoded.error || 'invalid reference image'), { stage: 'bad_request' });
    initBase64 = decoded.bytes.toString('base64');
  }
  const { width, height } = imageDimensions(input);
  const body: Record<string, any> = {
    prompt,
    negative_prompt: String(input.negative_prompt || input.negativePrompt || ''),
    seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : -1,
    width,
    height,
    steps: Number.isFinite(Number(input.steps)) ? Number(input.steps) : undefined,
    cfg_scale: Number.isFinite(Number(input.cfg_scale ?? input.cfgScale)) ? Number(input.cfg_scale ?? input.cfgScale) : undefined,
    sampler_name: input.sampler_name || input.samplerName || undefined,
    override_settings: input.model ? { sd_model_checkpoint: String(input.model) } : undefined,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  if (initBase64) {
    body.init_images = [initBase64];
    if (Number.isFinite(Number(input.denoising_strength ?? input.denoisingStrength))) {
      body.denoising_strength = Number(input.denoising_strength ?? input.denoisingStrength);
    }
  }
  const path = initBase64 ? 'sdapi/v1/img2img' : 'sdapi/v1/txt2img';
  const progressController = new AbortController();
  const stopProgress = () => progressController.abort();
  signal.addEventListener('abort', stopProgress, { once: true });
  const progress = pollA1111Progress(provider, progressController.signal, onProgress).catch(() => {});
  try {
    const response = await fetch(endpoint(provider.apiBaseUrl, path), {
      method: 'POST', headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    const result = await readJson(await requireOk(response), base64JsonLimit(outputLimit));
    const raw = String(result?.images?.[0] || '').replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) throw new Error('A1111 returned no image bytes');
    if (bytes.length > outputLimit) throw new Error(`A1111 image is ${bytes.length} bytes; maximum is ${outputLimit}`);
    onProgress?.({ status: 'complete', percent: 100 });
    return { bytes, mimeType: 'image/png' };
  } finally {
    progressController.abort();
    signal.removeEventListener('abort', stopProgress);
    await progress;
  }
}

async function uploadComfyReference(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
): Promise<string> {
  const decoded = decodeInboundBase64(
    input.init_image_base64 ?? input.reference_image_base64 ?? input.referenceImageBase64,
    'reference image',
  );
  if (!decoded.ok || !decoded.bytes) throw Object.assign(new Error(decoded.error || 'invalid reference image'), { stage: 'bad_request' });
  const mimeType = String(input.reference_mime_type || input.referenceMimeType || 'image/png');
  const extension = /jpe?g/i.test(mimeType) ? 'jpg' : /webp/i.test(mimeType) ? 'webp' : 'png';
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(decoded.bytes)], { type: mimeType }), `empir3-reference.${extension}`);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const response = await fetch(endpoint(provider.apiBaseUrl, 'upload/image'), {
    method: 'POST', headers: authHeaders(provider), body: form, signal,
  });
  const body = await readJson(await requireOk(response), 512 * 1024);
  const name = String(body?.name || '').trim();
  const subfolder = String(body?.subfolder || '').trim().replace(/^\/+|\/+$/g, '');
  if (!name) throw new Error('ComfyUI did not return an uploaded reference filename');
  return subfolder ? `${subfolder}/${name}` : name;
}

function findComfyImage(history: any, promptId: string): any | null {
  const entry = history?.[promptId] || history;
  const outputs = entry?.outputs && typeof entry.outputs === 'object' ? Object.values(entry.outputs) : [];
  for (const output of outputs as any[]) {
    const image = Array.isArray(output?.images) ? output.images[0] : null;
    if (image?.filename) return image;
  }
  return null;
}

async function interruptComfy(provider: CapabilityProvider): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetch(endpoint(provider.apiBaseUrl, 'interrupt'), {
      method: 'POST', headers: { ...authHeaders(provider), 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
    });
  } catch { /* best effort */ }
  finally { clearTimeout(timer); }
}

async function runComfyUi(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
  onProgress?: RunCapabilityParams['onProgress'],
  outputLimit = MAX_SYNC_FILE_BYTES,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const parsed = parseWorkflowJson(String(provider.workflowJson || ''));
  if (!parsed.ok || !parsed.workflow) throw Object.assign(new Error(parsed.error || 'invalid ComfyUI workflow'), { stage: 'bad_request' });
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('image prompt is required'), { stage: 'bad_request' });
  const { width, height } = imageDimensions(input);
  let initImage = '';
  if (input.init_image_base64 || input.reference_image_base64 || input.referenceImageBase64) {
    initImage = await uploadComfyReference(provider, input, signal);
  }
  const workflow = substituteWorkflowValues(parsed.workflow, {
    '%PROMPT%': prompt,
    '%NEGATIVE%': String(input.negative_prompt || input.negativePrompt || ''),
    '%SEED%': Number.isFinite(Number(input.seed)) ? Number(input.seed) : Math.floor(Math.random() * 2_147_483_647),
    '%WIDTH%': width,
    '%HEIGHT%': height,
    '%MODEL%': String(input.model || provider.models?.[0] || 'sd_xl_base_1.0.safetensors'),
    '%INIT_IMAGE%': initImage,
  });
  onProgress?.({ status: 'submitting' });
  const submit = await fetch(endpoint(provider.apiBaseUrl, 'prompt'), {
    method: 'POST', headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }), signal,
  });
  const submitted = await readJson(await requireOk(submit), 512 * 1024);
  const promptId = String(submitted?.prompt_id || submitted?.promptId || '').trim();
  if (!promptId) throw new Error('ComfyUI did not return prompt_id');

  let waitMs = 400;
  try {
    while (!signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); }, { once: true });
      });
      const response = await fetch(endpoint(provider.apiBaseUrl, `history/${encodeURIComponent(promptId)}`), {
        headers: authHeaders(provider, 'application/json'), signal,
      });
      if (response.ok) {
        const history = await readJson(response);
        const image = findComfyImage(history, promptId);
        if (image) {
          const query = new URLSearchParams({
            filename: String(image.filename),
            subfolder: String(image.subfolder || ''),
            type: String(image.type || 'output'),
          });
          const output = await fetch(`${endpoint(provider.apiBaseUrl, 'view')}?${query.toString()}`, {
            headers: authHeaders(provider), signal,
          });
          await requireOk(output);
          onProgress?.({ status: 'complete', percent: 100 });
          return { bytes: await readBytes(output, outputLimit), mimeType: mimeFromResponse(output, 'image/png') };
        }
      }
      onProgress?.({ status: 'queued or generating' });
      waitMs = Math.min(2_000, Math.round(waitMs * 1.35));
    }
    throw signal.reason || new Error('aborted');
  } catch (error) {
    if (signal.aborted) await interruptComfy(provider);
    throw error;
  }
}

async function runOpenAiImage(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
  outputLimit = MAX_SYNC_FILE_BYTES,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (input.init_image_base64 || input.reference_image_base64 || input.referenceImageBase64) {
    throw Object.assign(new Error('openai-images adapter does not support a reference image'), { stage: 'bad_request' });
  }
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('image prompt is required'), { stage: 'bad_request' });
  const { width, height } = imageDimensions(input);
  const response = await fetch(endpoint(provider.apiBaseUrl, 'images/generations', true), {
    method: 'POST', headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: String(input.model || provider.models?.[0] || ''), prompt, size: `${width}x${height}`, n: 1, response_format: 'b64_json',
    }), signal,
  });
  const body = await readJson(await requireOk(response), base64JsonLimit(outputLimit));
  const raw = String(body?.data?.[0]?.b64_json || '').replace(/^data:[^;]+;base64,/, '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) throw new Error('OpenAI-compatible image endpoint returned no b64_json bytes');
  if (bytes.length > outputLimit) throw new Error(`generated image is ${bytes.length} bytes; maximum is ${outputLimit}`);
  return { bytes, mimeType: 'image/png' };
}

async function execute(params: RunCapabilityParams, signal: AbortSignal): Promise<CapabilityOutcome> {
  const startedAt = Date.now();
  const { provider, kind, input, upload, onProgress } = params;
  if ((provider.kind || 'chat') !== kind) return { success: false, stage: 'bad_request', error: `provider ${provider.slug} is not a ${kind} provider` };
  try {
    if (kind === 'stt') {
      const result = await runStt(provider, input, signal);
      return { success: true, result: { text: result.text, durationMs: Date.now() - startedAt } };
    }

    let media: { bytes: Buffer; mimeType: string };
    if (kind === 'tts') {
      media = await runTts(provider, input, signal, maxOutputBytes(upload));
    } else if (provider.wire === 'a1111') {
      media = await runA1111(provider, input, signal, onProgress, maxOutputBytes(upload));
    } else if (provider.wire === 'comfyui') {
      media = await runComfyUi(provider, input, signal, onProgress, maxOutputBytes(upload));
    } else if (provider.wire === 'openai-images') {
      media = await runOpenAiImage(provider, input, signal, maxOutputBytes(upload));
    } else {
      return { success: false, stage: 'bad_request', error: `unsupported ${kind} wire ${provider.wire || '(missing)'}` };
    }
    const delivered = await deliverAsset(media.bytes, media.mimeType, upload, signal);
    return {
      success: true,
      result: {
        ...(delivered.bytesBase64 ? { bytes: Buffer.from(delivered.bytesBase64, 'base64') } : {}),
        ...(delivered.uploadId ? { uploadId: delivered.uploadId } : {}),
        mimeType: media.mimeType,
        tier: delivered.tier,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error: any) {
    if (signal.aborted) return { success: false, stage: 'aborted', error: 'capability run aborted' };
    const stage = String(error?.stage || (/upload/i.test(error?.message || '') ? 'upload' : 'provider'));
    return { success: false, stage, error: error?.message || String(error) };
  }
}

export async function runCapability(params: RunCapabilityParams): Promise<CapabilityOutcome> {
  const timeoutMs = clampTimeout(params.kind, params.timeoutMs);
  return enqueue(params.kind, async () => {
    if (params.signal?.aborted) return { success: false, stage: 'aborted', error: 'capability run aborted' };
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(params.signal?.reason || new Error('aborted'));
    params.signal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`capability timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await execute(params, controller.signal);
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', abortFromParent);
    }
  });
}
