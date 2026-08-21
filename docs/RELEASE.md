# Release And Download Pipeline

This repo is the canonical source for one Bridge release identity and its
platform artifacts:

- Windows x64 Electron Setup/Squirrel/ZIP plus the backward-compatible Go
  bootstrap payload;
- macOS universal Electron DMG/ZIP;
- Linux desktop x64 and ARM64 DEB/ZIP;
- Linux headless x64 and ARM64 tarballs.

Normal users install from `https://empir3.com/download`. Production artifacts
live under `https://app.empir3.com/downloads/`, but unsigned test packages must
never be copied there.

## Version And Channels

`package.json` is the Bridge version source of truth. `desktop-shell/package.json`
must report the same version. Check the source and both production channels
before a release:

```bash
node -p "require('./package.json').version"
node -p "require('./desktop-shell/package.json').version"
curl -fsS https://app.empir3.com/downloads/bridge-version.json
curl -fsS https://app.empir3.com/downloads/bridge-desktop-version.json
```

The channels have different compatibility jobs:

- `bridge-version.json` is the legacy Windows bootstrap channel. Existing
  bootstrappers depend on its original four fields.
- `bridge-desktop-version.json` is the schema 3 desktop/headless rollout
  channel. It carries the hash-pinned artifact index, target health, signing
  state, deterministic rollout percentage, hold state, and rollback policy.

Held, staged, and rollback builds write only the desktop channel. Only a
schema 3 release that is `live` at 100% may promote identical signed bytes to
the legacy channel.

## Build And Verify

Install both dependency sets, then run the shared checks:

```bash
npm install
npm run desktop:install
npx tsc --noEmit
npm run build:mcp
npm test
npm run desktop:test
```

Build the legacy Windows bootstrap payload when runtime behavior changes:

```bash
npm run build:windows
```

On the maintained Windows signing host, verify both
`build/dist/Empir3Tray.exe` and `build/payload-staging/Empir3Tray.exe` have a
valid production-publisher Authenticode signature, then run a Microsoft Defender
custom scan over both files and the final payload archive. Any new detection is
a release blocker; do not add an antivirus exclusion or publish around it.

Build native desktop artifacts on their native CI/host operating system:

```bash
npm run desktop:make
npm run desktop:package-smoke
npm run desktop:artifacts
```

Normal pushes and pull requests intentionally run only the fast Ubuntu/Node 20
check. Start the complete compatibility, desktop-shell, native-package, and
universal-index gate once per release candidate:

```bash
gh workflow run ci.yml --ref main
```

Wait for that dispatched run to pass before collecting its receipts. Do not
use a throwaway push to start native packaging; pushes no longer build release
artifacts. Superseded routine checks are cancelled automatically, while an
explicit release run is never cancelled by a later push.

The native CI matrix also installs the artifact through its real distribution
format and then removes/reinstalls it:

```bash
npm run desktop:installer-smoke:windows
npm run desktop:installer-smoke:macos
npm run desktop:installer-smoke:linux
npm run desktop:update-smoke:linux
npm run desktop:update-smoke:macos
```

Each command refuses the wrong operating system. Windows and Linux refuse a
pre-existing package, and local non-CI runs require the explicit opt-in named
in `docs/TESTING.md`.

Build the Linux headless package on Linux x64 and Linux ARM64:

```bash
npm run headless:make
npm run headless:smoke
```

After downloading the four native receipts into one new directory, stage the
held universal set:

```bash
npm run desktop:artifacts:index -- \
  --receipts /path/to/receipt-root \
  --stage-dir /new/staged-release-directory
```

The aggregator refuses missing or duplicate targets, mixed versions, unknown
architectures, and any byte-count or SHA-256 mismatch. It distinguishes
desktop Linux from headless Linux and writes stable public filenames only after
verifying the exact source artifact.

## Live Acceptance Gates

Before signing, run the protected packaged acceptance described in
`docs/TESTING.md`:

- one real local/in-house OpenAI-compatible endpoint;
- one real built-in BYO API key;
- every supported and authenticated subscription CLI available to the test
  account;
- the complete Linux headless install/reboot/update/rollback/failure/purge
  lifecycle on a disposable VM.

CI's deterministic provider and Codex-compatible fixtures are required on
every target, but they do not replace these real credential/account gates.

## Signing And Notarization

Production release is fail-closed:

- Run `npm run release:signing-preflight` on each native signing host first.
- Windows Electron/Squirrel artifacts use Azure Trusted Signing when
  `EMPIR3_SIGN_WINDOWS=1`; the legacy Go bootstrap and the nested PyInstaller
  tray additionally use `EMPIR3_REQUIRE_SIGNED=1`. Never publish a Windows
  payload whose internal `Empir3Tray.exe` is unsigned: Defender can quarantine
  that nested executable during extraction even though the outer tarball has a
  valid release signature, leaving a current daemon with no tray icon.
