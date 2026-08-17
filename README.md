# revu

Task-oriented code review wrapper around a managed [difit](https://github.com/yoshiko-pg/difit) fork: persistent per-branch review state, walkthrough plans, a blocking "wait for Finish review" cycle for coding agents, and GitLab MR sync.

## Layout

```
packages/difit        difit fork (git subtree); all changes gated behind --managed
packages/revu         the revu daemon + CLI (the only binary installed outside)
packages/plan-schema  walkthrough plan validation + shared types
skills/               Claude Code skills: request-review, request-plan-review, review-code
docs/                 design documents
```

## Install (MVP, from clone)

```bash
pnpm install
pnpm build
# put `revu` on PATH (pnpm 11 removed `pnpm link --global`; a wrapper script is simplest):
printf '#!/bin/sh\nexec node "%s/packages/revu/dist/cli/index.js" "$@"\n' "$PWD" > /opt/homebrew/bin/revu
chmod +x /opt/homebrew/bin/revu
```

Requires Node >= 21, pnpm 11, git. GitLab sync additionally requires `glab` (`glab auth login`).

## Usage

```bash
revu daemon up                 # start the daemon (detached, port 7388)
revu review run --open         # start review for the current branch, block until Finish review
revu review list
revu comment add '<json>'      # add anchored comments (queued if instance is down)
revu comment get
revu plan validate plan.json   # walkthrough plan: validate / set / get / check
revu plan set plan.json
revu sync pull | push          # GitLab MR discussions (needs glab)
```

State lives in `~/.revu/state/<repositoryId>/<taskKeyHash>/` (threads, resolved archive, plan + snippet hashes, staging queue, sync state). The daemon is the only writer; the CLI talks to it over localhost HTTP (port 7388). difit instances get sticky ports 7400-7463 per task.

Config (optional): `~/.revu/config.json` — `{"daemonPort": ..., "instancePorts": {"from":..., "to":...}, "glabPath": "..."}`.

## Agent skills

`skills/request-review` — ask the user for a review (commit → plan → `revu review run` → address feedback).
`skills/request-plan-review` — discuss a feature plan on a real diff before implementing: commit a compilable design sketch (signatures + doc comments + wiring, stub bodies) and run the review cycle on it.
`skills/review-code` — review a diff yourself and present findings as anchored threads + a walkthrough plan.
