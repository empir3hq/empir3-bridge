# Windows payload updates

Use this lane for Windows Go-bootstrap installations when only the runtime is
changing. It reuses the existing signed installer and tray, pinned Node runtime,
and native dependencies. No Azure sign-in is required. The new payload and
manifest still require the Bridge Ed25519 release key.

Electron desktop uses platform installers; Linux headless has its own archive
channel. This payload does not update either. Private maintainers must also
read `docs/internal/RELEASE_OPERATIONS.md` when present.

## Build

Merge reviewed runtime changes into the keeper checkout. Assign a fresh version
and update all three package versions using the release runbook. Retain the
current published `bridge-version.json`, `Empir3Setup.exe`, payload archive and
signature, and Node archive and signature in a separate base directory. Record
the exact source commit for that release. Old local builds may not match the
published files.

Run the shared checks, then replace the following example arguments with that
base directory and source commit:

```powershell
npm run build:payload -- --reuse-release C:\releases\bridge-base --reuse-ref <base-commit> --check
npm run build:payload -- --reuse-release C:\releases\bridge-base --reuse-ref <base-commit>
```

Preflight verifies base signatures, source compatibility and bundle inputs
without reading the private key. Full build copies the signed tray and complete
node-pty runtime from the authenticated base archive. Bootstrap/tray source,
Node pin, native dependency or trust-root changes require a full release. The
new native file inventory must match the base exactly.

Output is isolated in `build/payload-only/v<version>/dist`. Existing candidate
directories are refused. Failed builds and preflight outputs are retained;
archive a failed candidate before rebuilding that unpublished version. Never
replace published bytes under the same version.

## Publish

Set the normal `EMPIR3_DOWNLOAD_HOST` and `EMPIR3_DOWNLOAD_DIR` for the existing
download origin. Its Node artifacts, installer and legacy manifest must match
the recorded base. No app-server container deployment is involved.

```powershell
npm run publish:payload -- --dist build/payload-only/v<version>/dist --prestage --dry-run
npm run publish:payload -- --dist build/payload-only/v<version>/dist --prestage
```

Pre-stage uploads only the new payload and detached signature, verifies public
hashes, and writes a candidate/target receipt. Existing immutable files cannot
be replaced. Installed Bridges receive no update instruction yet.

The publisher runs a fresh native Windows Defender check before either phase,
including dry runs. It scans the unpacked payload and the referenced archives
and bootstrap, requires antivirus/real-time protection, checks detections, and
verifies every scanned file still exists with the same hash. A completed scan
that quarantined or remediated a file fails the gate. A successful check writes
`payload-defender-receipt.json`; it is diagnostic evidence, never a reusable
authorization to skip the next scan. Missing Defender access also fails closed.

Verify the packaged candidate using the existing isolated Windows acceptance
procedure. Record health, tool calls, tray, relay reconnect and retained settings.
Keep the previous release. Bridge-only updates leave the app live and do not
require site maintenance or a global session drain. Maintenance and session
draining still apply to app deployments that restart servers. Activate the
verified Bridge candidate:

```powershell
npm run publish:payload -- --dist build/payload-only/v<version>/dist --finalize --dry-run
npm run publish:payload -- --dist build/payload-only/v<version>/dist --finalize
```

Finalize requires an unused matching receipt, rechecks referenced artifacts and
the previous legacy manifest, then switches only `bridge-version.json`. It
preserves `bridge-desktop-version.json`, native packages and `Empir3Setup.exe`.
The two channels may have different versions until the next unified release.
If the base changed, rebase/rebuild the candidate instead of bypassing the gate.

Verify installed payload version, settings, tray, relay reconnect and real tool
calls while the app remains live. Record Windows-only scope and deferred platform
and app work on the Work Board. Bootstrap and payload versions remain separate;
a payload does not replace a cached bootstrap. Use a new forward-fix version if
no previously verified rollback procedure applies.
