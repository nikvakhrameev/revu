---
name: request-plan-review
description: Discuss a feature plan with the user on a real diff before implementing it. Commit a compilable design sketch (signatures, doc comments, wiring; bodies are panic("not implemented") stubs) and run the revu review cycle on it.
---

# Plan Review via Sketch Commit (revu)

## Overview

revu reviews only committed code, but plans are worth discussing *before* the code exists. This skill bridges that: translate the plan into a **design sketch** — the shape of the change without the implementation — commit it on a feature branch, and drive the normal revu review cycle over it. Decisions get discussed as line-anchored threads on a real diff instead of prose in chat.

This skill defines **what to commit and how to structure the plan and comments**. All revu mechanics — commands, the Finish-review cycle, comment format, walkthrough plan format, error handling — come from the `request-review` skill: load it alongside this one and follow it for everything not covered here.

## When to use

- The user wants to plan a feature and see/discuss the plan before implementation ("покажи план изменений до реализации", "давай сначала согласуем подход").
- The change has real design decisions worth agreeing on: API shape, behavioural semantics, data formats, error handling.

Do not use when the user asked for the implementation directly, or for changes too small to have decisions in them — sketching a one-liner is overhead, just implement and use `request-review`.

## The sketch

A sketch is a commit that contains the *shape* of the feature and none of its logic.

What goes in:

- **Types, fields, tags** — real. Data-format decisions (JSON tags, schema shapes) are part of the plan.
- **Function/method signatures with doc comments.** The doc comments carry the plan: state the behavioural decisions there (what happens on a missing file, error semantics, atomicity guarantees, ...). On the review they become the text the decision threads anchor to.
- **Wiring in callers** — real calls showing where the new API plugs in, including error handling. This makes the diff show the blast radius of the change.
- **Stub bodies** for everything unimplemented, one idiom per language: Go `panic("not implemented: planned in this sketch")`, TypeScript/JavaScript `throw new Error("not implemented: planned in this sketch")`, Python `raise NotImplementedError("planned in this sketch")`, Rust `todo!()`.
- **A file-top comment in new files** saying this is a design sketch and the bodies are stubs on purpose.

Rules:

- **The sketch must compile and pass the project's static checks** (e.g. `go build` + `go vet`, `tsc`). The shape is real; only the behaviour is missing.
- **No implementation logic in stubs.** If you catch yourself writing the algorithm, stop — that is the next phase, after the plan is agreed.
- **Keep the diff clean**: no build artifacts (add/extend `.gitignore` *before* committing), no scratch files. A binary or a stray file in the diff is noise the reviewer has to wade through.
- Commit on a feature branch. Mark the commit as a sketch so history stays honest, e.g. `sketch: file persistence for tasks (design draft, stubs only)`, with a body noting that the commit exists to review the shape before implementing.

## Structuring the review

Follow `request-review` for the mechanics; shape the content like this:

- **Walkthrough plan** (strongly recommended here, even for smaller diffs — it is the document under review):
  - The overview page must say explicitly that this is a plan, not an implementation: bodies are stubs on purpose, the review is about the shape and the decisions.
  - Route the pages by decision area, e.g.: data/format decisions → new API surface → wiring in callers → **open questions**.
  - The **open questions** page lists the decisions you need from the user, each with your proposed default and the alternative. This page is the review's agenda.
- **Anchored comments**: one thread per decision point, anchored to the doc comment or signature that embodies it. Phrase each as a decision to confirm — state what you chose, the alternative you rejected, and why. Give threads stable ids like `agent-plan-<decision>`.
- Then run the blocking review (`revu review run --open`) and wait for Finish. On later rounds pass `--since <generation>` (the cursor from the previous round's response) to receive only new feedback; on `CURSOR_INVALID` (exit 13), retry without `--since` and process the full state.

## Iterating on decisions

When Finish brings back decision changes:

1. Rework the sketch accordingly and commit (still the `sketch:` prefix — it is still a plan).
2. Update the walkthrough plan: mark settled items on the open-questions page as resolved (keep them visible — they document the agreement), describe the new/changed parts, refresh snippet line ranges (`revu plan check` shows what went stale), bump the title (v2, v3...).
3. Reply into every user thread you acted on, stating what changed.
4. Add new threads on sketch code that appeared in the rework.
5. Run the review again. Repeat until Finish comes back with an empty delta — no new user feedback.

## After approval

An empty delta at Finish (no new user feedback) = the plan is agreed. Implement for real, replacing the stubs; the agreed doc comments stay as the behaviour contract, and the open-questions page records what was decided.

**Give the implementation review a clean slate.** Review state (threads, walkthrough plan) sticks to the task key — repo + source branch + base branch. Rerunning the review on the sketch branch would re-inject every planning thread into the implementation review, but the reviewer wants only implementation comments there. Start a fresh task instead — either:

- implement on a new branch (convention: sketch on `feat/x-sketch`, implementation on `feat/x` branched from it) and review against the normal base — full-feature diff, clean thread list; or
- keep a branch pinned at the sketch head and pass `--base <that-branch>` — the diff is then just sketch → implementation, useful when the agreed shape is large and only the delta needs reading.

The planning threads are not lost: they stay archived with the sketch task (`revu review list` still shows it). Write a fresh walkthrough plan and fresh comments for the implementation, and run it as a normal `request-review` cycle, not this skill.
