# FinishLine: Agent Box Bridge last-tab close forward fix

## Evidence

- Signed 0.3.101 updated the real Linux Agent Box successfully and fixed its
  headless update route, but live verification found one remaining close edge:
  closing Chrome's only page also ended the CDP listener, so the confirmation
  poll returned `ECONNREFUSED` instead of recognizing completed closure.
- 0.3.102 treats a CDP read failure as close evidence only when the independent
  Chrome process-exit state is also present. A CDP error while Chrome is still
  alive remains inconclusive and continues polling to the existing timeout.

## Verification

- Focused browser action contract: 4 passed.
- TypeScript `tsc --noEmit`: passed.
- Root suite: 430 passed, 0 failed, 4 POSIX-only skips.
- Desktop shell suite: 51 passed.
- Headless package suite: 2 passed.
- Isolated real Chrome last-tab close: `success:true`, `closed:true`, exact
  target absent, zero remaining page targets.
- Linux Agent Box confirmation and full signed release matrix: pending 0.3.102
  packaging and deployment.

## Invariants

- Never treat CDP unavailability alone as successful close.
- Never close or relaunch another agent's target.
- Do not overwrite 0.3.101 artifacts; this correction is a new version.
- Operator-pool CLI billing remains API-equivalent and unchanged.
