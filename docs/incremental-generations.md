# Incremental Review Generations

Status: **accepted design, implementation pending**. All decisions below were fixed in a design
session on 2026-08-18. This document is the source of truth for the implementation; the Russian
system spec (`difit-wrapper-design.md`) should gain a cross-reference to it.

## Problem

Every review round the agent re-receives the *entire* accumulated review state — all threads with
full message history plus every resolved thread ever — both on `review run` stdout after Finish
(the primary channel per the skill) and from `comment get` (`registry.commentGet`). The payload
grows monotonically with rounds; on long-lived branches the agent burns context re-reading
feedback it has already processed.

## Concept

A **per-task monotonic generation counter** — a logical clock of the task's comment state.

- Every *substantive* change to threads/resolved state increments the counter (changes landing in
  one snapshot collapse into one increment, except for the attribution split below).
- Every thread and every resolved entry is **stamped** with the generation of its last
  substantive change.
- A delta request carries a client-held cursor: `--since <N>` returns exactly the items with
  `stamp > N`. The daemon keeps **no per-consumer state** — the cursor lives with the agent, so
  any number of concurrent consumers is naturally safe, and reads stay idempotent.
- No `--since` → the full state, exactly as today (the zero-context / dry-run case).

The difit fork is **not touched**: the in-instance session `version` counter (reset on every
restart, keyed by diff selection) is unrelated and stays as-is. Everything here is daemon-side
(`packages/revu`) plus one error-code addition in `packages/plan-schema`.

## What bumps the counter

| Event | Bump? | Notes |
|---|---|---|
| User actions in the UI (new thread, reply, edit, resolve) | **yes** | detected by the snapshot diff |
| Agent `comment add` (live instance) | **yes** | response returns the new generation (see attribution) |
| Agent `comment add` (staged, instance down) | **at drain time**, not at staging | see "Accepted rough edge" |
| `comment remove` | **yes** | items vanish (nothing left to stamp); response returns the new generation |
| Thread re-injection on restart (new head) | **no** | content is unchanged by the projection; no phantom bumps |
| GitLab sync pull | yes, naturally | flows through the same snapshot path |
| `plan set` / `plan check` | **no** | plan integration deliberately deferred (below) |

## Change detection: the projection

`snapshot()` currently overwrites `threads.json` wholesale and only diffs thread *disappearance*
(the resolution signal). For stamps it must compare each thread prev/next — but only on a
**normalized projection**, or restarts would produce phantom deltas:

```
id, filePath, messages[].{id, body, author}
```

A thread "changed" iff this slice changed. Deliberately excluded:

- `createdAt` / `updatedAt` — travel through re-import round-trips, carry no signal;
- `codeSnapshot` — recomputed when code moves; "the code under a comment changed" is not user
  feedback and must not re-deliver the thread;
- `position` — difit may re-anchor on a new diff; a shifted anchor is not feedback either. The
  agent reads the current position from the delta body, which is always fresh.

Threads unchanged by the projection **carry their previous stamp forward** — across snapshots and
across restarts (prev = `threads.json` on disk).

Resolution: a thread that disappeared from difit is moved to `resolved.json` stamped with the
bump generation of that snapshot (the "foreign" generation under attribution, below).

## Attribution on `comment add`: split stamps

`commentAdd` today fire-and-forgets the snapshot (`queueSnapshot`) and returns immediately. To
return a generation it must **await the snapshot** (chained through `snapshotChain`, the way
`commentRemove` already serializes) — and that exposes a race:

> Agent posts a batch; in the same instant the user replies in the UI. The following snapshot's
> diff contains both. One shared bump would put the user's reply *at or below* the cursor
> returned to the agent → the reply silently never appears in any delta.

**Rule:** a snapshot triggered by an agent batch splits its diff into two consecutive
generations. The daemon knows the batch ids (the agent is required to set them):

| Group | Contents | Stamp |
|---|---|---|
| "mine" — changes fully explained by batch ids (new thread whose id ∈ batch; reply whose message id ∈ batch) | the agent's own writes | `N+1` |
| "not mine" — every other change in the same diff | concurrent user/sync activity, disappearances | `N+2` |

The counter advances past the highest stamp used; `comment add` returns `N+1`. The user's
concurrent change lives at `N+2 > cursor` and is delivered in the next delta; the agent's own
writes sit at the cursor and are not echoed back. When there is no foreign group (the common
case) the counter simply becomes `N+1`.

Ordinary snapshots (SSE `commentsChanged` from user activity, drain, sync) are a single bump: all
changes in the diff share one stamp. The duplicate snapshot triggered by the import's own SSE
event diffs empty and does not bump.

## Delta semantics

`--since N` is a **thread-level filter, not a message-level one**:

