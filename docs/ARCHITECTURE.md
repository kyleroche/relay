# Architecture

relay exists because one person using several coding-agent subscriptions wastes most of them on re-read context and re-explained decisions. It makes the subscriptions work as one system without building a new agent.

## The rules

1. **Tasks move, credentials never do.** Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.
2. **GitHub is the task bus.** An issue is a task, a label picks the lane, a pull request is the result. Nothing of record lives anywhere else.
3. **Every step starts fresh with a small brief.** No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.
4. **Official vendor sources only.** Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.
5. **Everything is an event.** One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

## Pieces

| Piece | What | Where it runs |
|---|---|---|
| Front end | Any chat agent that can file GitHub issues and call a webhook. Grok Bot is the reference; a plain terminal works. | wherever the user talks |
| Task bus | Issues, labels (`agent:claude`, `agent:codex`, `agent:grok`; `agent:claude-cloud`, `agent:codex-cloud` for the vendors' hosted tiers), one Projects board across repos | GitHub |
| Workers | Machines running `relay work`: they register their lanes from their logins, claim queued tasks from the site under a lease, run `claude -p`, `codex exec`/`fx`, or `grok -p` in a fresh clone and open a PR (`docs/WORKERS.md`). Self-hosted GitHub Actions runners remain an optional path (`docs/RUNNERS.md`). | the user's machines |
| Scheduler | The `workers` and `claims` tables plus `claimNext`: oldest queued task whose lane and required labels match, one live claim per task, 30-minute leases renewed by heartbeats | the web app (or the local database) |
| Memory | Postgres: projects, file digests keyed by content hash, decisions with validity, preferences, vendor guidance with vector and full-text search | Neon in production, PGlite locally |
| Memory server | MCP over stdio for the CLIs and over HTTP for cloud agents | the web app and each machine |
| Rules file | A generated `relay.md` per repo, referenced from `AGENTS.md`/`CLAUDE.md` through an owned, marker-delimited section | in every linked repo |
| Hooks | Session-start injection and session-end capture for Claude Code, Codex, and Grok Build | each machine |
| Feed | The events table plus a web page over it, with usage meters and worker health as rollups | the web app |
| Onboarding gate | A model cannot be used by a lane until its official docs and skills are ingested | CLI and runners |

## Lanes

A lane is one way a labelled issue gets executed on one subscription. The worker lanes execute on a machine the
user owns that runs `relay work`; the cloud lanes hand the issue to the vendor's hosted tier and own nothing but the
dispatch comment.

| Label | Executes on | Login lives | Brief | Result | Usage in the ledger |
|---|---|---|---|---|---|
| `agent:claude` | a worker, `claude -p` (Bash in Claude Code's OS sandbox, acceptEdits, tool allowlist, max turns) | the worker's keychain | the worker fetches `GET /api/v1/projects/<slug>/brief?issue=N` and adds the issue text as quoted data | `relay/claude-<issue>` PR | yes, reported by the worker through `POST /api/v1/work/{task}/release` |
| `agent:codex` | a worker, `codex exec --sandbox workspace-write` or `fx` | the worker's `~/.codex` | same | `relay/codex-<issue>` PR | yes |
| `agent:grok` | a worker, `grok -p` (acceptEdits, no subagents) | the worker's `~/.grok` | same | `relay/grok-<issue>` PR | yes |
| `agent:codex-cloud` | Codex cloud (OpenAI's sandbox) on the ChatGPT plan | ChatGPT's GitHub connector, installed once | the site compiles it and posts it under `@codex` when the task is opened (`relay-cloud.yml` does the same for a label put on by hand) | `codex/...` PR from the connector | dispatch only (`run.dispatched`), tokens on the vendor's usage page |
| `agent:claude-cloud` | Claude Code cloud session or Routine (Anthropic's VM) on the Pro/Max plan; or claude-code-action on GitHub's runner, opt-in | the Claude GitHub App, installed once (the action variant stores a subscription token in GitHub, which rule 1 discourages) | same, under `@claude`, optionally also as a Routine API fire | `claude/...` branch and PR | dispatch only |

Cloud lanes trade the usage line and the cross-model review for zero machines; `docs/RUNNERS.md` says when to move
an issue from one to the other. Self-hosted GitHub Actions runners (`docs/RUNNERS.md`) are an optional way to serve
the worker lanes for people who already operate them.

## A task's life

1. A human or bot opens an issue with a lane label: `relay task create`, `relay_task_create`, `POST /api/v1/tasks`,
   or a label on GitHub (the webhook records it as a task). The task is `queued`.
2. A worker whose logins allow that lane, and whose labels satisfy the project's `lane.labels`, claims it from the
   site under a 30-minute lease that its heartbeat renews. The task is `claimed`.
3. The worker clones the repo fresh, branches `relay/<lane>-<issue>` from the base, fetches the brief, reports
   `run.started` (`running`), and runs the vendor CLI headless with the planner and subagents disabled and the
   vendor's own permission model.
4. The result is committed as `relay-agent` and pushed; a PR opens with `Closes #N` and the usage line as a comment;
   the worker reports `run.finished` with tokens and cost (`review`). A lane that fails or changes nothing reports
   `run.failed` (`failed`). A worker that vanishes loses its lease and the task is `queued` again.
5. Vercel or the repo's CI builds the preview; `preview.ready` lands with the URL and the task page shows it first.
   A review lane, on a different model, comments.
6. Someone decides, on the task page (`/tasks/<owner>/<repo>/<n>`), from chat through `relay_task_approve` /
   `relay_task_request_changes`, over REST, or with `relay task approve` / `relay task changes`. Approve: relay
   squash-merges the PR through GitHub, deletes the branch and writes `task.approved` (`done`; GitHub's `pr.merged`
   confirms it). Request changes: the note goes on the PR and into `task.changes_requested`; the task is `queued`
   again, the next run reads the note under "Review feedback" in its brief and pushes to the same branch and PR. A bot
   may decide only with `tasks:write` and never on a PR its own lane produced. On merge, a job extracts decisions into
   memory and regenerates the rules file.
   At any point before `done`, a requeue (the task page, `relay_task_requeue`, `POST …/requeue`, `relay task requeue`)
   puts the task back in the queue, optionally on another lane: relay moves the `agent:*` label on the issue (best
   effort), releases a live claim, writes `task.requeued` (`queued`) and rings the doorbell; the next run starts over
   from the base branch and reuses an open PR. That is how a task opened on a cloud lane nobody wired, or one whose
   worker vanished, gets to a machine without waiting for a GitHub webhook that may never arrive.
7. Every step above is a row in the feed.

## What relay deliberately does not do

- It does not run a coordinator model. Planning is the front end's job, or the human's.
- It does not host a chat UI. It hosts a feed.
- It does not hold API keys for vendors. Pay-per-token providers are optional overflow lanes the user configures.
