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
import { setTimeout as delay } from 'node:timers/promises';
import { fetchFleetImage } from '../fleet-image-transport.js';

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
  metadata?: { dit_model?: string; lm_model?: string; seed?: string };
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
  video: { defaultMs: 900_000, minMs: 10_000, hardCapMs: 1_800_000 },
  music: { defaultMs: 2_700_000, minMs: 1, hardCapMs: 7_200_000 },
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
  if (declared > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`provider response is ${declared} bytes; maximum is ${maxBytes}`);
  }
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
  const detail = (await readBytes(response, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8').slice(0, 500).trim();
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
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('image prompt is required'), { stage: 'bad_request' });
  const { width, height } = imageDimensions(input);
  const model = String(input.model || provider.models?.[0] || '');
  const referenceRaw = input.init_image_base64 ?? input.reference_image_base64 ?? input.referenceImageBase64;
  let response: Response;

  if (referenceRaw) {
    const decoded = decodeInboundBase64(referenceRaw, 'reference image');
    if (!decoded.ok || !decoded.bytes) {
      throw Object.assign(new Error(decoded.error || 'invalid reference image'), { stage: 'bad_request' });
    }
    const mimeType = String(input.reference_mime_type || input.referenceMimeType || 'image/png');
    const extension = /jpe?g/i.test(mimeType) ? 'jpg' : /webp/i.test(mimeType) ? 'webp' : 'png';
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(decoded.bytes)], { type: mimeType }), `empir3-reference.${extension}`);
    form.append('prompt', prompt);
    form.append('model', model);
    form.append('size', `${width}x${height}`);
    form.append('n', '1');
    form.append('response_format', 'b64_json');
    const optionalFields: Array<[string, unknown]> = [
      ['negative_prompt', input.negative_prompt ?? input.negativePrompt],
      ['steps', input.steps],
      ['guidance_scale', input.guidance_scale ?? input.guidanceScale],
      ['seed', input.seed],
      ['strength', input.strength ?? input.denoising_strength ?? input.denoisingStrength],
    ];
    for (const [name, value] of optionalFields) {
      if (value !== undefined && value !== null && String(value) !== '') form.append(name, String(value));
    }
    response = await fetch(endpoint(provider.apiBaseUrl, 'images/edits', true), {
      method: 'POST', headers: authHeaders(provider), body: form, signal,
    });
  } else {
    response = await fetch(endpoint(provider.apiBaseUrl, 'images/generations', true), {
      method: 'POST', headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: `${width}x${height}`, n: 1, response_format: 'b64_json' }), signal,
    });
  }
  const body = await readJson(await requireOk(response), base64JsonLimit(outputLimit));
  const raw = String(body?.data?.[0]?.b64_json || '').replace(/^data:[^;]+;base64,/, '');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) throw new Error('OpenAI-compatible image endpoint returned no b64_json bytes');
  if (bytes.length > outputLimit) throw new Error(`generated image is ${bytes.length} bytes; maximum is ${outputLimit}`);
  return { bytes, mimeType: 'image/png' };
}

function videoBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function videoSize(input: Record<string, any>): string {
  const explicit = String(input.size || '').trim();
  if (/^\d{3,4}x\d{3,4}$/i.test(explicit)) return explicit;
  const width = Number(input.width);
  const height = Number(input.height);
  if (Number.isFinite(width) && Number.isFinite(height)) return `${Math.round(width)}x${Math.round(height)}`;
  return '1280x720';
}