- macOS packages must be Developer ID-signed, submitted to Apple notarization,
  accepted, and stapled. Set `EMPIR3_SIGN_MACOS=1`,
  `EMPIR3_MAC_SIGN_IDENTITY`, and exactly one supported notary credential
  strategy accepted by the release workflow. The manual **Signed macOS
  candidate** workflow provides the hosted native-Mac build/test environment;
  it retains a candidate for 14 days and never publishes it.
- Linux artifacts must carry the release signature/checksum contract used by
  the signed schema 3 manifest; repository metadata must be signed if/when an
  apt repository is introduced.
- Every artifact must also pass its packaged-host health smoke before the
  universal index can mark that target healthy.

After Windows/macOS packaging, record a signed receipt only after native
verification succeeds:

```bash
EMPIR3_RELEASE_SIGNED=1 npm run desktop:artifacts
```

For the production index, Windows and macOS receipts must already report their
verified platform signatures. Linux may be authenticated by the signed schema
3 manifest only through the explicit production-only flag:

```bash
npm run desktop:artifacts:index -- \
  --receipts /path/to/signed-native-receipts \
  --stage-dir /new/production-stage \
  --channel production \
  --authenticate-linux-with-manifest
```

That option is rejected for test channels. It does not claim a Linux OS-native
signature: it records `ed25519-manifest-sha256`, and the exact index hash is
then covered by the release manifest's production Ed25519 signature. Windows
and macOS still require their operating-system platform signatures.

When the signed Windows payload was built before the final native receipt set,
promote that already-signed schema 2 release to the universal schema 3 channel
without rebuilding or replacing its payload bytes:

```bash
npm run release:promote-desktop -- \
  --artifact-index /path/to/universal-artifact-index.json
```

The promotion command verifies the existing manifest against the production
trust root, requires a production live/100 artifact index for the same version,
preserves the payload and Node hashes verbatim, signs the schema 3 manifest, and
writes byte-identical desktop and legacy manifests. The publisher now refuses a
legacy-only release by default so website-installed Bridges cannot silently lag
behind the Windows bootstrap lane. `--allow-legacy-only` is an explicit emergency
override, not the normal release path.

## Publish

Publishing the production manifest is a fleet-wide restart trigger, not a
passive file upload. Installed Bridges poll it and may restart their tray and
daemon as soon as a newer version appears. Complete all builds, tests, signing,
and the dry-run before entering the live publication window.

### Required Empir3 maintenance window

1. Open `https://app.empir3.com/admin/maintenance`, enable Maintenance mode,
   leave the admin bypass enabled for release verification, and wait for
   **Sessions still finishing** to reach zero.
2. Publish the already-tested artifacts exactly once.
3. Verify the local and Vault Bridges report the new version, reconnect to
   Empir3, and restore their visible console after the restart. When the
   bootstrap version changed, run the newly signed `Empir3Setup.exe` on each
   maintained Windows host and verify the stable `%APPDATA%\Empir3\Empir3Setup.exe`
   reports the intended `--bootstrap-version` plus a valid publisher
   Authenticode signature; a current payload alone is not a bootstrap receipt.
4. Disable Maintenance mode and verify the platform reports live again.

Do not replace payload bytes under an already-published semantic version. A
Bridge that has cached that version may correctly skip the replacement; publish
any correction as a newer version instead.

Always dry-run first:

```bash
npm run publish:downloads -- --dry-run
```

The production publisher requires the deployment target from the environment:

```bash
export EMPIR3_DOWNLOAD_HOST=user@your-host
export EMPIR3_DOWNLOAD_DIR=/var/www/your-app/downloads
npm run publish:downloads
```

When a jump host is required:

```bash
export EMPIR3_DOWNLOAD_JUMP_HOST=user@your-jump-host
export EMPIR3_DOWNLOAD_HOST=user@private-download-host
export EMPIR3_DOWNLOAD_DIR=/var/www/your-app/downloads
npm run publish:downloads
```

The publisher first verifies the manifest against the production trust root,
the recognized authentication scheme for every target, and every local hash.
It uploads each artifact, then the versioned index, and atomically swaps the
signed manifest last. Preserve at least one prior manifest/artifact set for
signed rollback.

After publication, verify the website selects the exact OS/architecture target
and verify both manifest URLs directly. Do not use Empir3 app deployment
scripts for a Bridge release; the Bridge publisher is a separate pipeline.

Distribution-channel internals and the maintainer checklist are maintained
separately from this public release guide.
