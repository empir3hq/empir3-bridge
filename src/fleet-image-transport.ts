import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/** Native fetch's independent header timeout is shorter than the fleet queue.
 * No retries or redirects: a POST may already have started GPU work. */
export function fetchFleetImage(url: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'POST', headers, signal }, incoming => {
      try {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        // Response forbids a body for these statuses, even an empty stream.
        // Keep protocol failures inside the provider outcome, not an uncaught
        // exception from this asynchronous HTTP callback.
        const noBody = [204, 205, 304].includes(incoming.statusCode!);
        const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (noBody) incoming.resume();
        resolve(new Response(body, { status: incoming.statusCode, headers: responseHeaders }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(body);
  });
}