async function runOpenAiVideo(
  provider: CapabilityProvider,
  input: Record<string, any>,
  signal: AbortSignal,
  onProgress?: RunCapabilityParams['onProgress'],
  outputLimit = MAX_SYNC_FILE_BYTES,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('video prompt is required'), { stage: 'bad_request' });

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('model', String(input.model || provider.models?.[0] || ''));
  form.append('size', videoSize(input));
  form.append('duration', String(input.duration ?? input.duration_sec ?? input.durationSec ?? 6));
  form.append('fps', String(input.fps ?? 24));

  const promptQuality = /\b(?:ultra|maximum quality|best quality)\b/i.test(prompt)
    ? 'ultra'
    : /\b(?:draft|preview|fast)\b/i.test(prompt)
      ? 'draft'
      : 'high';
  form.append('quality', String(input.quality || promptQuality));
  const promptAudio = /\b(?:with|include|add)\s+(?:audio|sound|soundtrack)|\bsound effects?\b/i.test(prompt)
    && !/\b(?:silent|mute|no audio|no sound)\b/i.test(prompt);
  const promptDetail = /\b(?:maximum|highest|fine)\s+detail|\bdetail mode\b|\bpreserve (?:the )?(?:fine )?detail\b/i.test(prompt);
  form.append('audio', String(videoBoolean(input.audio, promptAudio)));
  form.append('detail', String(videoBoolean(input.detail, promptDetail)));

  const optionalFields: Array<[string, unknown]> = [
    ['seed', input.seed],
    ['steps', input.steps],
    ['guidance_scale', input.guidance_scale ?? input.guidanceScale],
    ['negative_prompt', input.negative_prompt ?? input.negativePrompt],
  ];
  for (const [name, value] of optionalFields) {
    if (value !== undefined && value !== null && String(value) !== '') form.append(name, String(value));
  }

  const referenceRaw = input.init_image_base64 ?? input.reference_image_base64 ?? input.referenceImageBase64;
  if (referenceRaw) {
    const decoded = decodeInboundBase64(referenceRaw, 'reference image');
    if (!decoded.ok || !decoded.bytes) {
      throw Object.assign(new Error(decoded.error || 'invalid reference image'), { stage: 'bad_request' });
    }
    const mimeType = String(input.reference_mime_type || input.referenceMimeType || 'image/png');
    const extension = /jpe?g/i.test(mimeType) ? 'jpg' : /webp/i.test(mimeType) ? 'webp' : 'png';
    form.append('image', new Blob([new Uint8Array(decoded.bytes)], { type: mimeType }), `empir3-reference.${extension}`);
  }

  onProgress?.({ status: 'generating video' });
  const response = await fetch(endpoint(provider.apiBaseUrl, 'videos/generations', true), {
    method: 'POST', headers: authHeaders(provider, 'video/mp4'), body: form, signal,
  });
  await requireOk(response);
  const mimeType = mimeFromResponse(response, 'video/mp4');
  if (!mimeType.startsWith('video/')) throw new Error(`video endpoint returned ${mimeType} instead of video`);
  const bytes = await readBytes(response, outputLimit);
  if (!bytes.length) throw new Error('OpenAI-compatible video endpoint returned no video bytes');
  onProgress?.({ status: 'complete', percent: 100 });
  return { bytes, mimeType };
}

