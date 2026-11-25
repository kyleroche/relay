# Architecture

relay exists because one person using several coding-agent subscriptions wastes most of them on re-read context and re-explained decisions. It makes the subscriptions work as one system without building a new agent.

## The rules

1. **Tasks move, credentials never do.** A lane's model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI. Two things are paid per token instead, and both are opt-in: the lead ("The lead" below) and one task a person approved a paid sandbox run for (`docs/WORKERS.md`, "One task on paid credits").
2. **The board is the task bus.** A task is a thread in its project's queue on the team's Vercel Board (`work/<project>`), a `lane` label picks the lane, a pull request on GitHub is the result, and the thread is the record of what happened to it. Labels only steer: what relay acts on (the repository, the pull request, a run's outcome, a release) is in the task's own text or in blocks whose author the board verifies. The lane registry is open: `claude`, `codex`, `grok` and `nodes` are the built-in lanes `relay work` serves, `any` is whichever code lane is free, and an app that wants to be a worker for a lane of its own (`embroidery`), one per craft, claims tasks from the board directly with `vercel board tasks` or `@vercel/board`; tasks may be opened on it while a worker that lists it is online (docs/WORKERS.md).
3. **Every step starts fresh with a small brief.** No transcript is ever sent to a model. A brief is the repo's rules file, the task, relevant decisions, and the vendor guidance that matches the intent.
4. **Official vendor sources only.** Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.
5. **Everything is an event.** One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

## Pieces

| Piece | What | Where it runs |
|---|---|---|
| Front end | Any chat agent that can call the site's MCP tools or API, or a terminal with `relay task`. Grok Bot is the reference. | wherever the user talks |
| Task bus | Channels on the team's Vercel Board: `work/<project>` is a project's queue (every thread in it is a task), `relay/workers` has one message per worker machine. The labels on a task are `lane` and `model`, which steer it, and `cloud`, a hint that a paid run was granted for it (`packages/core/src/board/mapping.ts`). Where the work happens is a `relay-task@1` block in the task's own text (`repo`, `base`, `issue`); how a run ended, an eval's verdict, a gate release and a grant are `relay-run@1`, `relay-eval@1`, `relay-release@1` and `relay-grant@1` blocks in replies, counted only from an author the worker takes work from, and a release or a grant only from who may decide: a trusted principal itself or the site's `relay-site`, never a worker's profile (`packages/core/src/board/schemas.ts`). A task's ID is the board's message ID | Vercel Board |
| Workers | Machines running `relay work`: they show their lanes from their logins in `relay/workers`, claim ready tasks from the board with the machine's own `vercel login`, run `claude -p`, `codex exec`/`fx`, or `grok -p` in a fresh clone, open a PR and report in the task's thread (`docs/WORKERS.md`). | the user's machines |
| Scheduler | The board's own tasks: a claim gives the oldest ready task under `work/` whose `lane` label and owner match to exactly one claimer, under a lease of at most 5 minutes that the job renews; a worker with nothing to take waits on the board instead of polling (`packages/core/src/work/worker.ts`) | Vercel Board |
| Steps | Named instructions a lane runs at a fixed point of a task: comment cleanup before the PR, a second lane's eval after it, a cleanup pass, a plan or a retro on demand. Markdown files in three layers (relay's, the user's, the project's), listed per project in `.relay/project.json` (`docs/STEPS.md`) | the worker, from the repo's default branch |
| Project profile | The rest of `.relay/project.json`: the commands a worker runs before and after the work, the project's tools and skills, and capability sets (names of environment variables and hosts, never values). A task gets a set only through a `relay-grant@1` block a person gave it for its text as it stands (`docs/PROFILE.md`) | the worker, from the repo's default branch |
| Task state | The board's task state plus the kind of its hold, folded into one word by `relayState` (`waiting`, `queued`, `running`, `review`, `held`, `blocked`, `done`, `failed`, `closed`). Nothing else keeps a task's state: the CLI, the site and the MCP tools all ask the board | Vercel Board |
| The site | A caller on the board like any other: it reads tasks and workers from it, writes for each person or bot as a profile, and copies the queues' events into the feed ("The site and the board" below) | the web app |
| Memory | Postgres: projects, file digests keyed by content hash, decisions with validity, preferences, vendor guidance with vector and full-text search | Neon in production, PGlite locally |
| Memory server | MCP over stdio for the CLIs and over HTTP for cloud agents | the web app and each machine |
| Rules file | A generated `relay.md` per repo, referenced from `AGENTS.md`/`CLAUDE.md` through an owned, marker-delimited section | in every linked repo |
| Hooks | Session-start injection and session-end capture for Claude Code, Codex, and Grok Build | each machine |
| Feed | The events table plus a web page over it, with usage meters as a rollup. A task's turns, its runs and its model calls are copied from the board by the site's ledger; GitHub and Vercel webhooks, memory and access write the rest (`docs/FEED.md`) | the web app |
| Onboarding gate | A model cannot be used by a lane until its official docs and skills are ingested | the CLI and workers |
| The lead (optional) | An agent on Vercel's eve framework that takes an ask in plain language and opens tasks. It reaches relay only through the site's MCP server ("The lead" below) | its own Vercel project |

