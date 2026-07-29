# Contributing

Thanks for helping make Empir3 Bridge useful outside the Empir3 app.

## Local Setup

```bash
git clone https://github.com/empir3hq/empir3-bridge
cd empir3-bridge
npm install
npm start
```

Useful commands:

```bash
npm run status
npm run kill
npx tsx src/cli.ts reliability-smoke
npx tsx src/cli.ts safety-status
```

## Development Checks

Run before opening a PR:

```bash
npx tsc --noEmit
npm run build:mcp
npm test
git diff --check
```

For packaging-related changes:

```bash
npm pack --dry-run
```

## Good First Areas

- Cross-platform Chrome detection.
- Better install and first-run messages.
- More deterministic smoke tests.
- Desktop tool polish on macOS and Linux.
- Diagnostic quality for failing CDP commands.
- Docs that help a fresh Claude Code or Codex user succeed quickly.
- Worked examples for the **API & CLIs** pane: a recipe per provider (Ollama on `localhost:11434`, LM Studio, OpenRouter, vLLM, a self-hosted gateway) so the `openai_chat` dispatcher is approachable without trial-and-error.

## PR Guidelines

- Keep changes scoped to one concern.
- Include verification steps.
- Update README or docs for user-facing behavior.
- Avoid new dependencies unless they remove real complexity.
- Do not commit `feedback/`, `recordings/`, `node_modules/`, local profiles, or API keys.

## Bug Reports

Please include:

- OS and version
- `node -v`
- Chrome version
- command you ran
- what you expected
- what happened
- `npm run status` output
- `npx tsx src/cli.ts reliability-status` output

Review logs and screenshots for private data before posting publicly.

## Security

Do not open a public issue for security problems. Email security@empir3.com or use a private GitHub security advisory.
