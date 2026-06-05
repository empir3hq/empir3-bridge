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

The helper uploads the release artifacts to `$EMPIR3_DOWNLOAD_HOST:$EMPIR3_DOWNLOAD_DIR`, then verifies they are live:

```text
https://app.empir3.com/downloads/Empir3Setup.exe
https://app.empir3.com/downloads/bridge-version.json
```

## Release Rule

Do not ship bridge source changes without also checking whether they affect the Windows installer path. If the change affects runtime behavior, bump `package.json`, build the Windows payload, publish `bridge-version.json`, and smoke the tray version line after install/update.

This release process is self-contained — it publishes the bridge payload + installer and is separate from any Empir3 app deploy. Do not use app deploy scripts (`deploy.ps1` / `deploy.sh`) for bridge releases.

## Two Distribution Channels — Keep Them In Sync

This private staging repo (`empir3labs/empir3-bridge-staging`) is the single source of truth. Two **independent, manual** pipelines fan out from it, and they drift if you update one and forget the other:

| Channel | Tool | Target | What it is |
|---|---|---|---|
| **Public source** | `scripts/export-public.mjs` | `empir3hq/bridge` | A scrubbed, zero-history snapshot users clone / read (install-from-source path). |
| **Runtime payload** | `build:windows` + `publish:downloads` | `app.empir3.com/downloads` | The signed payload installed daemons auto-update from. |

`git push` to staging updates **neither** channel.

### The coupling rule

**Any change to runtime behavior ships to BOTH channels in the same pass**, or the public source and the running binary diverge. Doc-only changes (README, this file) don't need a payload publish — they can ride the next HQ export.

One ordered checklist per runtime release:

1. **Verify** the change live (alt-port `tsx` instance — never disturb the installed daemon).
2. **Bump** `package.json` (the payload + HQ snapshot both carry it; it's how daemons detect updates — never publish two builds under the same version).
3. **Build + publish payload**: `build:windows` → `publish:downloads -- --dry-run` → `publish:downloads`.
4. **Export + push HQ from the same commit**: `export-public.mjs` → eyeball any new images (the scanner can't read them) → in `build/public-export/`, `git init` → commit **as "Empir3 Labs"** (never the maintainer's personal git identity — the export scanner hard-fails on it) → push to `empir3hq/bridge`.
5. **Verify parity**: tray version == live `bridge-version.json` == HQ `package.json`.

The `Empir3Setup.exe` distribution stays gated on Authenticode signing; publishing the payload updates already-installed daemons regardless.