## Lanes

A lane is one way a task gets executed on one subscription: a `lane` label on the board, served by a machine the
user owns that runs `relay work`.

| Label | Executes on | Login lives | Brief | Result | Usage in the ledger |
|---|---|---|---|---|---|
| `lane=claude` | a worker, `claude -p` (Bash in Claude Code's OS sandbox, acceptEdits, tool allowlist, max turns) | the worker's keychain | the machine's own memory, else the newest `brief.md` attached to the task's thread by a trusted author (the site posts one for a new task); the task text and the thread's notes are added as quoted data | `relay/claude-<ref>` PR (`<ref>`: eight hex characters of the task ID's hash) | yes, `relay-usage@1` blocks the worker posts in the task's thread, next to the run's `relay-run@1` block; the site's ledger copies them into the feed |
| `lane=codex` | a worker, `codex exec --sandbox workspace-write` or `fx` | the worker's `~/.codex` | same | `relay/codex-<ref>` PR | yes |
| `lane=grok` | a worker, `grok -p` (acceptEdits, no subagents) | the worker's `~/.grok` | same | `relay/grok-<ref>` PR | yes |
| `lane=nodes` | a worker with the Griptape Nodes engine, the workflow the task's manifest names | the vendor keys in the worker's environment | none | outputs attached to the task's thread, no PR | yes, one block per output model |

The vendors' hosted tiers are not lanes on the board. One task can run on paid credits instead of a subscription:
a hosted relay offers a queued task that none of the owner's workers can take a run in a Vercel Sandbox, and starts
one only after a person approved a cap for that task. The sandbox runs
`relay work --task <id> --billing gateway --cap <usd>` on the Claude lane through a model gateway, and the job runs
on paid credits only under that grant, within one cap ("Paid sandbox runs" below; `docs/PROFILE.md`).

## A task's life

1. A human or bot opens a task in the project's queue: `relay task create`, the site (`relay_task_create`,
   `POST /api/v1/tasks`), an `agent:<lane>` label on a GitHub issue where the site is connected to GitHub, or anything
   that makes a task in `work/<project>` with a `lane` label and a `relay-task@1` block that names the repository.
   `relay handoff` opens one from a session's work in progress, with the uncommitted work as its starting branch.
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
   tripwire, not a boundary: the sandbox is what contains a lane. Otherwise the worker reads the project's profile
   from the default branch, looks up by name the values of the capability sets the task was granted, branches
   `relay/<lane>-<ref>` from the base, takes the brief (the machine's own memory, else the thread's `brief.md`),
   runs the profile's `setup` commands under the sandbox runtime, and runs the vendor CLI headless with the planner
   and subagents disabled and the vendor's own permission model (`docs/PROFILE.md`).
4. The project's `before-pr` steps go over the change (`docs/STEPS.md`; steps are read from the repository's default
   branch, whatever base the task starts from). The result is committed as the machine's GitHub login, with
   `relay-agent` as co-author, the worker runs the profile's `verify` commands itself and reports each result, and
   the branch is pushed; a PR opens, with `Closes #n` when the task's block names an issue in the
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
   **Plans and reports.** A task that runs a read-only `task` step by itself ends without a pull request. A planning
   task (`relay task create --plan`, `relay_task_create` with `plan: true`) ends with a plan: the worker posts it as
   `plan.json` and holds the task with kind `awaiting_plan`, and approving it opens the plan's tasks as the approver
   and completes the planning task. Without a plan the lane's words are a report, held for review with the reason
   `report`, and approving it completes the task as read. Both show as `review` (`docs/STEPS.md`, "Plans and
   reports").
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
`desk.ts`, `apps/web/lib/board.ts`). There is no task index in the database: a page, an API route and an MCP tool
each ask the board.

