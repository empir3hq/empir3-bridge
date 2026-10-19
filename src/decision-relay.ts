import { randomUUID } from 'node:crypto';

export const DECISION_RELAY_TIMEOUT_MS = 35_000;
const DISCONNECTED = 'This Bridge is not connected to Empir3.';

/** One request on the paired socket, never queued or retried on reconnect. */
export class DecisionRelay {
  private pending = new Map<string, {
    resolve: (result: any) => void;
    timer: ReturnType<typeof setTimeout>;
    requestChars: number;
  }>();

  constructor(
    private send: (type: string, payload: any) => boolean,
    private isOpen: () => boolean,
    private timeoutMs = DECISION_RELAY_TIMEOUT_MS,
    private log: (message: string) => void = message => console.warn(message),
  ) {}

  request(body: any): Promise<any> {
    if (!this.isOpen()) return Promise.resolve({ success: false, code: 'NOT_CONNECTED', error: DISCONNECTED });
    const requestId = `act-${randomUUID()}`;
    const payload = { requestId, purpose: 'browser_act', state: body?.state, questions: body?.questions };
    const requestChars = JSON.stringify(payload).length;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.result({ requestId, success: false, code: 'TIMEOUT', error: 'Empir3 did not answer the decision within 35 seconds.' }), this.timeoutMs);
      this.pending.set(requestId, { resolve, timer, requestChars });
      try {
        if (this.send('decision:request', payload)) return;
      } catch { /* A send failure has the same no-queue outcome as a closed socket. */ }
      this.result({ requestId, success: false, code: 'NOT_CONNECTED', error: DISCONNECTED });
    });
  }

  result(payload: any): boolean {
    const entry = this.pending.get(payload?.requestId);
    if (!entry || typeof payload?.success !== 'boolean') return false;
    clearTimeout(entry.timer);
    this.pending.delete(payload.requestId);
    if (payload.code === 'INVALID_REQUEST' || payload.code === 'TOO_LARGE') {
      this.log(`[Empir3 decision] ${payload.code}; request size ${entry.requestChars} characters`);
    }
    entry.resolve(payload);
    return true;
  }

  close() {
    for (const requestId of this.pending.keys()) {
      this.result({ requestId, success: false, code: 'NOT_CONNECTED', error: DISCONNECTED });
    }
  }
}
