# Empir3 Bridge — Linux headless package

This is the lightweight Linux server/VPS host for the same Bridge engine used
by the Electron desktop applications. It does not ship Electron and does not
require a git checkout or `npm install` on the server.

Supported packages are built natively for Linux x64 and Linux ARM64. The host
needs systemd and Node.js 22 or newer.

After extracting the release tarball:

```bash
sudo bash install.sh
```

Optional install settings:

```bash
sudo bash install.sh --server https://app.empir3.com --user empir3 --prefix /opt/empir3-bridge
```

Unattended pairing: pass a pre-authorized Empir3 pairing code (minted by
`POST /api/auth/pairing-sessions/authorized`, the install-link flow) and the
box comes up already paired — no browser step:

```bash
sudo bash install.sh --pair <code>
# or, from provisioning / cloud-init:
sudo EMPIR3_PAIR_CODE=<code> bash install.sh
```

The code is redeemed as the service user before the first service start, so
`bridge-auth.json` lands in the service home with owner-only permissions. A
failed or expired code degrades to the normal interactive pairing path and
never blocks the install. The runtime also accepts
`node src/headless-entry.js --pair <code>` on an installed box to pair (or
re-pair) manually.

The installer creates a dedicated non-root service account, installs an
explicitly hardened `empir3-bridge.service`, waits for `/api/status`, and rolls
the `current` release link back if the new runtime does not become healthy.
Provider keys and local settings live under the service user's home and are
retained by a normal uninstall.

Runtime code is installed as root-owned, immutable versioned releases under
`/opt/empir3-bridge`; writable provider state, recordings, feedback, and update
state stay outside that tree. The service is limited to five starts in 60
seconds so a bad package cannot flap indefinitely. A signed updater timer
checks every 30 minutes, verifies the release manifest, exact target, byte
count, and SHA-256, and uses the same bounded installer health gate. An
explicit signed rollback can restore only the named prior version.

Production archives are authenticated by their exact byte count and SHA-256 in
the schema 3 artifact index, whose hash is covered by the Bridge Ed25519 release
signature. This is recorded as `ed25519-manifest-sha256`; it is not presented
as an OS-native package signature.

Pairing output is available with:

```bash
sudo journalctl -u empir3-bridge.service -n 100 --no-pager
```

Remove program files while retaining local provider data:

```bash
sudo bash uninstall.sh
```

`--purge-data` is a separate, explicit destructive option.

Maintainers can build an ephemeral, loopback-only signed update/rollback/bad
health fixture from a real package with
`headless-package/scripts/create-update-acceptance-fixture.cjs`. The fixture
generates its signing key in memory, marks every output `acceptanceOnly`, and
must never be published.
