import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PageSession } from './browser-target-io.js';

const MAX_BYTES = 32 * 1024 * 1024;

export function decodeUploadFiles(payload: any) {
  const files = payload.files === undefined ? [payload] : payload.files;
  if (!Array.isArray(files) || !files.length || files.length > 10) throw new Error('upload_file requires between 1 and 10 files.');
  let total = 0;
  return files.map((file: any) => {
    const filename = file?.filename;
    if (typeof filename !== 'string' || !filename || filename.length > 240 || /[\\/\x00-\x1f<>:"|?*]/.test(filename) || /^\.{1,2}$/.test(filename)) {
      throw new Error('Each upload needs a plain filename without directory components.');
    }
    const data = file.data;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error('File data must be valid base64, with at most 32 MiB total decoded bytes.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw new Error('File data must be canonical base64.');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Uploads are limited to 32 MiB total decoded bytes.');
    const mimeType = file.mimeType || 'application/octet-stream';
    if (typeof mimeType !== 'string' || mimeType.length > 255 || /[^\x20-\x7e]/.test(mimeType)) throw new Error('Invalid upload MIME type.');
    return { filename, mimeType, bytes };
  });
}

/** Stage via CDP, then copy into memory before removing temporary files.
 * A detached staging input avoids firing change twice and preserves the wire
 * MIME type. The page sees one input/change pair on the selected live input. */
export async function uploadBrowserFiles(session: PageSession, payload: any) {
  const files = decodeUploadFiles(payload);
  const selector = payload.ref ? `[data-empir3-ref=${JSON.stringify(String(payload.ref))}]` : payload.selector || 'input[type="file"]';
  if (typeof selector !== 'string') throw new Error('Upload selector must be a string.');
  const found = await session.send('Runtime.evaluate', { expression: `(() => {
    const matches = document.querySelectorAll(${JSON.stringify(selector)});
    if (matches.length !== 1) throw new Error('Choose exactly one file input using ref or selector.');
    const input = matches[0];
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.disabled) throw new Error('Upload target must be an enabled file input.');
    if (${files.length} > 1 && !input.multiple) throw new Error('This file input does not allow multiple files.');
    return input;
  })()`, returnByValue: false });
  if (found.exceptionDetails || !found.result?.objectId) throw new Error(found.exceptionDetails?.exception?.description?.split('\n')[0] || 'File input is unavailable.');
  const inputId = found.result.objectId;
  let stagingId: string | undefined;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'empir3-upload-'));
    const paths: string[] = [];
    for (const [index, file] of files.entries()) {
      // Disk names never incorporate caller input (including Windows devices).
      const path = join(directory!, `file-${index}`);
      await writeFile(path, file.bytes, { mode: 0o600 });
      paths.push(path);
    }
    const staging = await session.send('Runtime.evaluate', { expression: `(() => { const i=document.createElement('input'); i.type='file'; i.multiple=true; return i; })()`, returnByValue: false });
    stagingId = staging.result?.objectId;
    if (!stagingId) throw new Error('Could not stage the uploaded files.');
    await session.send('DOM.setFileInputFiles', { objectId: stagingId, files: paths });
    const result = await session.send('Runtime.callFunctionOn', {
      objectId: inputId,
      functionDeclaration: `async function(staging, metadata) {
        const transfer = new DataTransfer();
        if (staging.files.length !== metadata.length) throw new Error('CDP file count mismatch.');
        for (let i=0;i<metadata.length;i++) {
          const bytes = await staging.files[i].arrayBuffer();
          if (bytes.byteLength !== metadata[i].size) throw new Error('CDP file size mismatch.');
          transfer.items.add(new File([bytes], metadata[i].filename, {type:metadata[i].mimeType}));
        }
        if (!this.isConnected || this.disabled || this.type !== 'file' || (metadata.length > 1 && !this.multiple)) throw new Error('File input changed during upload.');
        this.files = transfer.files;
        const attached = Array.from(this.files, f => ({filename:f.name,mimeType:f.type,size:f.size}));
        this.dispatchEvent(new Event('input', {bubbles:true}));
        this.dispatchEvent(new Event('change', {bubbles:true}));
        return attached;
      }`,
      arguments: [{ objectId: stagingId }, { value: files.map(f => ({ filename: f.filename, mimeType: f.mimeType, size: f.bytes.length })) }],
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || 'File attachment failed.');
    return { success: true, target: { surface: 'browser', tabId: session.targetId }, files: result.result?.value, attached: true };
  } finally {
    for (const objectId of [inputId, stagingId].filter(Boolean)) await session.send('Runtime.releaseObject', { objectId }).catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
