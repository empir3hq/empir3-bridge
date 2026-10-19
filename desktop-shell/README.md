# Empir3 Bridge desktop shell

This is the Windows, macOS, and Linux Electron lifecycle host for the shared
Bridge engine. It does not implement providers. It supervises the existing
engine and displays its existing local console.

The durable product and release contract is in
[`docs/CROSS_PLATFORM_ELECTRON.md`](../docs/CROSS_PLATFORM_ELECTRON.md).

## Development

Install the root Bridge dependencies and the shell dependencies:

```bash
npm install
npm run desktop:install
```

Run the shell:

```bash
npm run desktop:dev
```

Development defaults use isolated ports so the installed Bridge is not touched:

- wrapper: `3306`
- CDP bridge: `10167`
- Chrome CDP: `10222`

The shell starts the shared Bridge with Chrome autolaunch disabled, waits for
`/health` and `/api/status`, and opens the existing **API & CLIs** pane. Closing
the window leaves the tray process available; Quit stops only the daemon the
shell launched.

Packaged apps expose **Check for Updates…** in the tray and also perform a quiet
startup check. The desktop updater accepts only the signed schema 3 manifest,
the exact OS/architecture installer, a healthy target, and a production-signed
artifact. It honors hold/staged/live/rollback policy and verifies the complete
download before opening it. Development shells never install updates.

Run an invisible lifecycle smoke:

```bash
npm run desktop:smoke
```

Run static/unit checks:

```bash
npm run desktop:test
```

## Native test packages

The desktop package and the staged Bridge runtime share the same release
version. Packaging stages the existing Bridge engine, the current platform's
`node-pty` runtime, and the provider console into Electron resources; provider
logic is never copied into the shell.

```bash
npm run desktop:verify-package  # package + isolated packaged-app smoke
npm run desktop:make            # native installer/archive makers
npm run desktop:artifacts       # hashes and inventory under out/artifacts.json
npm run desktop:installer-smoke:windows  # Squirrel install/remove/reinstall
npm run desktop:installer-smoke:macos    # DMG mount/copy/remove/reinstall
npm run desktop:installer-smoke:linux    # DEB install/remove/reinstall/purge
```

Forge 7's stable packager is pinned to Node 22.17 for packaging. The wrapper
uses that runtime automatically on a Node 24 workstation. CI builds natively:

- Windows x64: Squirrel Setup executable and portable ZIP;
- macOS universal: DMG and ZIP;
- Linux x64 and ARM64: DEB and ZIP.

After the four native receipts are downloaded into one directory, build and
hash-check the universal held release set with:

```bash
npm run desktop:artifacts:index -- --receipts <receipt-root> --stage-dir <release-dir>
```

The command refuses missing, duplicate, mixed-version, wrong-architecture, or
hash-mismatched artifacts. It writes the exact OS/architecture index and stages
stable public filenames without publishing them.

CI artifacts are unsigned test builds with a 14-day retention. The same native
lanes run real installer lifecycles, not only direct executable smoke. Linux
x64 and ARM64 additionally run signed-manifest upgrade and explicit rollback
transitions against the installed DEB. Release jobs enable platform signing
explicitly; publication remains a separate gate.

Windows release packaging uses Azure Trusted Signing only when
`EMPIR3_SIGN_WINDOWS=1`. macOS uses Developer ID signing, notarization, and
stapling only when `EMPIR3_SIGN_MACOS=1` and the documented Apple identity and
notary credentials are present. `EMPIR3_RELEASE_SIGNED=1 npm run
desktop:artifacts` re-verifies the resulting platform signatures before a
receipt may say it is signed.

The manual **Signed macOS candidate** workflow imports the Developer ID
certificate and App Store Connect notarization key into an ephemeral hosted-Mac
keychain, runs the full signed/notarized package and DMG lifecycle, uploads a
14-day held candidate, and deletes the imported material. It also builds a
separately signed/notarized next version and proves signed update, launch,
explicit rollback, relaunch, and state retention. It never publishes.

## Live packaged acceptance

After `npm run desktop:package` or `npm run desktop:make`, the live acceptance
runner launches the packaged executable with disposable app/provider state,
random loopback ports, Chrome dormant, and the Empir3 relay disabled. It can
exercise a local OpenAI-compatible endpoint, a built-in key-backed API
provider, and one or more real signed-in CLI subscriptions:

```bash
EMPIR3_ACCEPT_PROVIDER_URL=http://127.0.0.1:1234/v1 \
EMPIR3_ACCEPT_PROVIDER_MODEL=qwen/qwen3.5-9b \
npm run desktop:accept-live

EMPIR3_ACCEPT_API_PROVIDER=google \
EMPIR3_ACCEPT_API_MODEL=gemini-2.5-flash \
EMPIR3_ACCEPT_API_KEY='your-key' \
npm run desktop:accept-live

EMPIR3_ACCEPT_CLIS=codex,claude,grok,agy npm run desktop:accept-live
```

The runner requires its exact response markers, removes its temporary provider
or key, deletes any one-shot CLI transcript it created, shuts down only its own
packaged host, and removes the disposable profile. It never prints API keys.
CLI acceptance reads the user's existing vendor credential home; it does not
copy or modify those credentials.

## Overrides

- `EMPIR3_BRIDGE_RUNTIME_ROOT` — source/runtime root containing
  `src/headless-entry.js`
- `EMPIR3_BRIDGE_NODE` — Node executable used for the development daemon
- `EMPIR3_PW_PORT`, `EMPIR3_BRIDGE_HTTP_PORT`, `EMPIR3_CDP_PORT` — isolated
  port overrides
- `EMPIR3_BRIDGE_PROFILE` — dedicated Chrome profile path
- `EMPIR3_DESKTOP_MANIFEST_URL` — test-only alternate signed update manifest
  endpoint (the packaged default is the production desktop rollout manifest)

These packages remain test builds. Do not publish them through the production
Bridge download channel until every target's lifecycle, authentication, and
release-health gates pass.
