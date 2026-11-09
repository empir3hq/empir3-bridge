---
name: delegate-to-my-ai-clis
description: >-
  Hand a task to another AI the user already pays for — the Codex, Grok, Claude
  or Antigravity (agy) CLI signed in on their machine — through the Empir3
  Bridge, and get the answer or the written files back. Use for second
  opinions, parallel drafts, reviews by a different model, or long jobs that
  should run in the background. Triggers: "ask Codex", "have Claude review",
  "get Grok to draft", "use my subscriptions".
---

# Delegate to my AI CLIs

The Bridge runs a lent CLI on the user's computer with that CLI's own sign-in.
No key is shared with you; the user's plan and limits apply.

## 1. Always start with `cli_status`

It returns one row per model — `codex`, `grok`, `claude`, `agy` (Google's
Antigravity CLI) — with `available` (installed), `lent` (the owner turned
sharing on), `authenticated` (signed in), `ready` (all three) and a `blocker`.
Only `ready` rows can run. For a blocker, tell the user the exact fix and stop:

- `cli_not_installed` — install that CLI on this machine.
- not lent — turn the row on under API & CLIs in the Bridge console
  (`http://localhost:3006/console`).
- not authenticated — sign in to that CLI on this machine.

Never ask for an API key or a password to get past a blocker.

## 2. Run with `cli_run`

- `model` — one of the ready rows.
- `prompt` or `promptFile` — the CLI has none of your conversation. Make the
  prompt self-contained: the goal, the inputs, the expected output format. Put
  long material in a file and pass `promptFile`.
- `mode:"text"` (default) is read-only and returns the answer.
  `mode:"agentic"` lets the CLI write files inside `cwd`; it works best on
  `codex`. Use it only with a `cwd` the user named, and report the files it
  changed afterwards.
- `background:true` for anything long; it returns a run id at once. Poll
  `cli_run_status` with that id, or list everything with `cli_runs`. Each run
  keeps a transcript path you can quote.
- `timeoutMs` defaults to four minutes and caps at twenty.

## 3. Patterns that work

- Draft with one model, review with another: `cli_run` Grok for the draft,
  then `cli_run` Claude with the draft in `promptFile` and a review brief.
- Parallel opinions: two background runs, then compare both transcripts.
- Build in a sandbox: `codex` in `mode:"agentic"` with an explicit `cwd`, then
  read the diff yourself before telling the user it is done.

## 4. Be honest about the result

A run that ends with an error, a timeout or an empty transcript did not
produce an answer; say so and show the transcript path. Do not rerun the same
prompt in a loop. If a CLI returns a different model's name or refuses, report
that verbatim.
