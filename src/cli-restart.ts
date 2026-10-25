export type CliRestartState = 'queued' | 'updating' | 'preparing' | 'restarted' | 'needs_user_action';
export interface CliRestartReceipt {
  provider: string;
  state: CliRestartState;
  requestedAt: number;
  completedAt?: number;
  version?: string;
  ready?: boolean;
  message: string;
  operation: 'restart' | 'update';
  pending: boolean;
  warnings?: string[];
}

/** CLI sessions are spawned per turn. Restart drains one provider, then starts
 * a fresh executable probe for its next session; it never kills user work. */
export class CliRestartCoordinator {
  private readonly receipts = new Map<string, CliRestartReceipt>();
  constructor(private readonly hooks: {
    supported: (provider: string) => boolean;
    pause: (provider: string) => (() => void) | null;
    busy: (provider: string) => boolean;
    prepare: (provider: string) => Promise<{ version: string; ready: boolean; message: string }>;
    update?: (provider: string, progress: (message: string) => void) => Promise<{ warnings?: string[] }>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    drainTimeoutMs?: number;
    settled?: (provider: string) => void;
  }) {}

  status(provider: string): CliRestartReceipt | null {
    const value = this.receipts.get(provider);
    return value ? { ...value } : null;
  }

  request(provider: string, operation: 'restart' | 'update' = 'restart'): CliRestartReceipt {
    if (!this.hooks.supported(provider)) throw new Error('Unsupported CLI provider.');
    if (operation === 'update' && !this.hooks.update) throw new Error('CLI update is unavailable.');
    const previous = this.receipts.get(provider);
    if (previous?.pending) {
      if (previous.operation !== operation) throw new Error('Another lifecycle action is pending for this CLI.');
      return { ...previous };
    }
    const release = this.hooks.pause(provider);
    if (!release) throw new Error('Another lifecycle action is preparing this CLI.');
    const now = this.hooks.now || Date.now;
    const receipt: CliRestartReceipt = {
      provider, operation, pending: true, state: 'queued', requestedAt: now(),
      message: operation === 'update'
        ? 'Update queued. Existing work will finish before updating and preparing the next CLI session.'
        : 'Restart queued. Existing work will finish before the next CLI session is prepared.',
    };
    this.receipts.set(provider, receipt);
    void this.run(receipt, release);
    return { ...receipt };
  }

  private async run(receipt: CliRestartReceipt, release: () => void) {
    const now = this.hooks.now || Date.now;
    const wait = this.hooks.wait || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    try {
      while (this.hooks.busy(receipt.provider)) {
        if (now() - receipt.requestedAt >= (this.hooks.drainTimeoutMs ?? 10 * 60_000)) {
          throw new Error('Work is still active. The requested action was not performed; request it again when the CLI is idle.');
        }
        await wait(500);
      }
      if (receipt.operation === 'update') {
        receipt.state = 'updating';
        receipt.message = 'Updating the CLI. Bridge will verify and prepare its next session automatically.';
        const updated = await this.hooks.update!(receipt.provider, message => {
          receipt.state = 'needs_user_action';
          receipt.message = message;
        });
        receipt.warnings = updated.warnings;
      }
      receipt.state = 'preparing';
      receipt.message = 'Preparing the next CLI session and checking the installed executable.';
      const result = await this.hooks.prepare(receipt.provider);
      receipt.version = result.version;
      receipt.ready = result.ready;
      receipt.state = result.ready ? 'restarted' : 'needs_user_action';
      receipt.message = result.message;
    } catch (error) {
      receipt.state = 'needs_user_action';
      receipt.ready = false;
      receipt.message = error instanceof Error ? error.message : 'CLI preparation failed. Retry when the CLI is idle.';
      // Failed cleanup is visible promptly, but it must not release admission
      // while the exact version-probe process remains alive.
      const cleanupPending = (error as { cleanupPending?: Promise<void> })?.cleanupPending;
      if (cleanupPending) await cleanupPending;
    } finally {
      receipt.completedAt = now();
      receipt.pending = false;
      release();
      try { this.hooks.settled?.(receipt.provider); } catch { /* reporting cannot undo local completion */ }
    }
  }
}
