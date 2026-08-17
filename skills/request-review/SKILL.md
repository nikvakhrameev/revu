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

5. Interpret the result. Comments created in the difit UI carry **no `author` field**, while you must set `"author"` on everything you add (see below) — that is the classification rule:
   - Any thread or reply message **without an `author`** is the user's feedback — address each one.
   - **Finish with no new user comments means "no review findings". Do not restart the review.**
   - `resolved` lists threads the user closed — treat them as accepted/done.

   Example of a Finish with feedback — the user replied to your thread (second message, no `author`) :

```json
{"status":"finished","threads":[{"id":"agent-note-1","filePath":"src/api/limiter.ts",
  "position":{"side":"new","line":42},
  "messages":[
    {"id":"agent-note-1","body":"This implements the retry logic.","author":"agent", "createdAt":"..."},
    {"id":"x8k2...","body":"Please also handle negative values here.","createdAt":"..."}]}],
 "resolved":[]}
```

6. After addressing feedback: commit the fixes and run `revu review run --open` again. The instance restarts on the new head; previous threads are re-injected automatically (outdated ones get an "outdated" badge), nothing is lost.

Non-blocking primitives exist too: `revu review start`, `revu review wait`, `revu review stop`, `revu review refresh`, `revu review list` — same cycle, split into steps.

**Live-dialog pattern.** While `review run` blocks, you cannot react to the user's in-thread questions until Finish (the daemon still captures every comment, so nothing is lost — you get them all at Finish). If the user is expected to ask questions in threads and wants answers *before* finishing, use the non-blocking loop instead: `revu review start --open`, then periodically `revu comment get` (new messages without `author` are the user's), answer with `revu comment add` (`type: "reply"`, same position — it appears in their browser instantly), and call `revu review wait` once the conversation settles.

## Adding comments

Attach explanations or notes to specific lines so the user sees them right on the diff:

```bash
revu comment add '{"type":"thread","id":"agent-retry-note","author":"agent","filePath":"src/example.ts","position":{"side":"new","line":{"start":36,"end":39}},"body":"This block implements the retry logic requested in the ticket."}'
```

- Format is a JSON object or array of `{type, id, author, filePath, position, body}`.
- **Always set `id` (your own stable slug) and `author` (e.g. `"agent"`)** on everything you add: `id` makes re-imports idempotent and lets you recognize your own threads later; `author` is how your comments are told apart from the user's (UI comments have none).
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

Errors are JSON on stderr: `{"error": {"code", "message", "details?"}}` with distinct exit codes. Common ones: `DIRTY_WORKTREE` (exit 6 — commit first, or pass `--allow-dirty` only if the user explicitly asks), `DAEMON_UNREACHABLE` (exit 3 — ask the user to run `revu daemon up`), `PLAN_VALIDATION_FAILED` (exit 8 — fix the plan from `details` and re-validate), `TASK_NOT_FOUND` (exit 4 — run `revu review start` first). Exit 0 = success.

## Constraints

- Run commands from inside the repository (or pass `--repo <path>` explicitly — every command supports it).
- `revu review list` shows tasks of **all** repositories the daemon knows; use `--repo .` or match the `repoRoot` field to find yours.
- Do not run the difit binary directly; always go through `revu`.
- Manual verification that the browser page opened is unnecessary.
