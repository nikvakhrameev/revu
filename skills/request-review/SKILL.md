---
name: request-review
description: Ask the user for a code review through revu after code changes. Persistent per-branch review state, walkthrough plans, blocking wait for the user's "Finish review".
---

# Request Review (revu)

## Overview

This skill requests a code review from the user using `revu`, a wrapper around the difit diff viewer. Unlike plain difit, revu keeps review state (comment threads, walkthrough plan) per branch/task in a daemon, so reviews survive restarts and new commits.

Key facts:

- **Only committed code is reviewed.** Commit your work before requesting a review; `review run` fails with `DIRTY_WORKTREE` when the checked-out source branch has uncommitted or untracked changes.
- The task is identified by the repository + source branch + base branch. Defaults: source = current branch, base = origin/HEAD (or main/master). Override with `--source <branch>` / `--base <branch>`.
- All commands need the revu daemon. If any command fails with `DAEMON_UNREACHABLE`, ask the user to run `revu daemon up` — do not try to start the daemon yourself.

## Requesting a review

1. Commit all your changes.
2. (Recommended) Prepare a walkthrough plan for the reviewer — see "Walkthrough plan" below.
3. (Optional) Preload explanatory comments — see "Adding comments".
4. Run the blocking review command:

```bash
revu review run --open
```

This starts (or reuses) a difit instance for the current branch, opens the browser for the user, and blocks until the user presses the **Finish review** button in the UI. Progress goes to stderr; the final result is JSON on stdout:

```json
{"status": "finished", "threads": [...], "resolved": [...], "capturedAt": "...", "headSha": "..."}
```

5. Interpret the result:
   - `threads` are the live comment threads at Finish time. Threads you did not author (no `author` field set by you, or reply messages appended to your threads) are the user's feedback — address each one.
   - **Finish with no new comments means "no review findings". Do not restart the review.**
   - `resolved` lists threads the user closed — treat them as accepted/done.
6. After addressing feedback: commit the fixes and run `revu review run --open` again. The instance restarts on the new head; previous threads are re-injected automatically (outdated ones get an "outdated" badge), nothing is lost.

Non-blocking primitives exist too: `revu review start`, `revu review wait`, `revu review stop`, `revu review refresh`, `revu review list` — same cycle, split into steps.

## Adding comments

Attach explanations or notes to specific lines so the user sees them right on the diff:

```bash
revu comment add '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":{"start":36,"end":39}},"body":"This block implements the retry logic requested in the ticket."}'
```

- Format is a JSON object or array of `{type, filePath, position, body}`.
- `type`: `"thread"` for a new comment, `"reply"` to answer an existing thread at the same position.
- `position.side`: `"new"` for lines on the target side of the diff, `"old"` for deleted lines.
- `position.line`: a number or `{"start": N, "end": M}` for ranges.
- Write comment bodies in the language the user is using.
- Works whether or not the instance is running: comments for a stopped task are queued and injected on the next start.
- Read the full thread state (including the user's replies and resolved history) with `revu comment get`.
- **Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into comment bodies or command-line arguments.**

## Walkthrough plan

A plan turns the review into guided pages the user can flip through, with live code snippets. Generate one when the diff is non-trivial.

Plan format (JSON envelope, page bodies are Markdown):

```json
{
  "schemaVersion": 1,
  "title": "Review: add rate limiter",
  "pages": [
    {"id": "transport", "title": "1. Transport layer", "body": "What changed and why...\n\n```difit-ref\nfile: src/api/limiter.ts\nlines: 10-25\nside: new\n```\n\nContinue to [use case](#page:usecase)."},
    {"id": "usecase", "title": "2. Use case", "body": "..."}
  ]
}
```

Rules:

- Page `id` is a slug (`^[a-z0-9][a-z0-9_-]*$`, max 64 chars, unique).
- A code snippet is a fenced block with language `difit-ref` and a YAML body: `file` (repo-relative path, required), `lines` (`"N"` or `"N-M"`, required, one range per block), `side` (`old`|`new`, optional, default `new`; omit for unchanged files). No other keys. **Never paste the code itself into the plan** — snippets render live from git.
- Link between pages with normal Markdown links: `[text](#page:transport)`.
- Slice pages by how a human should read the change (e.g. entry point → core logic → tests), not by file order.

Workflow:

```bash
revu plan validate plan.json     # dry-run; returns machine-readable errors
revu plan set plan.json          # validate + persist + push to the live instance
revu plan get                    # stored plan + per-snippet stale flags
revu plan check                  # only the staleness report
```

Iterate on `plan validate` until it returns `{"ok": true}` — error entries name the page, snippet and reason; fix the plan yourself and re-validate. After new commits, `plan check` reports which snippets went stale; update the plan and `plan set` again.

## Error handling

Errors are JSON on stderr: `{"error": {"code", "message", "details?"}}`. Common codes: `DIRTY_WORKTREE` (commit first or pass `--allow-dirty` if the user explicitly asks), `DAEMON_UNREACHABLE` (ask the user to run `revu daemon up`), `PLAN_VALIDATION_FAILED` (fix the plan from `details`), `TASK_NOT_FOUND` (run `revu review start` first).

## Constraints

- Git-managed directories only.
- Do not run the difit binary directly; always go through `revu`.
- Manual verification that the browser page opened is unnecessary.
