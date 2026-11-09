import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliTurnJournal, CliTurnReceipt, CliJournalOutcome } from './cli-turn-journal.js';
import type { CliJobFactory, CliJobControl } from './cli-job-supervisor.js';

type ProviderId = 'claude' | 'codex' | 'gemini' | 'grok' | 'agy';

interface TurnState {
  provider: ProviderId;
  cancelled: boolean;
  closed: boolean;
  issued: boolean;
  jobs: CliJobControl[];
  journal?: { store: CliTurnJournal; receipt: CliTurnReceipt; binding: string };
  journalFault?: unknown;
}

/** Original admission identity, captured before any asynchronous setup.
 * The production Bridge supplies a durable journal; unit fixtures may omit it.
 * A closed/cancelled callback cannot borrow the identity of a later turn with
 * the same wire ID. This is a spawn fence, not proof of remote termination. */
export class CliTurnLifecycle {
  private readonly turns = new Map<string, TurnState>();
  private readonly context = new AsyncLocalStorage<TurnState>();
  constructor(private readonly persistence?: (provider: ProviderId) => { store: CliTurnJournal; binding: string },
    private readonly supervise?: CliJobFactory) {}

  begin(provider: ProviderId, id: string, payload?: unknown) {
    if (!id || id.length > 200) throw new Error('Invalid CLI turn identity');
    const key = JSON.stringify([provider, id]);
    if (this.turns.has(key)) throw new Error('CLI turn identity is already active');
    const persistence = this.persistence?.(provider);
    const state: TurnState = { provider, cancelled: false, closed: false, issued: false, jobs: [],
      ...(persistence ? { journal: { ...persistence, receipt: persistence.store.prepare(persistence.binding, provider, id, payload, this.supervise ? 'windows-job-v1' : undefined) } } : {}) };
    this.turns.set(key, state);
    return {
      run: <T>(work: () => T): T => this.context.run(state, work),
      assertCanStart: () => this.assertState(state),
      close: (outcome: CliJournalOutcome = 'error') => {
        state.closed = true;
        this.cancelJobs(state);
        if (this.turns.get(key) === state) this.turns.delete(key);
        if (state.journalFault) throw Error('CLI execution journal failed');
        state.journal?.store.finish(state.journal.receipt, outcome);
      },
    };
  }

  cancel(provider: ProviderId, id: string): boolean {
    const state = this.turns.get(JSON.stringify([provider, id]));
    if (!state) return false;
    state.cancelled = true;
    this.cancelJobs(state);
    // A storage failure must never prevent the caller from killing the child.
    // Keep the in-memory fence and refuse a successful completion receipt.
    try { state.journal?.store.cancel(state.journal.receipt); }
    catch (error) { state.journalFault = error; }
    return true;
  }

  /** Local CLI utilities outside a relay turn keep their own admission. */
  assertCanSpawn(): void {
    const state = this.context.getStore();
    if (state) {
      this.assertState(state);
      state.journal?.store.issue(state.journal.receipt);
      state.issued = true;
    }
  }

  /** Both ordinary children and ConPTY creation cross this same boundary.
   * Local utilities outside an admitted relay turn retain their own behavior. */
  spawn<T extends object, O extends { cwd?: string; env?: NodeJS.ProcessEnv }>(command: string, args: string[], options: O,
    spawn: (command: string, args: string[], options: O) => T, terminal = false): T {
    this.assertCanSpawn();
    const state = this.context.getStore();
    if (!state || !this.supervise) return spawn(command, args, options);
    if (!state.journal) throw Error('CLI containment requires a durable admission');
    if (state.jobs.length >= 32) throw Error('CLI execution attempt limit reached');
    const nonce = state.journal.store.registerAttempt(state.journal.receipt);
    const launch = this.supervise(command, args, options, state.journal.receipt, nonce);
    state.jobs.push(launch);
    try {
      this.assertState(state);
      state.journal.store.issueAttempt(state.journal.receipt, nonce);
      // libuv otherwise kills its children when the daemon exits. The helper
      // must survive to accept the permanent cancellation and record a proof.
      // ConPTY has a separate console lifetime; loss without proof stays held.
      const owner = spawn(launch.command, launch.args, terminal ? options : { ...options, detached: true });
      launch.attach(owner);
      return owner;
    } catch (error) { launch.discardLaunch(); throw error; }
  }

  private cancelJobs(state: TurnState): void {
    for (const job of state.jobs) {
      try { job.cancel(); } catch (error) { state.journalFault = error; }
    }
  }

  /** Pin before accepting HTTP; request callbacks must not adopt another turn. */
  captureToolAuthority(): () => void {
    const state = this.context.getStore();
    if (!state) throw Error('CLI tool server requires an admitted turn');
    return () => {
      this.assertState(state);
      const saved = state.journal?.store.inspect(state.journal.receipt);
      if (!state.issued || (saved && (saved.phase !== 'issued' || saved.cancelled))) throw Error('CLI execution has not started or was cancelled');
    };
  }

  private assertState(state: TurnState): void {
    if (state.cancelled) throw new Error('CLI turn was cancelled before process start');
    if (state.closed) throw new Error('CLI turn has already settled');
    if (state.journalFault) throw Error('CLI execution journal failed');
    if (state.journal) {
      const current = this.persistence?.(state.provider);
      if (current?.store !== state.journal.store || current.binding !== state.journal.binding) throw Error('CLI enrollment identity changed');
    }
  }
}
