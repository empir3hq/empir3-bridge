# Publishing the native channel independently

Private maintainers must first read `docs/internal/RELEASE_OPERATIONS.md` when
present. An explicit native-channel promotion can publish an already verified
unified native package while a newer Windows Go-bootstrap payload follows its
own scoped release. Record the actual versions of both channels separately.
This mode grants no authority to publish or interrupt installed clients.

Prepare the production live/100 index from the unchanged native receipts. Use
`release:promote-desktop` with the genuine authenticated schema-2 payload manifest
of the **same version** as that index. The promoter retains its existing schema,
version equality and signing checks; it writes both manifest files locally.
Keep this output in a separate explicit candidate directory. Never relabel an
older payload or reference missing dependencies.

The candidate directory must contain every native artifact/index and the real
signed payload and Node archives/signatures referenced by its schema-3 manifest.
The explicit publisher verifies their hashes and detached signatures. It uploads
these immutable dependencies without activating the legacy Windows channel.
An existing immutable name may be reused only with identical bytes.

```powershell
npm run publish:downloads -- --desktop-only --dist <native-candidate> --prestage --dry-run
npm run publish:downloads -- --desktop-only --dist <native-candidate> --prestage
```

Pre-stage writes no fixed metadata. Its receipt binds the explicit mode, target,
artifact/dependency/index hashes and exact fixed-file inventory. Capture the
published legacy manifest, stable bootstrap and Node hashes before and after.
Bridge-only publication leaves the app live and does not require site
maintenance or a global session drain. App deployments that restart servers
retain their maintenance and session-drain requirements. Activate the verified
native candidate:

```powershell
npm run publish:downloads -- --desktop-only --dist <native-candidate> --finalize
```

Only fixed `RELEASES` and `bridge-desktop-version.json` are activated, in that
order, with public hash verification. `bridge-version.json` and `Empir3Setup.exe`
are never uploaded by this mode. It requires the actual desktop manifest file,
schema 3 and production live/100 metadata; legacy fallback, implicit activation,
payload-only combination and authentication overrides are refused. An ordinary
full live publication without this flag retains its existing behavior.

A subsequent Windows payload release follows `docs/PAYLOAD_RELEASE.md`, including
its exact published-base, bootstrap and Node checks at activation. Native desktop
and headless clients use their target-specific authenticated artifact entries;
the Go-bootstrap payload does not update those clients. Public source, GitHub
Release and npm versions must be recorded explicitly, without claiming a later
Windows-only runtime fix is present in older native or npm packages.
