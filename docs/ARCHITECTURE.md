# Architecture

relay exists because one person using several coding-agent subscriptions wastes most of them on re-read context and re-explained decisions. It makes the subscriptions work as one system without building a new agent.

## The rules

1. **Tasks move, credentials never do.** Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.
2. **The board is the task bus.** A task is a thread in its project's queue on the team's Vercel Board (`work/<project>`), a `lane` label picks the lane, a pull request on GitHub is the result, and the thread is the record of what happened to it. Labels only steer: what relay acts on (the repository, the pull request, a run's outcome, a release) is in the task's own text or in blocks whose author the board verifies. The lane registry is open: `claude`, `codex`, `grok` and `nodes` are the built-in lanes `relay work` serves, `any` is whichever code lane is free, and an app that wants to be a worker for a lane of its own (`embroidery`), one per craft, claims tasks from the board directly with `vercel board tasks` or `@vercel/board`; tasks may be opened on it while a worker that lists it is online (docs/WORKERS.md).
3. **Every step starts fresh with a small brief.** No transcript is ever sent to a model. A brief is the repo's rules file, the task, relevant decisions, and the vendor guidance that matches the intent.
4. **Official vendor sources only.** Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.
5. **Everything is an event.** One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

## Pieces

| Piece | What | Where it runs |
|---|---|---|
| Front end | Any chat agent that can call the site's MCP tools or API, or a terminal with `relay task`. Grok Bot is the reference. | wherever the user talks |
| Task bus | Channels on the team's Vercel Board: `work/<project>` is a project's queue (every thread in it is a task), `relay/workers` has one message per worker machine. The only labels on a task are `lane` and `model` (`packages/core/src/board/mapping.ts`). Where the work happens is a `relay-task@1` block in the task's own text (`repo`, `base`, `issue`); how a run ended, an eval's verdict and a gate release are `relay-run@1`, `relay-eval@1` and `relay-release@1` blocks in replies, counted only from an author the worker takes work from (`packages/core/src/board/schemas.ts`). A task's ID is the board's message ID | Vercel Board |
| Workers | Machines running `relay work`: they show their lanes from their logins in `relay/workers`, claim ready tasks from the board with the machine's own `vercel login`, run `claude -p`, `codex exec`/`fx`, or `grok -p` in a fresh clone, open a PR and report in the task's thread (`docs/WORKERS.md`). | the user's machines |
| Scheduler | The board's own tasks: a claim gives the oldest ready task under `work/` whose `lane` label and owner match to exactly one claimer, under a lease of at most 5 minutes that the job renews; a worker with nothing to take waits on the board instead of polling (`packages/core/src/work/worker.ts`) | Vercel Board |
| Steps | Named instructions a lane runs at a fixed point of a task: comment cleanup before the PR, a second lane's eval after it, a cleanup pass on demand. Markdown files in three layers (relay's, the user's, the project's), listed per project in `.relay/project.json` (`docs/STEPS.md`) | the worker, from the repo's default branch |
| Task state | The board's task state plus the kind of its hold, folded into one word by `relayState` (`waiting`, `queued`, `running`, `review`, `held`, `blocked`, `done`, `failed`, `closed`). Nothing else keeps a task's state: the CLI, the site and the MCP tools all ask the board | Vercel Board |
| The site | A caller on the board like any other: it reads tasks and workers from it, writes for each person or bot as a profile, and copies the queues' events into the feed ("The site and the board" below) | the web app |
| Memory | Postgres: projects, file digests keyed by content hash, decisions with validity, preferences, vendor guidance with vector and full-text search | Neon in production, PGlite locally |
| Memory server | MCP over stdio for the CLIs and over HTTP for cloud agents | the web app and each machine |
| Rules file | A generated `relay.md` per repo, referenced from `AGENTS.md`/`CLAUDE.md` through an owned, marker-delimited section | in every linked repo |
| Hooks | Session-start injection and session-end capture for Claude Code, Codex, and Grok Build | each machine |
| Feed | The events table plus a web page over it, with usage meters as a rollup. A task's turns, its runs and its model calls are copied from the board by the site's ledger; GitHub and Vercel webhooks, memory and access write the rest (`docs/FEED.md`) | the web app |
| Onboarding gate | A model cannot be used by a lane until its official docs and skills are ingested | CLI and runners |

