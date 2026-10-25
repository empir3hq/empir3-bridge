/**
 * Reliability-smoke result contract.
 *
 * bridge_reliability_smoke used to return `{ ok, passed, total, checks }` with
 * no `success` and no `error`. Two things went wrong with that shape on a host
 * without desktop control: the MCP layer saw `ok:false`, found no error text
 * and surfaced a bare "Command failed"; while the action-log receipt only
 * looked at `success !== false`, saw undefined, and recorded `ok:true`. The
 * caller and the audit trail disagreed about the same call.
 *
 * This module owns the two decisions so they cannot drift again:
 *   - summarizeSmokeChecks(): one result object with success/ok agreeing,
 *     a human-readable `error` naming the failed checks, and skipped checks
 *     (not applicable on this host) counted separately from failures.
 *   - receiptOutcome(): how a command result maps onto the action-log
 *     receipt's ok/error, honouring both `success:false` and `ok:false`.
 *
 * Plain CommonJS so `node --test` can import it without a TS loader.
 */

'use strict';

/**
 * @param {Array<{name:string, ok:boolean, skipped?:boolean, reason?:string, detail?:any}>} checks
 * @param {object} [context] extra fields merged into the result (e.g. desktop availability)
 */
function summarizeSmokeChecks(checks, context = {}) {
  const list = Array.isArray(checks) ? checks : [];
  const skipped = list.filter((c) => c.skipped === true);
  const applicable = list.filter((c) => c.skipped !== true);
  const failed = applicable.filter((c) => !c.ok);
  const passed = applicable.length - failed.length;
  const ok = failed.length === 0;
  const error = ok
    ? undefined
    : `${failed.length} of ${applicable.length} reliability check(s) failed: ${failed.map((c) => `${c.name} (${describeFailure(c)})`).join('; ')}`;
  return {
    success: ok,
    ok,
    passed,
    failed: failed.length,
    skipped: skipped.length,
    total: applicable.length,
    checks: list,
    ...(skipped.length ? { skippedChecks: skipped.map((c) => ({ name: c.name, reason: c.reason || '' })) } : {}),
    ...(error ? { error, failures: failed.map((c) => ({ name: c.name, error: describeFailure(c) })) } : {}),
    ...context,
  };
}

function describeFailure(check) {
  const detail = check?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && typeof detail === 'object') {
    if (typeof detail.error === 'string' && detail.error) return detail.error;
    if (typeof detail.message === 'string' && detail.message) return detail.message;
  }
  return check?.reason || 'check did not pass';
}

/**
 * What the action-log receipt should record for a command result. A result
 * is a failure when it says so through either convention (`success:false`
 * from the wrapper, `ok:false` from older CDP/bridge shapes); the receipt then
 * carries the result's own error text so the log matches what the caller saw.
 */
function receiptOutcome(result) {
  const failed = !!result && typeof result === 'object' && (result.success === false || result.ok === false);
  if (!failed) return { ok: true, error: undefined };
  const error = typeof result.error === 'string' && result.error
    ? result.error
    : 'command reported failure without an error message';
  return { ok: false, error };
}

module.exports = { summarizeSmokeChecks, receiptOutcome };
