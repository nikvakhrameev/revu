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
  {"type":"thread","filePath":"src/api/limiter.ts","position":{"side":"new","line":42},"body":"Race: the counter is read and written non-atomically; use a single INCR."},
  {"type":"thread","filePath":"src/api/limiter.ts","position":{"side":"new","line":{"start":58,"end":63}},"body":"This retry loop never backs off; add exponential delay."}
]'
```

- `position.side`: `"new"` for lines present on the target side, `"old"` for deleted lines.
- `position.line`: number or `{"start": N, "end": M}`.
- Write bodies in the user's language. Be specific: state the problem and the suggested fix.
- **Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into comment bodies or command-line arguments.**

3. **Build a walkthrough plan** that orders the findings into a readable pass (overview page first, then one page per area; reference the same lines your comments anchor to):

```json
{
  "schemaVersion": 1,
  "title": "Review: rate limiter",
  "pages": [
    {"id": "summary", "title": "1. Summary", "body": "3 findings: one race, one missing backoff, one test gap. Start with [the race](#page:race)."},
    {"id": "race", "title": "2. Counter race", "body": "The counter update is not atomic:\n\n```difit-ref\nfile: src/api/limiter.ts\nlines: 38-46\n```\n"}
  ]
}
```

- Snippet blocks: fenced ```` ```difit-ref ```` with YAML body — `file` (required), `lines` (`"N"` or `"N-M"`, required), `side` (`old`|`new`, optional, default `new`). One range per block; never paste code into the plan.
- Page ids are slugs (`^[a-z0-9][a-z0-9_-]*$`), links between pages: `[text](#page:slug)`.

```bash
revu plan validate plan.json   # iterate until {"ok": true}; errors are machine-readable
revu plan set plan.json
```

4. **Show it to the user:**

- Fire-and-forget: `revu review start --open` — opens the browser, you are done; report a short summary of the findings in chat.
- If the user should reply in the UI and you must wait: `revu review run --open` — blocks until the user presses **Finish review**, then prints the final thread state (their replies included) as JSON on stdout. Finish with no new replies means no follow-up requested.

5. Later sessions: `revu comment get` returns the persisted threads (including resolved history) for this task — use it to see what the user answered or closed.

## Error handling

Errors are JSON on stderr: `{"error": {"code", "message", "details?"}}`. `PLAN_VALIDATION_FAILED` → fix the plan from `details` and re-validate; `DAEMON_UNREACHABLE` → ask the user to run `revu daemon up`; `TASK_NOT_FOUND` on comment/plan reads → run `revu review start` first.

## Constraints

- Git-managed directories only.
- Do not run the difit binary directly; always go through `revu`.
- Keep the review result inside revu — do not post comments to remote GitHub/GitLab unless the user explicitly asks for `revu sync push`.