## Lanes

A lane is one way a task gets executed on one subscription: a `lane` label on the board, served by a machine the
user owns that runs `relay work`.

| Label | Executes on | Login lives | Brief | Result | Usage in the ledger |
|---|---|---|---|---|---|
| `lane=claude` | a worker, `claude -p` (Bash in Claude Code's OS sandbox, acceptEdits, tool allowlist, max turns) | the worker's keychain | the newest `brief.md` attached to the task's thread by a trusted author (the site posts one for a new task), else the machine's own memory; the task text and the thread's notes are added as quoted data | `relay/claude-<ref>` PR (`<ref>`: eight hex characters of the task ID's hash) | yes, `relay-usage@1` blocks the worker posts in the task's thread, next to the run's `relay-run@1` block; the site's ledger copies them into the feed |
| `lane=codex` | a worker, `codex exec --sandbox workspace-write` or `fx` | the worker's `~/.codex` | same | `relay/codex-<ref>` PR | yes |
| `lane=grok` | a worker, `grok -p` (acceptEdits, no subagents) | the worker's `~/.grok` | same | `relay/grok-<ref>` PR | yes |
| `lane=nodes` | a worker with the Griptape Nodes engine, the workflow the task's manifest names | the vendor keys in the worker's environment | none | outputs attached to the task's thread, no PR | yes, one block per output model |

The vendors' hosted tiers are not lanes on the board. The GitHub Actions path (`docs/RUNNERS.md`: self-hosted
runners, `run-lane.sh`, the `relay-cloud.yml` caller) still reports through GitHub issues, nothing tracks its runs,
and it is scheduled for removal.

## A task's life

1. A human or bot opens a task in the project's queue: `relay task create`, the site (`relay_task_create`,
   `POST /api/v1/tasks`), an `agent:<lane>` label on a GitHub issue where the site is connected to GitHub, or anything
   that makes a task in `work/<project>` with a `lane` label and a `relay-task@1` block that names the repository.
   relay makes it out of every worker's reach, runs the injection gate's deterministic pre-check, and either holds it
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
6. Someone decides with `relay task approve` or `relay task changes --note`, on the task's page on the site
   (`/tasks/<id>`), over `/api/v1/tasks/<id>/…`, or through `relay_task_approve` / `relay_task_request_changes`;
   each is the same function in `packages/core/src/board/tasks.ts`. Approve: relay merges the pull request
   the hold names, and only if its head is a branch relay pushed for that task; it squash-merges through GitHub,
   deletes the branch and completes the task (`done`), taking the `lane` label off before the hold lifts so no
   worker can claim it in between. The merge is the approval of record. Request changes: the note goes in the
   thread and on the PR and the hold is lifted; the task is `queued` again, the next run reads the whole thread and
   pushes to the same branch and PR. A pull request merged on GitHub itself completes the task the same way, when
   the site receives the delivery.
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
   and the next run attaches the next version to the same thread. The task's page lists the outputs; they cannot be
   downloaded from the site yet (`docs/PRODUCTIONS.md`).
7. Every step above is a message, a block or a task change in the task's thread on the board, with tokens and cost
   in the usage blocks. The state is never written by hand: it is the board's own (`ready`, `claimed`, `blocked`,
   `completed`, `failed`, `canceled`) and the kind of the hold, which `relayState` in
   `packages/core/src/board/mapping.ts` folds into the one word relay shows.

## The site and the board

The hosted site is one more caller on the board, not a second copy of it (`packages/core/src/board/site.ts`,
`apps/web/lib/board.ts`). There is no task index in the database: a page, an API route and an MCP tool each ask the
board.

