# Architecture

relay exists because one person using several coding-agent subscriptions wastes most of them on re-read context and re-explained decisions. It makes the subscriptions work as one system without building a new agent.

> **The site moves next.** Workers and the CLI's task commands run on the team's Vercel Board, as described here. The web app's board page, the `/api/v1` task routes, the `relay_task_*` MCP tools and the feed's run and usage rows still use the site's own task table and events, which no worker reads or writes; they move to the board in the next step.

## The rules

1. **Tasks move, credentials never do.** Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.
2. **The board is the task bus.** A task is a thread in its project's queue on the team's Vercel Board (`work/<project>`), a `lane` label picks the lane, a pull request on GitHub is the result, and the thread is the record of what happened to it. Labels only steer: what relay acts on (the repository, the pull request, a run's outcome, a release) is in the task's own text or in blocks whose author the board verifies. The lane registry is open: `claude`, `codex`, `grok` and `nodes` are the built-in lanes `relay work` serves, `any` is whichever code lane is free, and an app that wants to be a worker for a lane of its own (`embroidery`), one per craft, claims tasks from the board directly with `vercel board tasks` or `@vercel/board`; tasks may be opened on it while a worker that lists it is online (docs/WORKERS.md).
3. **Every step starts fresh with a small brief.** No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.
4. **Official vendor sources only.** Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.
5. **Everything is an event.** One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

## Pieces

| Piece | What | Where it runs |
|---|---|---|
| Front end | Any chat agent that can file GitHub issues and call a webhook. Grok Bot is the reference; a plain terminal works. | wherever the user talks |
| Task bus | Channels on the team's Vercel Board: `work/<project>` is a project's queue (every thread in it is a task), `relay/workers` has one message per worker machine. The only labels on a task are `lane` and `model` (`packages/core/src/board/mapping.ts`). Where the work happens is a `relay-task@1` block in the task's own text (`repo`, `base`, `issue`); how a run ended, an eval's verdict and a gate release are `relay-run@1`, `relay-eval@1` and `relay-release@1` blocks in replies, counted only from an author the worker takes work from (`packages/core/src/board/schemas.ts`). A task's ID is the board's message ID | Vercel Board |
| Workers | Machines running `relay work`: they show their lanes from their logins in `relay/workers`, claim ready tasks from the board with the machine's own `vercel login`, run `claude -p`, `codex exec`/`fx`, or `grok -p` in a fresh clone, open a PR and report in the task's thread (`docs/WORKERS.md`). Self-hosted GitHub Actions runners remain an optional path (`docs/RUNNERS.md`). | the user's machines |
| Scheduler | The board's own tasks: a claim gives the oldest ready task under `work/` whose `lane` label and owner match to exactly one claimer, under a lease of at most 5 minutes that the job renews; a worker with nothing to take waits on the board instead of polling (`packages/core/src/work/worker.ts`) | Vercel Board |
| Steps | Named instructions a lane runs at a fixed point of a task: comment cleanup before the PR, a second lane's eval after it, a cleanup pass on demand. Markdown files in three layers (relay's, the user's, the project's), listed per project in `.relay/project.json` (`docs/STEPS.md`) | the worker, from the repo's default branch |
| Task state | On the board: the board's task state plus the kind of its hold, folded into one word by `relayState` (`waiting`, `queued`, `running`, `review`, `held`, `blocked`, `done`, `failed`, `closed`). On the site, until it moves: derived from the feed by one fold (`deriveTaskStatus`, then the station in `tasks/station.ts`) and cached on the task row after every write that can change it (`db/task-state.ts`): `state`, `station`, `since`, the PR, the preview, the runner, the last error. The feed stays the source of truth; the columns let the board and the tasks list read one query instead of every history | the database |
| Memory | Postgres: projects, file digests keyed by content hash, decisions with validity, preferences, vendor guidance with vector and full-text search | Neon in production, PGlite locally |
| Memory server | MCP over stdio for the CLIs and over HTTP for cloud agents | the web app and each machine |
| Rules file | A generated `relay.md` per repo, referenced from `AGENTS.md`/`CLAUDE.md` through an owned, marker-delimited section | in every linked repo |
| Hooks | Session-start injection and session-end capture for Claude Code, Codex, and Grok Build | each machine |
| Feed | The events table plus a web page over it, with usage meters and worker health as rollups | the web app |
| Onboarding gate | A model cannot be used by a lane until its official docs and skills are ingested | CLI and runners |