- `threads`: threads with `stamp > N`, each returned **whole** — same shape, byte-for-byte, as in
  the full response (all messages, position, codeSnapshot). Untouched threads are omitted
  entirely. Rationale: the agent needs the thread context (its own original comment) to interpret
  a reply; the growth problem is threads × rounds, not messages within a thread; and an identical
  shape means zero new types and an unchanged classification rule ("last message not yours →
  needs attention").
- `resolved`: entries with `stamp > N`, each as the full existing `{thread, resolvedAt, …}`
  record — a resolved thread arrives whole (this already holds by construction of
  `resolved.json`).
- No per-message "new" markers — `author` + message order already carry that information.
- The current `generation` is always included. An empty delta is
  `{"threads": [], "resolved": [], "generation": N}` and means "no new feedback".
- The plan does not participate (deferred).

## Cursor edge cases

- `since == current` → empty delta. Normal.
- `since > current` → error **`CURSOR_INVALID`** (HTTP **409**, exit code **13**). This is the
  "state directory wiped / task recreated, agent holds a cursor from a former life" case. A
  silent empty delta here would convince the agent there are no findings while a live review
  sits in front of it — silent data loss, the worst outcome — hence a loud error. The agent's
  documented recovery: retry without `--since`, process the full state.
- **Fail-fast in `review run`:** `review run --since N` validates the cursor **at start**, before
  opening the browser and blocking — not after the user has spent half an hour reviewing. The
  counter is monotonic, so a cursor valid at start cannot become invalid by Finish.
- `--since 0` is a valid cursor meaning "everything since the counter was born": pre-migration
  items (stamp 0) are *excluded*. Omitting `--since` is the only way to get the unconditional
  full state. Both behaviours are intended.

## Storage

- **Counter:** `meta.json` gains `generation: number` (default 0). `meta.json` exists from
  `review start` on — before any snapshot — which the baseline semantics require. `snapshot()`
  now writes two files (threads + meta); per-file atomicity is unchanged and a torn pair is
  harmless (nothing worse than a spare increment).
- **Stamps:** `threads.json` → `threads[].generation`; `resolved.json` → `threads[].generation`.
- All new fields are **additive optionals defaulting to 0**; `schemaVersion` stays `1`; no
  migration. Old files remain valid; old unstamped items read as stamp 0 and never appear in
  deltas (honest: they predate any cursor).
- `threads.json.version` (the difit session counter) is **neither renamed nor reused** — it is a
  different animal that resets per instance. Document the distinction in a comment in
  `store.ts`.

## CLI / API surface

| Command | Returns `generation` | Accepts `--since <N>` |
|---|---|---|
| `review run` | **yes** — in the final JSON after Finish | **yes** — filters the final snapshot; cursor validated fail-fast at start |
| `review start` | **yes** — the "from this moment" baseline | no |
| `comment add` | **yes** — the post-insert generation (attribution rule) | no |
| `comment remove` | **yes** | no |
| `comment get` | **yes** | **yes** |
| `review wait` | no (prints only `{status}`) | no |
| `plan *` | no (deferred) | no |

Wire details: field name is **`generation`** everywhere (`version` is already taken twice in this
codebase); the parameter is `since` — a query param on `GET /api/comment/get`, and an optional
field on `ReviewStartRequest` so the daemon can fail-fast for `review run`. Every listed response
carries the current generation, so the agent's cursor can never silently go stale: whatever it
called last handed it a fresh value. No dedicated "get generation" command is needed.

Implementation note: `review start` should report the generation as of *after* launch completes
(post thread-injection and staging drain — i.e. after awaiting the pending snapshot chain), so
the baseline sits above the agent's own drained comments.

## Accepted rough edge: staged imports

`comment add` against a dead instance stages the import and returns the *current* (unbumped)
generation with `{"staged": true}`. The bump happens at drain on the next launch, so a consumer
with an older cursor will see the agent's own staged comments in its next delta (self-echo). This
is accepted: the mandatory author-classification rule filters them, the case is rare in the main
cycle, and threading staging-time generations through the drain is not worth the complexity.
(For the staging agent itself the wart mostly heals: the post-drain baseline returned by
`review start` already covers its own staged comments.)

## Error model touch points

Adding `CURSOR_INVALID` means all four places in lockstep, plus the enum:

1. `RevuErrorCode` enum in `packages/plan-schema`;
2. `TaskError` throw sites in `daemon/registry.ts`;
3. HTTP mapping in `daemon/server.ts:sendError` → **409**;
4. `ERROR_EXIT_CODES` in `shared/protocol.ts` → **13**;
5. skills: one line — "on `CURSOR_INVALID`, retry without `--since` and process the full state".

## Contract updates shipped with the implementation

- `skills/request-review/SKILL.md` — the main rewrite: cursor discipline in the cycle
  (`review start` → baseline; `comment add` advances the cursor; `review run --since <cursor>` →
  delta; empty delta = "no review findings"; `CURSOR_INVALID` recovery).
- `skills/review-code/SKILL.md`, `skills/request-plan-review/SKILL.md` — point edits where
  `review run` / `comment get` response shapes are quoted.
- `docs/difit-wrapper-design.md` — cross-reference to this document.

## Deliberately deferred (out of scope)

- **Plan generations.** `plan set` is a full overwrite and a silent last-write-wins between two
  agent contexts today. Discussed and postponed: stamping `plan.json` with a generation, a
  compact `plan: {generation, changed}` hint in delta responses, and optimistic-concurrency
  `plan set --if-generation N` (`PLAN_CONFLICT`). The plan-changed signal is of a different
  nature than comment feedback and will be designed separately.
- Per-message "new" markers in deltas.
- Exposing `generation` in `review list` / `TaskSummary`.
