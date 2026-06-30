<!--
Thanks for contributing! A few quick checks make review faster:

- Keep PRs small and focused. One concern per PR.
- If this fixes an open issue, link it: "Fixes #123".
- For new features, an issue or discussion first is appreciated so we can
  align on shape before you spend time writing code.
- For bug fixes, include enough detail in the description that a reviewer
  can reproduce the bug locally before/after the fix.
-->

## What this PR does

<!-- One or two sentences. The why is more important than the what. -->

## Linked issue

<!-- Fixes #... / Refs #... / N/A -->

## How to verify

<!-- Concrete steps a reviewer can run. e.g.:
1. `npm install && npm start`
2. `npx tsx src/cli.ts navigate https://example.com`
3. Observe X
-->

## Smoke checklist

- [ ] `npx tsc --noEmit` is clean
- [ ] `npm run build:mcp` succeeds
- [ ] `npx tsx src/cli.ts reliability-smoke` succeeds where applicable
- [ ] `npx tsx src/cli.ts safety-status` shows expected tool permissions
- [ ] Manually drove the bridge end-to-end against a real Chrome with the change applied
- [ ] No new dependencies added (or, if added, justified in the description)
- [ ] Docs / README updated if user-facing behavior changed

## Anything else reviewers should know?