// Explicit fleet wire: JSON images/edits and durable video/music jobs.
// Never retry job creation, follow artifact URLs, or substitute another model.
async function runFleet(
  provider: CapabilityProvider, kind: RuntimeCapabilityKind, input: Record<string, any>,
  signal: AbortSignal, onProgress: RunCapabilityParams['onProgress'], outputLimit: number,
): Promise<{ bytes: Buffer; mimeType: string; metadata?: CapabilityResult['metadata'] }> {
  const model = String(input.model || provider.models?.[0] || '');
  const prompt = String(input.prompt || '').trim();
  const bad = (message: string): never => { throw Object.assign(new Error(message), { stage: 'bad_request' }); };
  if (!model || !prompt) bad('An explicit fleet model and prompt are required');
  const request = async (path: string, body?: any) => requireOk(await fetch(endpoint(provider.apiBaseUrl, path, true), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    // Music polls every five seconds, which can coincide with a gateway's idle
    // keep-alive expiry on Node 18. Use fresh connections instead of risking a
    // stale socket or retrying a request after an uncertain transport failure.
    headers: { ...authHeaders(provider), ...(kind === 'music' ? { Connection: 'close' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const reference = input.init_image_base64 ?? input.reference_image_base64 ?? input.referenceImageBase64;
  if (kind === 'image') {
    for (const field of ['negative_prompt', 'guidance_scale', 'strength', 'denoising_strength']) {
      if (input[field] !== undefined) bad(`Fleet image profile does not support ${field}`);
    }
    const body: Record<string, any> = { model, prompt, n: 1 };
    if (input.size !== undefined) body.size = input.size;
    else if (input.width !== undefined || input.height !== undefined) body.size = `${input.width}x${input.height}`;
    if (input.aspect_ratio !== undefined) body.aspect_ratio = input.aspect_ratio;
    for (const field of ['steps', 'seed']) if (input[field] !== undefined) body[field] = input[field];
    if (input.image_url || input.image || input.images) bad('Use an inline reference_image_base64 for fleet edits');
    if (reference) {
      const decoded = decodeInboundBase64(reference, 'reference image');
      if (!decoded.ok || !decoded.bytes) bad(decoded.error || 'Invalid reference image');
      const mime = String(input.reference_mime_type || input.referenceMimeType || 'image/png');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) bad('Reference must be PNG, JPEG or WebP');
      body.images = [`data:${mime};base64,${decoded.bytes!.toString('base64')}`];
    }
    onProgress?.({ status: 'queued or generating image' });
    const value = await readJson(await requireOk(await fetchFleetImage(
      endpoint(provider.apiBaseUrl, reference ? 'images/edits' : 'images/generations', true),
      JSON.stringify(body), { ...authHeaders(provider), 'Content-Type': 'application/json' }, signal,
    )), base64JsonLimit(outputLimit));
    const raw = value?.data?.[0]?.b64_json;
    if (typeof raw !== 'string') throw new Error('Fleet image returned no bytes');
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length || bytes.length > outputLimit || bytes.toString('base64') !== raw) throw new Error('Invalid or oversized fleet image');
    const mimeType = value.data[0].mime_type || 'image/png';
    if (!['image/png','image/jpeg','image/webp'].includes(mimeType)) throw new Error('Invalid fleet image MIME type');
    return { bytes, mimeType };
  }
  if (kind === 'music') {
    const allowed = new Set(['model', 'prompt', 'lyrics', 'instrumental', 'duration', 'bpm', 'quality', 'seed', 'vocal_language']);
    for (const field of Object.keys(input)) if (!allowed.has(field)) bad(`Fleet music does not support ${field}`);
    if (typeof input.prompt !== 'string' || !prompt || input.prompt.length > 2000) bad('Music prompt must contain 1–2000 characters');
    if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim())) bad('Invalid music model');
    if (provider.models?.length && !provider.models.includes(model)) bad('Music model is not in the configured allowlist');
    if (!Number.isInteger(input.duration) || input.duration < 10 || input.duration > 600) bad('Music duration must be an integer from 10 to 600 seconds');
    if (input.lyrics !== undefined && (typeof input.lyrics !== 'string' || !input.lyrics.trim() || input.lyrics.length > 6000)) bad('Music lyrics must contain 1–6000 characters');
    if (input.instrumental !== undefined && typeof input.instrumental !== 'boolean') bad('Music instrumental must be boolean');
    if (input.bpm !== undefined && (typeof input.bpm !== 'number' || !Number.isFinite(input.bpm) || input.bpm < 40 || input.bpm > 240)) bad('Music bpm must be from 40 to 240');
    if (input.quality !== undefined && !['draft', 'final'].includes(input.quality)) bad('Music quality must be draft or final');
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) bad('Music seed must be a nonnegative safe integer');
    if (input.vocal_language !== undefined && (typeof input.vocal_language !== 'string' || input.vocal_language.length > 32 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(input.vocal_language))) bad('Music vocal_language must be a language code such as en');
    const body: Record<string, any> = { model, prompt, duration: input.duration };
    for (const field of ['lyrics', 'instrumental', 'bpm', 'quality', 'seed', 'vocal_language']) if (input[field] !== undefined) body[field] = input[field];
    // A catalog match is required even for direct invocations without a saved model list.
    const catalog = await readJson(await request('models'));
    if (!Array.isArray(catalog?.data) || !catalog.data.some((entry: any) => entry?.id === model && Array.isArray(entry.capabilities) && entry.capabilities.includes('musicgen'))) {
      bad('Selected fleet model does not advertise musicgen');
    }
    const job = await readJson(await request('music', body));
    if (typeof job?.id !== 'string' || !/^music_[a-f0-9-]+$/.test(job.id) || job.model !== model) throw new Error('Fleet returned an invalid music job identity');
    const jobPath = `music/${job.id}`;
    let state = job;
    while (state.status !== 'completed') {
      if (state.status === 'failed') throw new Error(`Fleet music ${job.id} failed: ${String(state.error || 'generation failed').slice(0, 300)}`);
      if (state.status !== 'in_progress') throw new Error('Unknown fleet music job status');
      onProgress?.({ status: `generating song (${job.id}); stopping the wait does not cancel the GPU job` });
      await delay(5000, undefined, { signal });
      state = await readJson(await request(jobPath));
      if (state?.id !== job.id || state.model !== model) throw new Error('Fleet music job identity changed');
    }
    const response = await request(`${jobPath}/content`);
    if (mimeFromResponse(response, '').toLowerCase() !== 'audio/wav') {
      try { await response.body?.cancel(); } catch {}
      throw new Error('Fleet returned a non-WAV artifact');
    }
    const bytes = await readBytes(response, Math.min(outputLimit, 128 * 1024 * 1024));
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Fleet returned invalid WAV bytes');
    const metadata: NonNullable<CapabilityResult['metadata']> = {};
    for (const field of ['dit_model', 'lm_model'] as const) {
      if (typeof state.result?.[field] === 'string') metadata[field] = state.result[field].slice(0, 256);
    }
    // ACE-Step may encode its selected seed as decimal text.
    const seed = state.result?.seed;
    if ((typeof seed === 'number' || (typeof seed === 'string' && /^\d{1,16}$/.test(seed))) && Number.isSafeInteger(Number(seed)) && Number(seed) >= 0) metadata.seed = String(seed);
    onProgress?.({ status: 'complete', percent: 100 });
    return { bytes, mimeType: 'audio/wav', metadata };
  }
  if (kind !== 'video') bad('Fleet media wire supports images, videos and music only');
  for (const field of ['quality', 'detail', 'steps', 'guidance_scale', 'negative_prompt']) {
    if (input[field] !== undefined) bad(`Current H3 profile does not support ${field}`);
  }
  const seconds = Number(input.seconds ?? input.duration ?? input.duration_sec ?? input.durationSec ?? 5);
  const resolution = input.resolution ?? '576p';
  const canvases: Record<string, string> = resolution === '768p'
    ? { '16:9': '1280x736', '9:16': '736x1280', '1:1': '960x960', '4:3': '1120x832', '3:4': '832x1120' }
    : { '16:9': '1024x576', '9:16': '576x1024', '1:1': '768x768', '4:3': '864x640', '3:4': '640x864', '3:2': '928x608', '2:3': '608x928' };
  const size = input.size ?? ((input.width !== undefined || input.height !== undefined) ? `${input.width}x${input.height}` : canvases[input.aspect_ratio ?? '16:9']);
  if (![5, 10, 15].includes(seconds) || !['576p', '768p'].includes(resolution)
      || (input.fps !== undefined && Number(input.fps) !== 24)) {
    bad('H3 supports 5, 10 or 15 seconds at 576p or 768p, 24 fps, with text or one first-frame reference image');
  }
  if (input.image !== undefined || input.image_url !== undefined || input.images !== undefined || input.input_reference !== undefined || input.last_frame !== undefined) bad('Use one inline reference_image_base64 for H3 video');
  const dimensions = /^(\d{3,4})x(\d{3,4})$/.exec(String(size));
  const [width, height] = dimensions ? dimensions.slice(1).map(Number) : [0, 0];
  const high = resolution === '768p';
  if (Math.min(width, height) < 256 || Math.max(width, height) > (high ? 1280 : 1024)
      || width % 32 || height % 32 || width * height > (high ? 1280 * 736 : 1024 * 576)
      || (input.aspect_ratio !== undefined && canvases[input.aspect_ratio] !== size)
      || (!reference && !Object.values(canvases).includes(size))) bad('Unsupported H3 video canvas; size and aspect ratio must agree');
  const body: Record<string, any> = { model, prompt, seconds, size, resolution };
  if (input.aspect_ratio !== undefined) body.aspect_ratio = input.aspect_ratio;
  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed >= 2 ** 32) bad('Invalid H3 seed');
    body.seed = input.seed;
  }
  if (input.video_profile !== undefined) {
    if (!['standard', 'turbo', 'turbo8'].includes(input.video_profile)) bad('Invalid H3 video_profile');
    body.video_profile = input.video_profile;
  }
  if (input.num_inference_steps !== undefined) {
    const profile = input.video_profile ?? 'turbo8';
    const steps = input.num_inference_steps;
    if (!Number.isSafeInteger(steps) || steps < 1 || (profile === 'turbo' && steps !== 5) || (profile === 'turbo8' && steps !== 9)) bad('Invalid inference steps for the selected H3 profile');
    body.num_inference_steps = steps;
  }
  if (reference !== undefined) {
    const decoded = decodeInboundBase64(reference, 'reference image');
    if (!decoded.ok || !decoded.bytes?.length || decoded.bytes.length > 20 * 1024 * 1024) bad(decoded.error || 'Invalid or oversized reference image');
    const mime = String(input.reference_mime_type || input.referenceMimeType || 'image/png');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) bad('Reference must be PNG, JPEG or WebP');
    body.image = `data:${mime};base64,${decoded.bytes!.toString('base64')}`;
  }
  if (input.audio !== undefined && !videoBoolean(input.audio, true)) bad('Current H3 profile generates audio; silent output is not supported');
  const job = await readJson(await request('videos', body));
  if (!/^video_[a-f0-9-]+$/.test(job?.id || '') || job.model !== model) throw new Error('Fleet returned an invalid video job identity');
  const jobPath = `videos/${job.id}`;
  let state = job;
  while (state.status !== 'completed') {
    if (state.status === 'failed') throw new Error(`Fleet video ${job.id} failed: ${String(state.error || 'generation failed').slice(0, 300)}`);
    if (state.status !== 'in_progress') throw new Error('Unknown fleet video job status');
    onProgress?.({ status: `generating video (${job.id}); stopping the wait does not cancel the GPU job` });
    await delay(2000, undefined, { signal });
    state = await readJson(await request(jobPath));
    if (state.id !== job.id || state.model !== model) throw new Error('Fleet video job identity changed');
  }
  const response = await request(`${jobPath}/content`);
  if (mimeFromResponse(response, '') !== 'video/mp4') throw new Error('Fleet returned a non-MP4 artifact');
  const bytes = await readBytes(response, outputLimit);
  if (!bytes.length) throw new Error('Fleet returned an empty video');
  onProgress?.({ status: 'complete', percent: 100 });
  return { bytes, mimeType: 'video/mp4' };
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

    if (kind === 'music' && provider.wire !== 'empir3-fleet') return { success: false, stage: 'bad_request', error: 'Music requires the empir3-fleet wire' };
    let media: { bytes: Buffer; mimeType: string; metadata?: CapabilityResult['metadata'] };
    if (provider.wire === 'empir3-fleet') {
      media = await runFleet(provider, kind, input, signal, onProgress, maxOutputBytes(upload));
    } else if (kind === 'tts') {
      media = await runTts(provider, input, signal, maxOutputBytes(upload));
    } else if (kind === 'video' && provider.wire === 'openai-video') {
      media = await runOpenAiVideo(provider, input, signal, onProgress, maxOutputBytes(upload));
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
        ...(media.metadata ? { metadata: media.metadata } : {}),
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
  // Respect explicit caller deadlines. Only this opt-in queued fleet wire has
  // a longer default/cap; ordinary vendor adapters retain their existing limits.
  const fleetQueued = (params.kind === 'video' || params.kind === 'music') && params.provider.wire === 'empir3-fleet';
  const timeoutMs = fleetQueued
    ? Math.min(Number.isFinite(params.timeoutMs) && Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 2_700_000, 7_200_000)
    : clampTimeout(params.kind, params.timeoutMs);
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
