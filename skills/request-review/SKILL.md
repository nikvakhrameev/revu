---
name: request-review
description: Ask the user for a code review through revu after code changes. Persistent per-branch review state, walkthrough plans, blocking wait for the user's "Finish review".
---

# Request Review (revu)

## Overview

This skill requests a code review from the user using `revu`, a wrapper around the difit diff viewer. Unlike plain difit, revu keeps review state (comment threads, walkthrough plan) per branch/task in a daemon, so reviews survive restarts and new commits.

Key facts:

- **Only committed code is reviewed.** Commit your work before requesting a review; starting (or restarting) the review instance fails with `DIRTY_WORKTREE` while the checked-out source branch has uncommitted or untracked changes. Keep your own scratch files — such as the plan JSON — **outside the repository**, or they will trip this check.
- The task is identified by the repository + source branch + base branch. Defaults: source = current branch, base = origin/HEAD (or main/master). Override with `--source <branch>` / `--base <branch>`.
- All commands need the revu daemon. If any command fails with `DAEMON_UNREACHABLE`, ask the user to run `revu daemon up` — do not try to start the daemon yourself.

## Requesting a review

1. Commit all your changes.
2. (Recommended) Prepare a walkthrough plan for the reviewer — see "Walkthrough plan" below.
3. (Optional) Preload explanatory comments — see "Adding comments".
4. Run the blocking review command:

```bash
revu review run --open                 # first round: full state
revu review run --open --since <N>     # later rounds: only feedback newer than your cursor
```

This starts (or reuses) a difit instance for the current branch, opens the browser for the user, and blocks until the user presses the **Finish review** button in the UI. Progress (including the instance URL) goes to stderr; the final result is JSON on stdout:

```json
{"status": "finished", "threads": [...], "capturedAt": "...", "headSha": "...", "resolved": [...], "generation": 7}
```

**Cursor discipline (`generation` / `--since`).** Every task has a monotonic `generation` counter of its comment state, and every response that matters hands you the current value — use it as your cursor to avoid re-reading feedback you already processed:

- `revu review start` returns the baseline `generation` ("everything from this moment on"); `revu comment add` returns the generation covering your own batch, `revu comment remove` the post-removal one — advance your cursor to whatever the latest command returned.
- `revu review run --since <cursor>` (and `revu comment get --since <cursor>`) return only threads/resolved entries changed **after** the cursor; each returned thread comes whole (all messages) and each newly-resolved entry is the full record — same shapes as the full response, so the classification rule is unchanged. Your own writes sit at your cursor and are not echoed back.
- An empty delta (`{"threads": [], "resolved": [], "generation": N}`) after Finish means **"no review findings" — do not restart the review**.
- `CURSOR_INVALID` (exit 13) means your cursor is from a former life of the task (state wiped/recreated): retry without `--since` and process the full state. `review run` validates the cursor fail-fast at start, before the user begins reviewing.
- Omitting `--since` always returns the unconditional full state (`--since 0` is not the same: it excludes items that predate the counter).

In headless/unattended runs omit `--open`; hand the user the URL from the progress line or from `revu review list --repo .`.

5. Interpret the result. **Classification rule: a message is yours only if it carries the `author` value you set when adding it (e.g. `"agent"`). Everything else is the user's** — the difit UI currently stamps its messages with `"author": "User"`, but do not rely on that exact value; treat any message whose `author` is not yours (or is missing) as user feedback.
   - A thread needs your attention when its **last message is not yours** — a reply in one of your threads, or a brand-new user thread.
   - `resolved` lists threads the user closed — treat them as accepted/done, no action needed.
   - **An empty delta after Finish means "no review findings". Do not restart the review.** (Without `--since`, the same signal is a full state with no new user messages.)

   Example of a Finish with feedback — the user replied to your thread (second message, author is not yours):

```json
{"status":"finished","threads":[{"id":"agent-note-1","filePath":"src/api/limiter.ts",
  "position":{"side":"new","line":42},
  "messages":[
    {"id":"agent-note-1","body":"This implements the retry logic.","author":"agent","createdAt":"..."},
    {"id":"x8k2...","body":"Please also handle negative values here.","author":"User","createdAt":"..."}]}],
 "resolved":[],"generation":8}
```

6. Address the feedback, then **reply into every user thread you acted on** (`"type":"reply"`, your `author`, same file/position — see "Adding comments") stating what you did. This is both the confirmation the user sees in the UI and the marker that keeps rounds apart: on the next Finish, threads whose last message is yours are already handled. Each such `comment add` returns a fresh `generation` — keep your cursor at the latest one.
7. If you set a walkthrough plan, refresh it: `revu plan check` → update the stale pages → `revu plan set`. Otherwise the user sees "code changed" placeholders instead of snippets on the next round.
8. Commit the fixes and run `revu review run --open --since <cursor>` again. The instance restarts on the new head; previous threads are re-injected automatically (threads whose code changed get an "outdated" badge), nothing is lost. After Finish the instance stops — the old URL goes dead until the next start.

Non-blocking primitives exist too: `revu review start`, `revu review wait`, `revu review stop`, `revu review refresh`, `revu review list` — same cycle, split into steps.

## Adding comments

Attach explanations or notes to specific lines so the user sees them right on the diff:

```bash
revu comment add '{"type":"thread","id":"agent-retry-note","author":"agent","filePath":"src/example.ts","position":{"side":"new","line":{"start":36,"end":39}},"body":"This block implements the retry logic requested in the ticket."}'
```

