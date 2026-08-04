# Release And Download Pipeline

This repo is the canonical source for the open-source bridge and the Windows download.

Normal users install from:

```text
https://empir3.com/download
```

The direct artifact path is:

```text
https://app.empir3.com/downloads/Empir3Setup.exe
```

## Version Source

`package.json` is the bridge payload version source of truth.

The tray menu displays the active payload version read from the downloaded payload. The public update manifest is:

```text
https://app.empir3.com/downloads/bridge-version.json
```

Do not guess the next version from this document. Before release, check both:

```bash
node -p "require('./package.json').version"
curl -fsS https://app.empir3.com/downloads/bridge-version.json
```

If runtime behavior changes, bump `package.json`, build, dry-run publish, publish, then verify the live manifest reports the new version.

## Build

```bash
npm install
npm run build:windows
```

Build output lands in `build/dist/`:

- `Empir3Setup.exe`
- `bridge-payload-vX.Y.Z.tar.gz`
- `bridge-payload-vX.Y.Z.sig`
- `bridge-version.json`
- `empir3-bridge.crx`
- `empir3-bridge-update.xml`

`Empir3Setup.exe` is the stable bootstrapper. The payload tarball contains the actual bridge runtime, installer UI, extension, and tray wrapper.

### Authenticode

The build Authenticode-signs `Empir3Setup.exe` when the maintainer signing
tooling is present; without it the build only WARNS and produces an unsigned
exe (fine for development — the release channel serves the signed installer).
**Releases must sign**: run the build with `EMPIR3_REQUIRE_SIGNED=1` so an
unsigned exe fails the build instead of silently shipping a
SmartScreen-flagged binary.

## Publish

Dry run:

```bash
npm run publish:downloads -- --dry-run
```

Publish (the deploy target comes from the environment — it is not hardcoded in the repo):

```bash
export EMPIR3_DOWNLOAD_HOST=user@your-host
export EMPIR3_DOWNLOAD_DIR=/var/www/your-app/downloads
npm run publish:downloads
```

When only an SSH jump host can authenticate to the private download host, set
the optional jump host instead of copying artifacts by hand:

```bash
export EMPIR3_DOWNLOAD_JUMP_HOST=user@your-jump-host
export EMPIR3_DOWNLOAD_HOST=user@private-download-host
export EMPIR3_DOWNLOAD_DIR=/var/www/your-app/downloads
npm run publish:downloads
```

The helper stages each local file on the jump host, copies it onward, and still
performs every checksum and atomic-swap gate on the final download host.

The helper uploads the release artifacts to `$EMPIR3_DOWNLOAD_HOST:$EMPIR3_DOWNLOAD_DIR`, then verifies they are live:

```text
https://app.empir3.com/downloads/Empir3Setup.exe
https://app.empir3.com/downloads/bridge-version.json
```

## Release Rule

Do not ship bridge source changes without also checking whether they affect the Windows installer path. If the change affects runtime behavior, bump `package.json`, build the Windows payload, publish `bridge-version.json`, and smoke the tray version line after install/update.

This release process is self-contained — it publishes the bridge payload + installer and is separate from any Empir3 app deploy. Do not use app deploy scripts (`deploy.ps1` / `deploy.sh`) for bridge releases.

Maintainer note: distribution-channel internals (staging repo layout, public
export pipeline, per-release checklist) live in `docs/internal/CHANNELS.md`,
which does not ship in this repo's public form.
