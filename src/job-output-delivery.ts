import { createHash } from 'node:crypto';
import { MAX_SYNC_FILE_BYTES, SYNC_SERVER_FRAME_CAP } from './sync-limits.js';

export interface OutputDeliveryResult {
  accepted: boolean;
  reason?: string;
}

/** Encode original bytes, including unknown extensions, without a text conversion. */
export function jobOutputPayload(file: {
  projectId: string; projectName: string; relPath: string; mtimeMs: number;
}, bytes: Buffer) {
  if (bytes.length > MAX_SYNC_FILE_BYTES) {
    throw new Error(`Output has ${bytes.length} bytes; this transfer supports at most ${MAX_SYNC_FILE_BYTES} bytes per file. No bytes were sent.`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const payload = {
    projectId: file.projectId, projectName: file.projectName, path: file.relPath,
    content: bytes.toString('base64'), encoding: 'base64',
    size: bytes.length, sizeBytes: bytes.length, mtimeMs: file.mtimeMs,
    hash, sha256: hash, authoritative: true,
  };
  if (Buffer.byteLength(JSON.stringify({ type: 'desktop:sync:local:file', payload })) > SYNC_SERVER_FRAME_CAP) {
    throw new Error('Output metadata and encoded bytes exceed the transfer frame limit. No bytes were sent.');
  }
  return payload;
}

type PendingDelivery = (result: OutputDeliveryResult) => void;

/** A socket-send callback is not a workspace write receipt. Match the server's
 * existing canonical-file acknowledgement by project, path AND original hash. */
export class JobOutputDelivery {
  private readonly pending = new Map<string, Set<PendingDelivery>>();

  private key(projectId: string, path: string, hash: string): string {
    return JSON.stringify([projectId, path, hash]);
  }

  deliver(payload: ReturnType<typeof jobOutputPayload>, send: () => Promise<boolean>, timeoutMs = 15_000): Promise<OutputDeliveryResult> {
    const key = this.key(payload.projectId, payload.path, payload.hash);
    return new Promise(resolve => {
      const listeners = this.pending.get(key) || new Set<PendingDelivery>();
      let settled = false;
      const finish: PendingDelivery = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(finish);
        if (!listeners.size) this.pending.delete(key);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ accepted: false, reason: 'Workspace delivery was not confirmed before the timeout. The file may have arrived; check it before retrying.' }), timeoutMs);
      listeners.add(finish);
      this.pending.set(key, listeners);
      void Promise.resolve().then(send).then(sent => {
        if (!sent) finish({ accepted: false, reason: 'Bridge connection could not send the output file.' });
      }).catch(() => finish({ accepted: false, reason: 'Bridge connection failed while sending the output file.' }));
    });
  }

  acknowledge(receipt: { projectId?: unknown; path?: unknown; hash?: unknown; accepted?: unknown; result?: unknown }): void {
    if (typeof receipt.projectId !== 'string' || typeof receipt.path !== 'string' || typeof receipt.hash !== 'string') return;
    const listeners = this.pending.get(this.key(receipt.projectId, receipt.path, receipt.hash));
    if (!listeners) return;
    const result = receipt.accepted === true
      ? { accepted: true }
      : { accepted: false, reason: receipt.result === 'conflict-copy' ? 'The workspace kept a conflict copy; the requested destination was not updated.' : 'The workspace did not accept the output at its requested destination.' };
    for (const finish of [...listeners]) finish(result);
  }
}