**Who it is, and its two voices.** The site acts as its deployment, `vercel:project:<id>:production`, whoever is
signed in. A caller's own words and decisions (a task's text, a review note, an approval) are written as a profile
named for them (`actorProfile`: `human:kyleroche` writes as `human-kyleroche`, `bot:grok-bot` and `bot:oauth:grok-bot`
both as `bot-grok-bot`), so the board shows who opened, approved or closed a task. Those profiles never start
`relay-`, and relay believes data only from a trusted principal itself or from relay's own `relay-…` profiles of it,
so nothing in a caller's words is data, whatever carried it (`docs/SECURITY.md`, "Who relay believes"). What the
site itself says as data, a gate release or an eval that could not run, goes out as its own profile `relay-site`,
after the site has checked who asked. A grant and a gate release are decisions, and a worker believes one only from
a trusted principal itself or from `relay-site`, never from a worker's profile (`isDecidingActor`). A team's projects
start with read, post and label on its board; lifting a
hold or calling off a task someone else opened takes everything in `work/`, which is the grant
`relay setup --board --site-project <name>` makes (`docs/WORKERS.md`, "A machine becomes a worker"). The board page
shows a warning when the deployment does not manage `work/`.

**What it reads.** Open tasks with `listTasks` (the board's working columns, `relay_task_list`,
`GET /api/v1/tasks`), oldest first as a queue is worked. Finished tasks and History with `recentTasks`, newest
first by latest activity: one project pages back through everything, and across projects it is the newest page
only. Workers with `listWorkers`, read at most once every 20 seconds per instance; the header's plan meters are
`RELAY_PLAN_METERS` when set, else the freshest readings in the workers' own messages. A task's usage, on its page
and in `relay_task_get`, is only the rows relay's own authors wrote. A thread outside a project's queue
(`work/<project>`) is no task to any of these, whatever its ID.

**The desk: what it writes, and its rules.** `packages/core/src/board/desk.ts` is the one layer for what a site does
to a task (open, approve, request changes, release, requeue, close, grant). The site's API routes and its pages'
server actions reach it through `apps/web/lib/task-ops.ts`, and the MCP server calls it directly, so a decision is the
same wherever it was asked for. Underneath are the functions the CLI calls (`packages/core/src/board/tasks.ts`). Three
rules are the site's own, because only the site knows a caller is a bot (a token, not a signed-in person): a bot never
approves a task it opened, it never releases a task whose text it wrote any part of, the task itself or a note in its
thread, and it never grants: a capability set or a paid run is a signed-in person's to give, and a token is refused
with 403. A release also needs `tokens:write`. The first two are judged from who the board says wrote a message, and
`bot:oauth:<name>` and `bot:<name>` are the same bot. An approval checks first that the deployment can settle the
task, so a site without the grant refuses before anything merges.

**The brief.** A task the site opens (its API, the MCP tool, GitHub intake) has `brief.md` in its thread
before any worker can claim it: the task is made out of every worker's reach, the brief is posted as `relay-brief`,
then the task is released. A brief that cannot be made never stops the task from opening. A brief on the board is
read by everyone who can read the board, so it holds the preferences and decisions scoped to the project and leaves
the owner's own, wider ones out (`shared` in `packages/core/src/brief/index.ts`). A worker with memory of its own
compiles its brief from that instead, with the owner's preferences in it.

**The task page.** `/tasks/<id>` names an approval for what it does (`reviewKind` in `apps/web/lib/tasks.ts`):
"Approve and merge" for a pull request, "Approve plan" for a proposed plan (the second click opens its tasks, and
the page then lists them), "Mark as read" for a report, "Approve outputs" for a nodes task. Its Grants panel shows
the capability sets of the project's profile, read from the repository's default branch through the site's GitHub
client and kept five minutes (`apps/web/lib/profile.ts`), each with its variables and hosts and a Grant button, and
whether a paid run was approved. What is granted is read from the blocks in the thread, never from a label.

**Paid sandbox runs.** The rules are pure functions in `packages/core/src/cloud/`; the site computes, asks and turns
a plan into calls on `@vercel/sandbox` (`apps/web/lib/cloud/`).

