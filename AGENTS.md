# Empir3 Bridge — Agent & Contributor Guide

This is the standalone Empir3 Bridge repo: the local control plane that exposes
browser and desktop tools to AI agents over MCP, plus the Windows tray/daemon
and the signed payload + installer release pipeline.

## What lives here

- The `localhost:3006` dashboard, the `/welcome` console, and `/desktop-test`
- The MCP server (browser + desktop tools) and the scriptable CLI
- The CDP bridge that drives the dedicated Chrome profile
- The tray app, daemon reconnect/quit/port-cleanup, and the Windows payload + installer build

## Before you edit

```bash
git status --short --branch
git pull --ff-only        # only when the tree is clean
```

If the tree is dirty, identify the dirty files before editing — parallel sessions
may have uncommitted work in progress. Stage exact files only; never use
`git add -A` / `git add .` / `git commit -a`.

## Run locally

```bash
npm install
npm start                 # launches the bridge; dashboard at http://localhost:3006
```

Useful checks:

```bash
npm run build:mcp         # bundle the MCP server
npx tsc --noEmit          # typecheck
npm test
```

## Release / publish

`package.json` is the version source of truth. Bump it, then:

```bash
npm run build:windows     # Empir3Setup.exe + signed payload under build/dist/
npm run release:check     # verify the artifacts
npm run publish:downloads -- --dry-run
npm run publish:downloads # set EMPIR3_DOWNLOAD_HOST / EMPIR3_DOWNLOAD_DIR first
```

The deploy target is read from the environment, not hardcoded — see
[docs/RELEASE.md](docs/RELEASE.md) for the full flow, and
[docs/SAFETY.md](docs/SAFETY.md) / [docs/TESTING.md](docs/TESTING.md) for the
safety model and test harness.