## Lanes

A lane is one way a labelled task gets executed on one subscription. The worker lanes execute on a machine the
user owns that runs `relay work` and are `lane` labels on the board; the cloud lanes are GitHub labels the site
dispatches: they hand the issue to the vendor's hosted tier and own nothing but the dispatch comment.

| Label | Executes on | Login lives | Brief | Result | Usage in the ledger |
|---|---|---|---|---|---|
| `lane=claude` | a worker, `claude -p` (Bash in Claude Code's OS sandbox, acceptEdits, tool allowlist, max turns) | the worker's keychain | the newest `brief.md` attached to the task's thread by a trusted author, else the machine's own memory; the task text and the thread's notes are added as quoted data | `relay/claude-<ref>` PR (`<ref>`: eight hex characters of the task ID's hash) | yes, `relay-usage@1` blocks the worker posts in the task's thread, next to the run's `relay-run@1` block |
| `lane=codex` | a worker, `codex exec --sandbox workspace-write` or `fx` | the worker's `~/.codex` | same | `relay/codex-<ref>` PR | yes |
| `lane=grok` | a worker, `grok -p` (acceptEdits, no subagents) | the worker's `~/.grok` | same | `relay/grok-<ref>` PR | yes |
| `agent:codex-cloud` | Codex cloud (OpenAI's sandbox) on the ChatGPT plan | ChatGPT's GitHub connector, installed once | the site compiles it and posts it under `@codex` when the task is opened (`relay-cloud.yml` does the same for a label put on by hand) | `codex/...` PR from the connector | dispatch only (`run.dispatched`), tokens on the vendor's usage page |
| `agent:claude-cloud` | Claude Code cloud session or Routine (Anthropic's VM) on the Pro/Max plan; or claude-code-action on GitHub's runner, opt-in | the Claude GitHub App, installed once (the action variant stores a subscription token in GitHub, which rule 1 discourages) | same, under `@claude`, optionally also as a Routine API fire | `claude/...` branch and PR | dispatch only |

Cloud lanes trade the usage line and the cross-model review for zero machines; `docs/RUNNERS.md` says when to move
an issue from one to the other. Self-hosted GitHub Actions runners (`docs/RUNNERS.md`) are an optional way to serve
the worker lanes for people who already operate them.

## A task's life

1. A human or bot opens a task in the project's queue: `relay task create`, or anything that makes a task in
   `work/<project>` with a `lane` label and a `relay-task@1` block that names the repository. `relay task create`
   makes it out of every worker's reach, runs the injection gate's deterministic pre-check, and either holds it
   (`held`) or releases it: the task is `queued` (`waiting` while a task it needs is open).
2. A worker whose logins serve that lane, and that takes tasks from the task's owner, claims it: the board gives
   the oldest ready task to exactly one claimer, under a lease of at most 5 minutes that the job renews. The task
   is `running`. A claim the board ends (the lease ran out, the task was closed) aborts the lane's CLI, and the
   board is asked once more right before anything is pushed.
3. The worker reads the thread, clones the repo fresh, and grades the task's text and the thread's notes with the
   injection gate (`packages/core/src/tasks/gate.ts`, `docs/SECURITY.md` "The gate"): the pre-check, then one Sonnet
   call with no tools. Text that reads as instructions to the agent rather than to the work holds the task (`held`):
   nothing runs, and it waits for `relay task release`, which posts a `relay-release@1` block with the digest of the
   text as it stands and lifts the hold (`queued`). That text is not graded again; text added afterwards is. A
   tripwire, not a boundary: the sandbox is what contains a lane. Otherwise the worker branches
   `relay/<lane>-<ref>` from the base, takes the brief (the thread's `brief.md`, else the machine's own memory) and
   runs the vendor CLI headless with the planner and subagents disabled and the vendor's own permission model.
4. The project's `before-pr` steps go over the change (`docs/STEPS.md`; steps are read from the repository's default
   branch, whatever base the task starts from). The result is committed as the machine's GitHub login, with
   `relay-agent` as co-author, and pushed; a PR opens, with `Closes #n` when the task's block names an issue in the
   same repository, and the lane's summary as a comment. The worker posts the summary, a `relay-run@1` block and
   the `relay-usage@1` blocks in the thread and holds the task for review, with the pull request's URL as the
   hold's reason (`review`). A lane that fails or changes nothing fails the task with the reason (`failed`). A
   worker that vanishes stops renewing its lease and the task is `queued` again.
5. With an `after-pr` step listed (`eval`), a second lane judges the PR before a person is asked: the runner opens
   the step's task, holds the work with kind `awaiting_eval` (`blocked`) and only then releases the step's task.
   That task posts its findings and a `relay-eval@1` block in the work's thread and lifts the hold; the first lane
   answers on the same branch, and then the task is in `review`. A step that cannot run says why and holds the work
   for review itself. One round per task (`docs/STEPS.md`, "The eval round on the board").
6. Someone decides with `relay task approve` or `relay task changes --note`. Approve: relay merges the pull request
   the hold names, and only if its head is a branch relay pushed for that task; it squash-merges through GitHub,
   deletes the branch and completes the task (`done`), taking the `lane` label off before the hold lifts so no
   worker can claim it in between. The merge is the approval of record. Request changes: the note goes in the
   thread and on the PR and the hold is lifted; the task is `queued` again, the next run reads the whole thread and
   pushes to the same branch and PR. On merge, a job extracts decisions into memory and regenerates the rules file.
   At any point before that, `relay task requeue` puts a failed or held task back in the queue, optionally on
   another lane or model, and `relay task close` cancels it (`closed`), calls off a step's task that was looking at
   it, and on GitHub, best effort, closes its own open pull requests, deletes their branches and closes its issue.
   A running task is its worker's until the lease ends. The board's grants decide who may do what: only a task's
   owner, or someone with `manage` in its channel, lifts a hold, reopens or cancels.
   **The asset path.** A production (a film: script, characters, shots, voice-over, the cut) is a relay project with
   no checkout, registered with `relay project add <slug> --repo owner/name`; several productions share one GitHub
   repository. The deliverable of a `nodes` task is not a PR: the run attaches every output to the task's thread
   with a `relay-asset@1` block (the node and parameter it came from, its index, its version) and holds the task for
   review. `relay task approve` completes it with no GitHub involved; `relay task changes --note` sends it back,
   and the next run attaches the next version to the same thread. Filing the outputs in the asset library and
   reviewing them on the board page (`docs/PRODUCTIONS.md`) is the site's part, which moves next.
7. Every step above is a message, a block or a task change in the task's thread on the board, with tokens and cost
   in the usage blocks. The state is never written by hand: it is the board's own (`ready`, `claimed`, `blocked`,
   `completed`, `failed`, `canceled`) and the kind of the hold, which `relayState` in
   `packages/core/src/board/mapping.ts` folds into the one word relay shows.

## What relay deliberately does not do

- It does not run a coordinator model. Planning is the front end's job, or the human's.
- It does not host a chat UI. It hosts a feed.
- It does not hold API keys for vendors. Pay-per-token providers are optional overflow lanes the user configures.
