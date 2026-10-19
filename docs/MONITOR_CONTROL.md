# Private owner monitor

The Empir3 Computer panel has separate Browser and Desktop views. Desktop
monitoring currently requires Windows; browser login handoffs stay browser-only.
Subscription lending never grants another user access to this computer.

The app uses the authenticated, exact-device `browse:monitor_frame/input` and
`gui:monitor_frame/input` transport. These are owner-panel operations, not model
tools. Agents continue to use the observed-target control tools and respect the
human-control hold. The app release must understand this protocol before it can
offer Desktop control; an old Bridge returns an update instruction.

Each frame returns a random ID bound to its viewer, surface, browser tab or
physical monitor, and capture time. Input coordinates are normalized within the
actual image, excluding letterboxing. The Bridge rejects expired frames, changed
browser tabs/viewports and changed monitor geometry. Native coordinates include
the monitor's physical origin and do not reapply an agent calibration offset.

Supported atomic inputs are click, double-click, drag, text, key/modifiers and
wheel. Buttons and keys are released even if an action fails. Native input keeps
the existing focus guard, user takeover detection, permission checks and local
pause. A desktop observation shows the local presence rim. This is periodic
screenshot viewing, not a video stream or an independent background mouse.

Private input is not returned in action receipts. Native frame files, including
intermediate resize candidates, are removed after their buffers are read.
Browser recording must be stopped before private monitoring; existing recordings
are preserved. A login handoff resolves the agent's existing tab as human input,
without acquiring it for an agent or overriding the human-focus block on agents.

The app owns the exclusive viewer lease, queue ordering and hand-back; the Bridge
owns its frame binding, local permissions and atomic native/CDP dispatch. Input
is never retried automatically. Timing and queue limits use the app's Admin
Limits and the Bridge's existing Control limits.

## Acceptance

`node --test test/monitor-control.test.mjs` checks validation, lifetime, binding,
coordinate origins and release-on-error. `node scripts/smoke-monitor-control.mjs`
starts an isolated source browser and verifies real browser events plus private
handoff/recording boundaries. On Windows, add `--run-interactive` for a disposable
native window, text/shortcut/click/right/double/drag/wheel and secondary display
checks. It never types into a user's existing app or uses the clipboard.

Set `EMPIR3_TEST_RUNTIME_ROOT` to an extracted candidate to run the same acceptance
against packaged bytes. Set `EMPIR3_MONITOR_TEST_READY` to a private output file
to keep the isolated runtime available for the app's opt-in
`monitorControl.live.test.ts`; write `finish` into the reported state directory
to stop it. Readiness data contains a local test nonce and must remain private.
That app test clicks the real React panel and real route handlers against this
Bridge, while using synthetic ownership/authentication. Production relay and
installed Computer-panel acceptance are separate release gates.
