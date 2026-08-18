---
name: review-code
description: Review a branch diff yourself and present the findings inside revu (difit UI) as anchored comment threads plus a walkthrough plan the user can flip through.
---

# Review Code (revu)

## Overview

This skill is for "review this code and show me what you found": you (the agent) review the diff, then deliver the findings through `revu` so the user reads them anchored to the exact lines in a diff viewer, optionally guided by a walkthrough plan.

Key facts:

- The task is identified by repository + source branch + base branch. Defaults: source = current branch, base = origin/HEAD (or main/master). Override with `--source <branch>` / `--base <branch>`.
- Reviews cover committed code only (the diff is merge-base(base, source) → source head).
- All commands need the revu daemon. On `DAEMON_UNREACHABLE`, ask the user to run `revu daemon up` — do not start the daemon yourself.

## Workflow

1. **Study the diff yourself** with git (do not start the UI for this):

```bash
git diff $(git merge-base <base> <source>)..<source>
```

2. **Write findings as comments.** One thread per finding, anchored to the exact lines:

```bash
revu comment add '[
  {"type":"thread","id":"agent-race","author":"agent","filePath":"src/api/limiter.ts","position":{"side":"new","line":42},"body":"Race: the counter is read and written non-atomically; use a single INCR."},
  {"type":"thread","id":"agent-backoff","author":"agent","filePath":"src/api/limiter.ts","position":{"side":"new","line":{"start":58,"end":63}},"body":"This retry loop never backs off; add exponential delay."}
]'
```

- **Always set `id` (your own stable slug) and `author` (e.g. `"agent"`)**: `id` makes re-imports idempotent, and `author` is what identifies messages as yours later (see step 5).
- `position.side`: `"new"` for lines present on the target side, `"old"` for deleted lines.
- `position.line`: number or `{"start": N, "end": M}`.
- Anchors are validated against git (file exists on that side, lines within bounds; a reply must match an existing thread's file/position). A bad batch is rejected whole with `COMMENT_VALIDATION_FAILED` and machine-readable `details` — fix the named imports and retry. Still take paths and line numbers from the diff you just read, not from memory.
- Remove your own mistaken or obsolete comments with `revu comment remove <id...>` (removal, not resolution — resolving is the user's).
- Write bodies in the user's language. Be specific: state the problem and the suggested fix.
- **Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into comment bodies or command-line arguments.**

3. **Build a walkthrough plan** that orders the findings into a readable pass. Open with an overview page (verdict, counts, route through the pages), then one page per finding or area, ordered by importance — not by file order. Reference the same lines your comments anchor to, so each plan page shows the snippet with your thread on it.

```json
{
  "schemaVersion": 1,
  "title": "Review: rate limiter",
  "pages": [
    {"id": "summary", "title": "Summary", "body": "3 findings: one race, one missing backoff, one test gap. Start with [the race](#page:race)."},
    {"id": "race", "title": "Counter race", "body": "The counter update is not atomic:\n\n```difit-ref\nfile: src/api/limiter.ts\nlines: 38-46\n```\n"}
  ]
}
```

- Snippet blocks: fenced ```` ```difit-ref ```` with YAML body — `file` (required), `lines` (`"N"` or `"N-M"`, required), `side` (`old`|`new`, optional, default `new`). One range per block; never paste code into the plan.
- Snippets resolve against the git blob at the pinned revision, **not** only the diff: you may reference unchanged files too (e.g. surrounding context, a config the change depends on) — omit `side` for those.
- `lines` are file line numbers on the referenced side (`new` = source head, `old` = base), not diff-hunk numbers.
- Page ids are slugs (`^[a-z0-9][a-z0-9_-]*$`), links between pages: `[text](#page:slug)`. Do not number page titles — the UI numbers pages itself.
- Prefer piping the plan via stdin — no file needed; if you do write one, keep it **outside the repository** (a stray file makes the worktree dirty and blocks instance restarts).

```bash
revu plan validate -           # plan JSON on stdin; iterate until {"ok": true}; errors are machine-readable
revu plan set -                # also accepts a file path instead of -
```

Validation is two-phase: structural errors (envelope, ids, links, ref syntax) come first, file/line-range errors only once the structure is clean — expect up to two fix iterations. A failed validation looks like this (exit code 8) — fix the named page/snippet and re-validate:

```json
{"error":{"code":"PLAN_VALIDATION_FAILED","message":"Plan validation failed","details":[
  {"code":"REF_FILE_NOT_FOUND","path":"pages[race].refs[0]","message":"file \"src/limitr.ts\" not found on the new side"},
  {"code":"REF_LINES_OUT_OF_RANGE","path":"pages[race].refs[1]","message":"lines 100-105 exceed file length 20 of \"src/api/limiter.ts\""}]}}
```

4. **Show it to the user:**

- Fire-and-forget: `revu review start --open` — opens the browser, you are done; report a short summary of the findings in chat. Omit `--open` in headless/unattended runs (the instance still starts; the response JSON contains the `url` to hand to the user).
- If the user should reply in the UI and you must wait: `revu review run --open` — blocks until the user presses **Finish review**, then prints the final thread state as JSON on stdout. **A message is yours only if it carries the `author` you set; anything else is the user's** (the difit UI currently stamps `"author": "User"`, but do not rely on that exact value). Threads whose last message is not yours need a response; `resolved` threads are closed by the user; an empty delta after Finish (or, without `--since`, no new user messages) means no follow-up requested. When you act on feedback, reply into the thread (`"type":"reply"`, your `author`, same file/position) so the user sees the outcome and handled threads are marked by your last message.

5. **Verify delivery (optional):** `revu comment get` and `revu plan get` read back exactly what was stored; `revu review list --repo .` shows this repository's tasks.

   Responses of `review start/run` and `comment add/remove/get` include the task's monotonic `generation` counter; `revu review run --since <N>` / `revu comment get --since <N>` return only feedback stamped after that cursor (threads come whole, same shape as the full response). On `CURSOR_INVALID` (exit 13), retry without `--since` and process the full state.

6. Later sessions: `revu comment get` returns the persisted threads (including resolved history) for this task — use it to see what the user answered or closed.

## Error handling

Errors are JSON on stderr: `{"error": {"code", "message", "details?"}}` with distinct exit codes; 0 = success. `PLAN_VALIDATION_FAILED` (exit 8) and `COMMENT_VALIDATION_FAILED` (exit 12) → fix the named entries from `details` and retry; `DAEMON_UNREACHABLE` (exit 3) → ask the user to run `revu daemon up`; `TASK_NOT_FOUND` (exit 4) on comment/plan reads → run `revu review start` first; `GIT_ERROR` (exit 10) → e.g. not a git repository.

## Constraints

- Git-managed directories only.
- Do not run the difit binary directly; always go through `revu`.
- Keep the review result inside revu — do not post comments to remote GitHub/GitLab unless the user explicitly asks for `revu sync push`.