- Format is a JSON object or array of `{type, id, author, filePath, position, body}`.
- **Always set `id` (your own stable slug) and `author` (e.g. `"agent"`)** on everything you add: `id` makes re-imports idempotent, and `author` is what identifies messages as yours (see the classification rule above).
- `type`: `"thread"` for a new comment, `"reply"` to answer the existing thread at the same file/position (this is how you answer user threads too — match their `filePath` and `position` from the Finish snapshot).
- `position.side`: `"new"` for lines on the target side of the diff, `"old"` for deleted lines.
- `position.line`: a number or `{"start": N, "end": M}` for ranges.
- Anchors are validated against git (file exists on that side, lines within bounds; a reply must match an existing thread's file/position). A bad batch is rejected whole with `COMMENT_VALIDATION_FAILED` and machine-readable `details` — fix the named imports and retry. Still take paths and line numbers from the actual diff output, not from memory.
- Remove your own mistaken or obsolete comments with `revu comment remove <id...>` (works on live and stopped instances; the response includes the post-removal `generation`; this is removal, not resolution — resolving is the user's).
- Write comment bodies in the language the user is using.
- Works whether or not the instance is running: with a live instance the comment appears immediately (`{"success": true, ..., "generation": N}` — N is your new cursor), otherwise it is staged and injected on the next start (`{"staged": true, ..., "generation": <current>}` — the counter bumps at injection, so an older cursor may see your own staged comments echoed in a later delta; the author classification rule filters them).
- Read the full thread state (including the user's replies and resolved history) with `revu comment get`, or just the changes after your cursor with `revu comment get --since <N>`.
- **Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into comment bodies or command-line arguments.**

## Walkthrough plan

A plan turns the review into guided pages the user can flip through, with live code snippets. Generate one when the diff is non-trivial (several files or several distinct ideas); for a trivial one-liner it is overhead.

Plan format (JSON envelope, page bodies are Markdown):

```json
{
  "schemaVersion": 1,
  "title": "Review: add rate limiter",
  "pages": [
    {"id": "transport", "title": "Transport layer", "body": "What changed and why...\n\n```difit-ref\nfile: src/api/limiter.ts\nlines: 10-25\nside: new\n```\n\nContinue to [use case](#page:usecase)."},
    {"id": "usecase", "title": "Use case", "body": "..."}
  ]
}
```

Format rules:

- Page `id` is a slug (`^[a-z0-9][a-z0-9_-]*$`, max 64 chars, unique). Link between pages with normal Markdown links: `[text](#page:transport)`.
- A code snippet is a fenced block with language `difit-ref` and a YAML body: `file` (repo-relative path, required), `lines` (`"N"` or `"N-M"`, required, one range per block), `side` (`old`|`new`, optional, default `new`; omit for unchanged files). No other keys. **Never paste the code itself into the plan** — snippets render live from git.

Writing a good plan:

- Slice pages by how a human should read the change (e.g. entry point → core logic → tests), not by file order. Tell the story: what the change is for, the key decisions, how it is verified.
- Open with a short overview page: what this review is about and the route through the pages.
- Do not number page titles — the UI numbers pages itself in the sidebar and shows "Page N of M".
- One idea per page, a handful of pages total; a snippet shows the core of the idea (usually well under ~20 lines). Use several `difit-ref` blocks for several places.
- `lines` are file line numbers on the referenced side (`new` = source-branch head, `old` = base), **not** diff-hunk numbers. Take them from real output (`git diff`, `nl -ba <file>`), not from memory.
- You may reference unchanged files too (surrounding context, a config the change depends on) — omit `side` for those.

Workflow:

```bash
revu plan validate <file | ->    # dry-run; returns machine-readable errors
revu plan set <file | ->         # validate + persist + push to the live instance
revu plan get                    # stored plan + per-snippet stale flags
revu plan check                  # only the staleness report
```

Prefer piping the plan via stdin (`revu plan set -`) — no file needed; if you do write a file, keep it outside the repository (it would make the worktree dirty). Validation is two-phase — structural errors (envelope, ids, links, ref syntax) are reported first, file/line-range errors only once the structure is clean — so expect up to two fix iterations; repeat `plan validate` until it returns `{"ok": true}`. After new commits, `plan check` reports which snippets went stale (`reason`: `content-changed`, `lines-out-of-range` or `file-missing`); update the plan and `plan set` again.

## Error handling

Errors are JSON on stderr: `{"error": {"code", "message", "details?"}}` with distinct exit codes. Common ones: `DIRTY_WORKTREE` (exit 6 — commit first, or pass `--allow-dirty` only if the user explicitly asks), `DAEMON_UNREACHABLE` (exit 3 — ask the user to run `revu daemon up`), `PLAN_VALIDATION_FAILED` (exit 8) and `COMMENT_VALIDATION_FAILED` (exit 12) — fix the named entries from `details` and retry, `TASK_NOT_FOUND` (exit 4 — run `revu review start` first), `GIT_ERROR` (exit 10 — e.g. not a git repository), `CURSOR_INVALID` (exit 13 — your `--since` cursor is ahead of the task's counter, i.e. from a former life of the task: retry without `--since` and process the full state). Exit 0 = success.

## Constraints

- Run commands from inside the repository (or pass `--repo <path>` — every command supports it).
- `revu review list` shows tasks of **all** repositories the daemon knows; scope it with `--repo .`.
- Do not run the difit binary directly; always go through `revu`.
- Manual verification that the browser page opened is unnecessary.