- *The offer* (`cloudOffer`, `apps/web/lib/cloud/view.ts`) is computed at render for a queued task and writes
  nothing: the task is on `claude` or `any`, no worker on a person's own subscriptions that is online or idle serves
  its lane, it has waited `RELAY_CLOUD_AFTER_MINUTES`, the project's profile could be read and does not say
  `cloud: never`, and the deployment has the gateway's key. A card and the task page show "Waiting for a worker"
  with "Run in cloud" (a sheet with an estimate from the project's past runs and a cap to edit) and "Keep waiting".
- *The approval* is the desk's `grantFor`: a `relay-grant@1` block with the cap, a signed-in person only, and the
  label `cloud=approved` as a hint.
- *The pool* (`runApproved` in `apps/web/lib/cloud/pool.ts`) is the only thing that starts a sandbox. It runs after
  an approval and with the throttled feed sync of a page load. It starts one for each queued task that carries a
  grant for its text as it stands, from who may decide, within the deployment's limit, whose profile still
  allows it, and whose repository's default branch requires an approved pull request. A start is marked in the thread as `relay-site` before the sandbox is made, so two instances start one;
  a start that did not come up is tried again, 3 times at most; a start that may have run is never followed by
  another.
- *The sandbox* (`cloudRunPlan`, `apps/web/lib/cloud/launch.ts`) gets no credential it can read. The board (as the
  deployment, under the worker's profile, narrowed to the task's own queue and the workers channel), an installation
  token of the site's GitHub App for the one repository (push and pull requests only) and the gateway's key are set
  on its requests by its firewall; the environment inside holds placeholders. Every other host is blocked except
  the npm registry and the hosts of the capability sets granted to the task, and GitHub is held to that repository's
  git endpoints, `/graphql` and reads. The worker inside is `cloud-<ref>` and does not count as a worker that could
  take the next task.
- *What the lane can use.* The lane runs without the OS sandbox in there, so code it runs can send whatever the
  firewall signs. The firewall cannot keep a GraphQL merge or a push off the default branch, so the site starts a
  run only where GitHub's own rule requires an approved pull request (`apps/web/lib/cloud/guard.ts`). The cap is
  relay's count of its own model calls, not a limit at the gateway: a budget on the gateway's key is. The full list
  is in `docs/SECURITY.md`, "What a paid run's lane can reach".
- *The job* decides once more (`paidRun`): no grant in the thread, or `cloud: never`, and the task is handed back.

Experimental: none of it has been run against a real sandbox or a real gateway yet, and the sandbox installs the
version of `@kyleroche/relay` in `packages/cli/package.json`, which must be published first.

**What the board wakes it for.** Watchers on every project's queue (`work/`), served at `/api/board`
(`apps/web/lib/board-watch.ts`); the board verifies its own wake-ups, so the route needs no session.

- `ledger` brings the feed up to the board (`syncLedger`). It reads the queues' events from a cursor kept in the
  settings table (`board.ledger.cursor`) and writes each row once, by its dedupe key, so a wake-up and a page load
  can overlap. The first sync has no cursor and takes the board's own summary of its last 100 events, which leaves
  out a hold that was since lifted; every sync after reads from the cursor, which is every event. Where nothing
  wakes the deployment (local dev, a board at `BOARD_URL`), the pages that show the feed run the same sync, at most
  once every 15 seconds per instance. The board keeps a task's changes for 30 days; the feed is the durable copy,
  and the usage page is a view over it.

  | On the board | Feed row |
  |---|---|
  | a task is created | `task.created` |
  | a worker's lane profile (`relay-<worker>-<lane>`) claims it | `run.started` |
  | a `relay-run@1` block from an author the site believes | `run.finished`, or `run.failed` when its outcome is `failed` |
  | a `relay-usage@1` block from an author the site believes | `step.usage` |
  | a hold with kind `gate` | `task.held` |
  | a `relay-release@1` block from an author the site believes | `task.released`, by who asked |
  | a note left with a send-back (a `relay=note` reply not written by one of relay's own profiles) | `task.changes_requested` |
  | the task is completed, unless it is a step's own task | `task.approved` |
  | the task is canceled | `task.closed` |
  | a failed task is reopened | `task.requeued` |
  | the database refused one event's rows | `ledger.skipped`, and the rest go on |

  The site believes its own deployment and the worker logins in `RELAY_BOARD_FROM`, under the same rule as a worker:
  the principal itself or its `relay-…` profiles. A task's own turns are the board's facts and count from anyone. A
  row names a person `human:<login>` or a bot `bot:<name>` only when the site itself wrote the message. Numbers are
  clamped to what the columns hold. Rows are not rewritten later: usage from a login that was not yet in
  `RELAY_BOARD_FROM` stays uncounted.
- `relay-brief` posts relay's memory for a new task in its thread as `brief.md`. It covers tasks opened elsewhere
  (the CLI); for a task the site opened it is the same author posting the same message, which changes nothing. A
  step's own task gets none. A worker hands the file to its lane when the site's deployment is in that worker's
  `board.from`, and only a brief from an author it believes is used.
- `lead` exists only where `RELAY_LEAD_URL` names relay's lead. For a task that failed, was held at the gate or
  reached review (`leadWakeOf`; a step's own task and anything an untrusted principal did wake nobody), the site
  posts what happened to the lead's `/relay/wake`, signed with a secret the two deployments share
  (`RELAY_LEAD_WAKE_SECRET`; `apps/web/lib/lead.ts`). No token is sent, and never the deployment's own Vercel
  identity, which is its credential on this board. Without the secret nothing is sent. A wake-up that fails is
  logged and dropped; the task is on the board either way.

**GitHub.** Two deliveries act on the board (`apps/web/lib/webhooks/board.ts`). An issue opened with, or given, an
`agent:<lane>` label by an allowed sender (`RELAY_ALLOWED_SENDERS`) opens a task in the queue of the project
registered for that repository, answering that issue. It is written as the profile `github` (shown as `bot:github`),
which no token's profile can be. One task per issue: the `opened` and `labeled` deliveries of a new issue and a
redelivery find the same task, a label put on again after that task finished opens the next one, and a redelivery
of an older label opens none. A lane nobody serves is refused. A pull request merged on GitHub completes the task
that waits on it (`settleMerged`), in review or still held for an eval, under the same branch check as an approval.
When a delivery cannot do its part (the lane was refused, the board could not be reached), a `board.delivery_failed`
row in the feed says what did not happen.
The site merges with its own GitHub credential, the GitHub App or `GITHUB_TOKEN`.

**Demo mode** (`RELAY_DATA=mock`) is an in-memory board with relay's schemas, seeded through the same functions a
real one is written with, so every page reads real threads. It has nobody to wake it, and `/api/board` answers 404.

## The lead

The lead is optional (`apps/lead`; `apps/lead/README.md`). It is an agent built on Vercel's eve framework, deployed
as its own Vercel project. A person says what they want in plain language; the lead recalls what relay's memory
holds, asks at most one question, and opens tasks a stranger could run. Work that needs breaking down becomes a
planning task, so a worker that has read the repository proposes the pieces and nothing opens until the plan is approved.

| | |
|---|---|
| How it reaches relay | only through the site's MCP server at `<site>/mcp`, with a scoped token, like any other bot. It imports nothing from relay's packages except the wire of its own wake route (`packages/core/src/lead/client.ts`) |
| Its token's scopes | `tasks:read`, `tasks:write`, `memory:read`, `feed:read`, `events:write`. Never `tasks:decide`, `tokens:write` or `memory:write` |
| What it can do | open, read and list tasks, requeue one, send one back with a note, recall memory, read the feed and log its own `external.*` events (`RELAY_TOOLS` in `apps/lead/agent/lib/relay-tools.ts`) |
| What it cannot do | approve, release or close a task, record a decision or a preference, claim a task, grant anything, or edit a repository. Its own tool list has none of it, and none of eve's default tools (no shell, file or web tools). The server holds the same line without the lead's help: approve and close need `tasks:decide`, release `tokens:write`, memory writes `memory:write`, and its token has none of the three |
| What it costs | its model calls go through Vercel AI Gateway and are billed per token to the Vercel team that owns its project. It is the one part of relay that is not a subscription. After each turn it writes one `external.lead.usage` row to the feed |
| What shows on the board | what it does shows under its token's name, and the desk's rules for a bot apply to it |

A site wakes the lead about a task that failed, was held at the gate or reached review, when `RELAY_LEAD_URL` is
set on the site ("What the board wakes it for" above). `packages/core/src/lead/client.ts` is the wire both ends
share: `wakeLead` signs the request (`signLeadWake`: HMAC-SHA256 over `<unix seconds>.<raw body>` with
`RELAY_LEAD_WAKE_SECRET`, sent as `x-relay-wake-timestamp` and `x-relay-wake-signature`) and sends no token, and the
lead's route `POST /relay/wake` checks the signature in constant time, refuses a timestamp more than 5 minutes off
(`verifyLeadWake`), then validates the body with `parseLeadWake` (`apps/lead/README.md`, "Wake-ups"). `leadWakeOf` in `packages/core/src/board/site.ts` says which board events are
such a wake-up. There is one session per relay project, and a redelivered event starts no second turn.

The lead's behavior evals (`apps/lead/evals`) are written and have not been run against a model.

## What relay deliberately does not do

- It does not put a coordinator model between a task and a worker. The board hands a task to a worker, and a person
  approves what a worker produced. Planning is the front end's job, the human's, a planning task's, or the optional
  lead's. A plan opens nothing until it is approved, under the rules of any approval: a person, or a bot that did not
  open the planning task. The lead opens tasks, can requeue one or send one back with a note, and has no tool to
  approve, release or close one.
- It does not host a chat UI. It hosts a feed.
- It does not hold API keys for vendors. Pay-per-token providers are optional overflow lanes the user configures.
