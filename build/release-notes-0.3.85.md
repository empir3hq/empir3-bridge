Empir3 Bridge 0.3.85 fixes two reliability defects in lent-CLI serving and ships the fleet on a fully re-verified, signed artifact set.

## Fixes

- **Higgsfield generation restored on the CLI path.** 0.3.84 shipped `higgsfieldGenerate` returning its async body uninvoked, so every CLI-mode Higgsfield image/video generation failed instantly and fell over to API failover. The generate path now executes and serves normally.
- **Grok re-auth treadmill ended.** Each lent Grok turn runs in an isolated turn home with a copy of the CLI's auth state; Grok rotates refresh tokens on use, and the rotated token previously died with the turn home — bricking the session and demanding re-authentication despite a valid login. Turn cleanup now writes a changed auth state back to the real home via compare-and-swap, serialized across concurrent turn cleanups.

## Packaging

- Windows x64 (installer, portable, Squirrel update channel) — Authenticode via Azure Trusted Signing
- macOS universal (DMG, portable) — Developer ID signed, notarized, stapled
- Linux x64/ARM64 desktop (DEB, portable) and headless (tar.gz) — authenticated by SHA-256 entries in the Ed25519-signed artifact index

Download the right build for your machine at https://empir3.com/download
