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

Before changing a version, signing a package, publishing downloads, exporting
public source, creating a GitHub Release, or publishing npm, private maintainers
must read `docs/internal/RELEASE_OPERATIONS.md` when that file is present. It is
the canonical operator contract and is intentionally omitted from public
exports. If this is a public snapshot and the internal runbook is absent, use
`docs/RELEASE.md` for local/test builds but do not infer private release access.

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

`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` must remain byte-identical so Codex,
Claude Code, Gemini CLI, Antigravity, and future clients receive the same rules.
Run `npm run agents:sync` after editing this file and `npm run agents:check`
before committing.
