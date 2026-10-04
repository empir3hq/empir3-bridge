import { assetTier } from './capability-core.js';

export interface AssetUploadGrant {
  upload_url: string;
  upload_token: string;
  max_bytes: number;
  device_id: string;
  /** Non-secret fleet routing hint; keeps the HTTP upload on the WS issuer. */
  routing_cookie?: string;
}

export interface DeliveredAsset {
  bytesBase64?: string;
  uploadId?: string;
  tier: 'inline' | 'upload';
}

function normalizeUploadGrant(raw: any): AssetUploadGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const upload_url = String(raw.upload_url || raw.uploadUrl || '').trim();
  const upload_token = String(raw.upload_token || raw.uploadToken || '').trim();
  const max_bytes = Number(raw.max_bytes ?? raw.maxBytes);
  const device_id = String(raw.device_id || raw.deviceId || '').trim();
  const routing_cookie = String(raw.routing_cookie || raw.routingCookie || '').trim();
  if (!/^https?:\/\//i.test(upload_url) || !upload_token || !device_id || !Number.isSafeInteger(max_bytes) || max_bytes <= 0) return null;
  return { upload_url, upload_token, max_bytes, device_id, ...(routing_cookie ? { routing_cookie } : {}) };
}

export async function uploadAsset(
  bytes: Buffer,
  mimeType: string,
  rawGrant: unknown,
  signal?: AbortSignal,
): Promise<{ uploadId: string }> {
  const grant = normalizeUploadGrant(rawGrant);
  if (!grant) throw new Error('server did not provide valid asset upload credentials');
  if (bytes.length > grant.max_bytes) {
    throw new Error(`generated asset is ${bytes.length} bytes; upload grant permits ${grant.max_bytes} bytes`);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(grant.upload_url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${grant.upload_token}`,
          'Content-Type': mimeType,
          'Content-Length': String(bytes.length),
          'X-Empir3-Device-Id': grant.device_id,
          ...(grant.routing_cookie ? { Cookie: grant.routing_cookie } : {}),
        },
        body: bytes as any,
        signal,
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        const detail = text.slice(0, 300).trim();
        const error = new Error(`asset upload HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        if (response.status < 500 || attempt === 1) throw error;
        lastError = error;
        continue;
      }
      let body: any = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* response body is optional */ }
      const uploadId = String(body.upload_id || body.uploadId || '').trim();
      if (!uploadId) throw new Error('asset upload response did not include upload_id');
      return { uploadId };
    } catch (error: any) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      // A network error gets one retry. HTTP 4xx is thrown above and must not.
      if (/asset upload HTTP 4\d\d/.test(lastError.message) || attempt === 1) throw lastError;
    }
  }
  throw lastError || new Error('asset upload failed');
}

export async function deliverAsset(
  bytes: Buffer,
  mimeType: string,
  upload: unknown,
  signal?: AbortSignal,
): Promise<DeliveredAsset> {
  if (assetTier(bytes) === 'inline') {
    return { tier: 'inline', bytesBase64: bytes.toString('base64') };
  }
  const result = await uploadAsset(bytes, mimeType, upload, signal);
  return { tier: 'upload', uploadId: result.uploadId };
}
