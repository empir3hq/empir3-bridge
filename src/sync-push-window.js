/**
 * Mirror-sync failure window (Work Board 2e0867d0).
 *
 * A bridge_job with syncFirst reported "Mirror sync before start: complete,
 * N file(s) hydrated" while a referenced script had never arrived. The
 * server counts what it SENT; the Bridge refused some of those writes
 * (blocked extension, ignored path, size) and answered each with
 * success:false, but nothing collected those refusals for the job summary.
 *
 * The tracker records refused sync writes while a syncFirst window is open
 * so the job result can list exactly which files did not land and why.
 */

'use strict';

class SyncPushFailureTracker {
  constructor(limit = 50) {
    this.limit = limit;
    this.open = false;
    this.failed = [];
    this.attempted = 0;
    this.succeeded = 0;
  }

  begin() {
    this.open = true;
    this.failed = [];
    this.attempted = 0;
    this.succeeded = 0;
  }

  /** Called with each desktop:sync:push result while a window is open. */
  record(relPath, result) {
    if (!this.open) return;
    this.attempted += 1;
    if (result && result.success !== false) { this.succeeded += 1; return; }
    if (this.failed.length >= this.limit) return;
    this.failed.push({ path: String(relPath || '(unknown)'), error: String(result?.error || 'write refused') });
  }

  /** Close the window and return the summary for the job result. */
  end(totalPushedFromServer) {
    this.open = false;
    const summary = {
      totalPushed: Number(totalPushedFromServer) || 0,
      written: this.succeeded,
      failed: this.failed.slice(),
      failedCount: this.failed.length,
    };
    return summary;
  }
}

/** Human line for a job result: says which files did not land.
 *
 * `serverPaused` (customer cards 7ed38615 / 31ae9f13): the server stopped
 * offering files mid-hydration because this machine stopped answering. The
 * files behind the stall were never sent, so they have no per-file reason and
 * never will — and for four days that case printed the sentence below about
 * a sync that had abandoned twelve projects. It is INCOMPLETE, not complete.
 */
function describeSyncOutcome(sync) {
  if (!sync || !sync.requested) return null;
  if (!sync.completed) return 'Mirror sync before start did not finish in time; the job ran on the files already on that machine.';
  const failed = Array.isArray(sync.failed) ? sync.failed : [];
  const names = failed.map((f) => `${f.path} (${f.error})`).join('; ');
  if (sync.serverPaused) {
    return `Mirror sync before start: INCOMPLETE. ${sync.written ?? 0} file(s) written, then this machine stopped answering`
      + `${sync.serverPausedAt ? ` at ${sync.serverPausedAt}` : ''} and the rest were never sent.`
      + `${failed.length ? ` Refused along the way: ${names}.` : ''}`;
  }
  if (!failed.length) return `Mirror sync before start: complete, ${sync.written ?? sync.totalPushed} file(s) written to the mirror. This covers eligible project files only; scratch folders (.qa, .e3home, .tbverify), build/dependency folders and secrets are excluded. Put job helpers in tools/ or scripts/ and verify required local paths before execution.`;
  return `Mirror sync before start: ${sync.written ?? 0} file(s) written, ${failed.length} REFUSED by this Bridge and NOT on the machine: ${names}.`;
}

module.exports = { SyncPushFailureTracker, describeSyncOutcome };