**Who it is.** The site acts as its deployment, `vercel:project:<id>:production`, whoever is signed in. Every write
it makes for a person or a bot is made as a profile named for them (`actorProfile`: `human:kyleroche` writes as
`human-kyleroche`, `bot:grok-bot` as `bot-grok-bot`), so the board shows who opened, approved or closed a task. A
team's projects start with read, post and label on its board; lifting a hold or calling off a task someone else
opened takes everything in `work/`, which is the grant `relay setup --board --site-project <name>` makes
(`docs/WORKERS.md`, "A machine becomes a worker").

**What it reads.** Open tasks with `listTasks` (the board's working columns, `relay_task_list`,
`GET /api/v1/tasks`), oldest first as a queue is worked. Finished tasks and History with `recentTasks`, newest
first by latest activity: one project pages back through everything, and across projects it is the newest page
only. Workers with `listWorkers`, read at most once every 20 seconds per instance; the header's plan meters are
`RELAY_PLAN_METERS` when set, else the freshest readings in the workers' own messages.

**What it writes.** `apps/web/lib/task-ops.ts` is every decision (open, approve, request changes, release, requeue,
close) for the API routes and the pages' server actions, and each one is the function the CLI calls
(`packages/core/src/board/tasks.ts`); the MCP tools at `/mcp` call the same functions. One rule is the site's own,
because only the site knows a caller is a bot with a token: releasing a gate hold needs `tokens:write`, and a bot
never releases a task it opened, judged by who the board says wrote the task.

**What the board wakes it for.** Two watchers on every project's queue (`work/`), served at `/api/board`
(`apps/web/lib/board-watch.ts`); the board verifies its own wake-ups, so the route needs no session.

- `ledger` brings the feed up to the board (`syncLedger`). It reads the queues' events from a cursor kept in the
  settings table (`board.ledger.cursor`; the first call starts from the last 100 events) and writes each row once,
  by its dedupe key, so a wake-up and a page load can overlap. Where nothing wakes the deployment (local dev, a
  board at `BOARD_URL`), the pages that show the feed run the same sync, at most once every 15 seconds per
  instance. The board keeps a task's changes for 30 days; the feed is the durable copy, and the usage page is a
  view over it.

  | On the board | Feed row |
  |---|---|
  | a task is created | `task.created` |
  | a worker's lane profile (`relay-<worker>-<lane>`) claims it | `run.started` |
  | a `relay-run@1` block from a trusted author | `run.finished`, or `run.failed` when its outcome is `failed` |
  | a `relay-usage@1` block from a trusted author | `step.usage` |
  | a hold with kind `gate` | `task.held` |
  | the task is completed | `task.approved` |
  | the task is canceled | `task.closed` |
  | a failed task is reopened | `task.requeued` |

  A usage or run block counts only from an author the site believes: its own deployment and the worker logins in
  `RELAY_BOARD_FROM`. A task's own turns are the board's facts and count from anyone.
- `brief` posts relay's memory for a new task in its thread as `brief.md`, once, so a worker needs nothing from the
  site but the board. A step's own task gets none. A worker hands the file to its lane when the site's deployment
  is in that worker's `board.from`.

**GitHub.** Two deliveries act on the board (`apps/web/lib/webhooks/board.ts`). An issue opened with, or given, an
`agent:<lane>` label by an allowed sender (`RELAY_ALLOWED_SENDERS`) opens a task in the queue of the project registered for
that repository, answering that issue: one task per issue, written as `bot:github`. A pull request merged on GitHub
completes the task in review that waits on it (`settleMerged`), under the same branch check as an approval. The
site merges with its own GitHub credential, the GitHub App or `GITHUB_TOKEN`.

**Demo mode** (`RELAY_DATA=mock`) is an in-memory board with relay's schemas, seeded through the same functions a
real one is written with, so every page reads real threads. It has nobody to wake it, and `/api/board` answers 404.

## What relay deliberately does not do

- It does not run a coordinator model. Planning is the front end's job, or the human's.
- It does not host a chat UI. It hosts a feed.
- It does not hold API keys for vendors. Pay-per-token providers are optional overflow lanes the user configures.
