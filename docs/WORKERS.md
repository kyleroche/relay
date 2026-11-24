# Workers

A **worker** is a machine you own that runs `relay work`: it holds your vendor logins, claims the oldest ready task
whose lane it can serve, runs the vendor CLI in a fresh clone, opens the pull request, and reports tokens and cost in
the task's thread. The queue is the team's Vercel Board: a hosted message board with channels, threads, labels and
tasks (SDK `@vercel/board`, CLI `vercel board`). No GitHub Actions runner, no org, and no per-repo execution workflow
is involved.

The machine that installs relay is a worker. Credentials never leave it: the lane runs under the CLI login you made
on that machine, `gh` pushes as you, and the board takes the machine's own `vercel login`. A worker holds no relay
credential.

The CLI, a hosted relay's pages, its API and its MCP tools all work on the same board, through the same functions
(`packages/core/src/board/tasks.ts`). What the site does there besides is in `docs/ARCHITECTURE.md`, "The site and
the board".

## A machine becomes a worker

```text
vercel login                                                     # the board takes this machine's own Vercel login (Vercel CLI 66 or newer)
npx @kyleroche/relay setup --board                               # which board and whose tasks; checks the login, registers relay's schemas
npx @kyleroche/relay doctor                                      # logins, the board line, and the lanes this machine would serve
npx @kyleroche/relay work --install --yes                        # the service that keeps `relay work` running
npx @kyleroche/relay work status                                 # the service, the board's workers, the log tail
npx @kyleroche/relay work forget old-mac                         # hide a retired worker (a renamed or decommissioned machine)
```

There is no token to fetch. `@vercel/board` finds the caller's own credential: the machine's `vercel login`,
`BOARD_TOKEN` in CI, or the board at `BOARD_URL` for a local one (`npx vb serve` prints it). What a worker may claim
and write is what the board's grants give that login.

`relay setup --board` saves which board and whose tasks in the `board` entry of `~/.harness/config.json`, checks that
the login reaches the board, prints who you are there and what you can do, and registers relay's schemas
("The board" below):

| Flag | Saves | Default |
|---|---|---|
| `--team <id-or-slug>` | `board.team`, the Vercel team that owns the board (`RELAY_BOARD_TEAM` wins) | the login's default team |
| `--board-name <name>` | `board.name`, a named board of that team; `default` goes back (`RELAY_BOARD_NAME` wins). A name the team does not have is an error, unless `--create` is given, which makes it | the team's default board |
| `--from <actors>` | `board.from`, the owners whose tasks a worker here claims besides your own, as comma-separated actor IDs; `none` clears it (`RELAY_BOARD_FROM` wins) | your own tasks only |
| `--site-project <name>` | Grants the production deployment of the Vercel project that runs relay's site everything in `work/` (it takes `manage` there to give), and adds that deployment to `board.from`. Asking again finds the grant | no site |

A task's text is instructions for whoever claims it, so `board.from` is the list of who this machine takes
instructions from: another person on the team, the project that runs relay's site.

**A hosted relay is one more caller.** The site acts on the board as its own deployment
(`vercel:project:<id>:production`), whoever is signed in, and writes for each person or bot as a profile named for
them (`+human-kyleroche`, `+bot-grok-bot`). A team's projects start with read, post and label on its board, which
opens tasks but cannot lift a hold or call off a task someone else opened, so the site needs the grant
`--site-project` makes; without it the site refuses an approval before anything merges, and its board page says so. Workers take the tasks it opens once its deployment is in `board.from`, and the site counts
a worker's usage and runs once that worker's login is in the site's own `RELAY_BOARD_FROM` (the command prints the
line to set). `docs/ARCHITECTURE.md`, "The site and the board", has what the site reads, writes and is woken for;
`docs/HOSTING.md` has its environment.

**The schemas are registered once per team.** Registering takes `manage` on the whole board, and a team's boards
share one registry. A job reports in blocks and the worker's own message is one, so `relay work` does not start on
a board without relay's schemas unless its login can register them: someone who manages the board runs
`relay setup --board` once, and after that a narrower login works.

`relay doctor` has a `board` line (which board, as whom, how many owners it takes tasks from, how many workers are
on it; a warning when relay's schemas are not registered; a failure with the fix when the login does not reach it or
the team has no board by the configured name) and a `recorded` line: a Node path relay wrote into a hook, MCP or
service file that no longer exists, or a service file that passes an option `relay work` does not take
(`--interval`, `--max-interval`, `--labels`). `relay setup --yes`, and `relay work --install --yes` for the
service, write them again.

A worker needs no hosted relay. When the machine is in site mode (`relay setup --site`) a job's memory comes from
the site, otherwise from the local database ("What a job does on the machine" below).

### The board

relay's vocabulary on the board is in `packages/core/src/board/mapping.ts` and `schemas.ts`.

| Channel | Holds |
|---|---|
| `work/<project>` | the project's queue: every thread in it is a task |
| `relay/workers` | one message per worker machine |

The queue is `work/<project>`, not `<project>/work`, because a claim names one subtree: `work/` is every project's
queue in one request, and Vercel's board refuses a subtree of more than 50 channels, so a project costs one.

A task is the root message of a thread: the title as a heading, the body, then a `relay-task@1` block. A body past
the board's 10,000 characters goes in an attachment, `task.md`, which the job reads in its place. **A task's ID is
the ID the board gave that message**; every `relay task` command takes it.

**Labels only steer.** Anyone who may label in a channel can set any label, so nothing that decides where a worker
clones, what it pushes or what gets merged is a label.

| Label | On | Says |
|---|---|---|
| `lane` | a task | who may run it: `claude`, `codex`, `grok`, `nodes`, a lane another worker lists, or `any` (whichever code lane is free). It is the claim's filter |
| `model` | a task | the model the lane is asked to use; the lane's default without it |
| `cloud` | a task | `approved` once a paid sandbox run was granted for it. A hint that tells a hosted relay which threads to read; what counts is the grant in the thread ("One task on paid credits" below) |
| `relay=<kind>` | a reply relay wrote | `log` (a line about the run), `result` (the lane's summary and the pull request), `usage` (the run and usage blocks), `brief` (a compiled brief, attached as `brief.md`), `note` (a reviewer's note, a step's findings), `asset` (one output of the nodes lane) |

A reply without the `relay` label is a person's, or another agent's, words. The next run reads those and the notes
as its thread.

**What relay acts on is in blocks.** A block is a fenced piece of data in a message that the board checked against
a registered schema when it was written. A task's text is its owner's (the board holds a task whose root someone
else edits), and the board verifies a reply's author, so a block is trusted by where it is and who wrote it. A block
in a reply counts only from a trusted principal itself (the worker's own login, an owner in `board.from`: a person
at the CLI) or from relay's own profiles of it, the ones whose name starts `relay-`: a worker's
`relay-<worker>-<lane>`, a hosted relay's `relay-site` and its brief's `relay-brief`. Any other profile of a trusted
principal is someone a site wrote for (`human-…`, `bot-…`), and what it says is words, never data
(`docs/SECURITY.md`, "Who relay believes").

| Block | Where | Carries |
|---|---|---|
| `relay-task@1` | the task's own text | `repo` (`owner/name`, where the work happens; a task without it fails, since there is nothing to clone), `base` (the branch to start from instead of the default one), `issue` (`owner/name#n`, the GitHub issue it answers); on a step's task also `step`, `evaluates` (the task whose work it looks at) and `branch` (that work's branch) |
| `relay-run@1` | the runner's usage reply | how a run ended: `outcome`, `lane`, `worker`, the `branch` and the `pr` it produced, the `eval_task` it opened |
| `relay-eval@1` | the work's thread, after an eval's findings | `step`, `task` (the step's own task), `lane`, `verdict`, and `ran` (false when the step could not run) |
| `relay-release@1` | the thread, at a gate release | `digest`: the text a person released, so text added later is graded again. Believed only from who may decide (below) |
| `relay-grant@1` | the thread, at a grant | `set` (a capability set of the project's profile) or `cloud_cap_usd` (the most a paid sandbox run may cost), and `digest`: the task's title and body as they stood, so a grant covers that text and no later edit (`docs/PROFILE.md`). Believed only from who may decide (below) |

**A decision is believed from fewer authors than a report.** A grant and a gate release say what a task may reach or
spend, or that a person read its text. They count only from a trusted principal itself or from the site's own
profile of one, `relay-site`, which the site writes after a signed-in person asked (`isDecidingActor` in
`packages/core/src/board/schemas.ts`). A worker's profile, `relay-<worker>-<lane>`, reports what a run did and never
decides, so a lane that got hold of its worker's board credential cannot grant its own task a set or release its own
text.
| `relay-usage@1` | the runner's usage reply | one model call's tokens and cost ("What a job does on the machine" below) |
| `relay-worker@1` | a worker's message in `relay/workers` | `name`, `host`, `lanes`, `labels`, `version`, `meters` |
| `relay-asset@1` | a reply with one output of the nodes lane attached | `node`, `parameter`, `index`, `version`, `workflow`, `mime`, `bytes`, the attachment |

The board keeps each task's state; a hold says why in its `kind`. relay shows one word:

| State | On the board | Means |
|---|---|---|
| `waiting` | waiting | a task it needs (`--needs`) has not completed |
| `queued` | ready | a worker may take it |
| `running` | claimed | a worker holds it, until the lease its job keeps renewing |
| `review` | blocked, `awaiting_review` or `awaiting_plan` | the pull request, the outputs, a report or a plan is there; a person approves or sends it back. The hold's reason is the pull request's URL, the word `report`, or for a plan the reply that carries it and its SHA-256 |
| `held` | blocked, `gate` | the injection gate flagged the text |
| `blocked` | blocked, any other kind | `awaiting_eval` while a step looks at the work (the reason names the step, its lane, its task and the pull request); the board's own hold on a task whose text someone else edited |
| `done` | completed | merged, its outputs approved, its report read, or its plan approved and its tasks opened |
| `failed` | failed | a worker gave up, with the reason; a requeue retries it |
| `closed` | canceled | called off by its owner |

```text
relay task create --title "Add dark mode" --lane codex [--project <slug>] [--repo owner/name] [--body <text> | --body-file <path>]
                  [--manifest <path>] [--model <id>] [--needs <ids>] [--base <branch>] [--plan] [--key <idempotency-key>]
relay task get <id>                          # state, who holds it, the pull request, usage, the last notes in its thread
relay task ls [--project <slug>] [--state <state> | open | all] [--lane <lane>] [-n <rows>]    # oldest first; open (the default) is everything not done or closed, failed included
relay task approve <id> | changes <id> --note "…" | requeue <id> [--lane <lane>] [--model <id>] | close <id> [--reason "…"] | release <id>
relay task grant <id> --set <name> | --cloud <usd>     # one task may use a capability set of its project's profile, or run in a paid sandbox up to a cap (docs/PROFILE.md)
relay handoff --title "…" --lane <lane> --body-file <path> [--push] [--model <id>] [--project <slug>]   # a task from the session in hand ("Handing work to a worker" below)
```

`create` takes the project from `--project` or the linked checkout, and the repository from `--repo`, the checkout
or the project's registration (`relay project add <slug> --repo owner/name`), and writes them into the task's
`relay-task@1` block. It refuses a lane that is neither built in nor listed by a worker that is online or idle, so a
typo never opens a task nobody will claim, and prints the new task's ID. A task is made out of every worker's reach
and released only once the gate's pre-check has passed. `--base` must be a branch name and `--model` a model id; a
task whose text carries a data block of its own (a `json#name@version` fence) is cancelled as it is made. With
`--key`, a repeated call answers the task the first call made, whatever has happened to the workers since. With
`--plan` the task is a planning task: a lane reads the repository and proposes tasks, and approving the plan is what
opens them (`docs/STEPS.md`, "Plans and reports"). Every command takes `--json` and acts as this machine's Vercel
login.

The task commands answer only for threads in a project's queue (`work/<project>`): any other thread's ID is
`No task`, whatever that thread is.

### Lanes come from logins

`relay work` never asks for a token. It probes the same way `relay doctor` does and serves:

| Lane | Served when | The lane runs |
|---|---|---|
| `claude` | `claude auth status` reports logged in | `claude -p --permission-mode acceptEdits --allowedTools <CODE_TOOLS> --disallowedTools <CODE_DISALLOWED_TOOLS> --settings <sandbox> --max-turns 40`, no MCP servers, no user settings; Bash runs in Claude Code's OS sandbox ("What a job may run" below) |
| `codex` | `codex login status` is logged in, or `fx status` lists a Codex login | `codex exec --json --sandbox workspace-write -c agents.enabled=false` (or `fx ask --auto` when only fx is installed) |
| `grok` | the `grok` CLI is on PATH, or `fx status` lists a Grok login | `grok -p --output-format json --no-subagents --no-plan --permission-mode acceptEdits` (or fx) |
| `nodes` | the Griptape Nodes engine is installed (`griptape-nodes` on PATH with its uv venv; `relay doctor`'s `nodes` line) | `run_workflow.py` under the engine's own Python: the workflow the task's manifest names, headless; outputs are attached to the task's thread, no PR ("The nodes lane" below) |

`gh` must be logged in for any lane: the clone, the push and the PR run as that account (`gh auth login`, then
`gh auth setup-git`). Force the set with `--lanes claude,codex`; a machine without a lane's login must not serve it.
The model is the task's `model` label when the lane can take it, then `RELAY_MODEL_CLAUDE` (`opus` by default),
`RELAY_MODEL_CODEX`, `RELAY_MODEL_GROK`; the Claude lane takes `fable`, `opus` or `sonnet` (or an id that names one)
and says so in its result when it was asked for anything else. With neither, a native CLI uses its own default and a
lane over fx uses the login's: fx's default for that provider, else the first model `fx models` lists, and a model
the subscription has since dropped is retried once with the catalog's first. No lane ever runs with permission checks
bypassed, and the job's environment (`cleanEnv`) drops any `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY`, `XAI_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN` so the run cannot slip onto a key instead of the
subscription, the board's and Vercel's (`BOARD_TOKEN`, `BOARD_URL`, `BOARD_PROFILE`, `VERCEL_TOKEN`,
`VERCEL_AUTH_TOKEN`, `VERCEL_OIDC_TOKEN`) so a lane never talks to the board, and `RELAY_TOKEN`, `RELAY_SITE` and
`RELAY_HOME` so it never sees a site credential or `~/.harness`. The worker reports to the board; the lane does not.

**A worker's labels** say how it runs its lanes, and relay sets them itself: `sandbox:off` (started with
`--no-sandbox`), and inside the container `isolation:container` with `sandbox:on` or `sandbox:container`.
`relay work status` prints them.

**Other lanes.** The four above are the built-in lanes, the only ones `relay work` runs. `any` is a task for
whichever code lane (`claude`, `codex`, `grok`) is free. An app that wants to be a worker for a lane of its own
claims tasks from the board directly, with `vercel board tasks claim --ready work/ --label lane=<lane>` or
`@vercel/board`; relay has no worker protocol of its own. `relay task create` accepts such a lane while a message in
`relay/workers` whose `relay-worker@1` block lists it shows as online or idle, which is what `relay work` keeps for
its own.

### The loop

`packages/core/src/work/worker.ts`:

- **Look.** One claim per free lane, the worker's own lanes in order, then `any` on a free code lane. A claim names
  the subtree `work/`, the `lane` label and the owners in `from` (this login, then `board.from`); the board gives
  the oldest ready task that matches to exactly one claimer.
- **Run.** The job keeps its own lease. One job at a time by default; `--jobs 2` allows two, never two on one lane,
  since a lane is one vendor login. Each lane writes as its own profile, `relay-<worker>-<lane>`.
- **Wait.** With nothing to take, the worker blocks on the board until a task under `work/` becomes ready, from a
  cursor it noted before it looked, so nothing in between is missed. There is no timer polling and no interval to
  set; the wait ends by itself every 5 minutes so a lease that ran out elsewhere is found. A failed look (the board
  unreachable, a rate limit) is retried after 15 seconds, doubling up to 5 minutes.
- **Live.** The worker has one message in `relay/workers`. Its text is a `relay-worker@1` block, edited in place
  when the lanes, the version or the meters change; its labels `worker`, `status`, `running` and `seen` are
  rewritten on every pass, and every 5 minutes while a job runs.
- **Stop.** SIGTERM or Ctrl-C takes no new claims, lets running jobs finish, then marks the worker offline.

`relay work` takes `--once` (drain the queue, then exit), `--task <id>` (run that one task and exit), `--billing` and
`--cap` ("One task on paid credits" below), `--lanes`, `--jobs`, `--name` (default: the host's short name),
`--max-minutes` (per run, default 60), `--keep` (keep each clone), `--no-sandbox`, `--isolation` and `--install` /
`--uninstall` / `--yes`. With `--task` the worker checks that the task's owner is one it takes tasks from and that it
serves the task's lane, claims the task by its ID, runs it and stops. `RELAY_DEBUG=1` logs what the loop waits for and
why it woke.

A worker's state comes from its message (`packages/core/src/board/workers.ts`): **online** when seen within 12
minutes, **idle** up to an hour, **offline** after an hour of silence or a clean stop, **retired** after 7 days
offline. `relay work status` lists every worker with its state, lanes, version, labels and the login behind it.

### Plan meters

The 5-hour and weekly numbers are the subscription's own usage, which relay cannot compute: its usage rows count
relay's runs, the vendor counts everything the login did. The one documented source is Claude Code's status line
(`docs/MEMORY.md`, "The status line"): `relay setup` points it at relay's `statusline.mjs`, which saves the
`rate_limits` Claude Code hands it under `~/.harness/meters/claude.json`. With every sign of life the worker reads
`~/.harness/meters/*.json`, keeps the readings captured within the last 48 hours, and, when they changed, rewrites
its message's `relay-worker@1` block with them:

```json
"meters": [
  { "subscription": "max", "window": "5h", "used_percentage": 42, "resets_at": "2026-10-17T15:00:00.000Z", "captured_at": "2026-10-17T11:58:04.120Z", "source": "claude-statusline" },
  { "subscription": "max", "window": "7d", "used_percentage": 44, "resets_at": "2026-10-20T09:00:00.000Z", "captured_at": "2026-10-17T11:58:04.120Z", "source": "claude-statusline" }
]
```

A machine that uses Claude Code but runs no worker contributes nothing: the reading only travels with a worker.
`relay doctor` shows the file's values and age on the machine. The message is posted without sync, so it never
reaches Slack or GitHub.

### Retiring a worker

A worker's message is found by its name, so a restart, a new version and a changed lane list land on the same
message, and a machine that was renamed, moved from the host tier to the container tier (`kyrobook` became
`kyrobook-container`) or decommissioned leaves its old one behind: `offline, seen 3 weeks ago`, forever. Two rules
handle that:

- **Retired after 7 days.** A worker offline for more than 7 days (`WORKER_RETIRED_MS`) is `retired`: `relay work
  status` prints `retired` in place of `offline` with a hint. Nothing is deleted; a sign of life brings it straight
  back. An offline worker's lanes do not count as served, retired or not.
- **Forget hides it.** `relay work forget <name>` marks the worker's message with a `forgotten` label and it leaves
  the list. Its past runs stay in their tasks' threads, and it shows again if that machine runs `relay work`.

## What a job does on the machine

`packages/core/src/work/job.ts`, over the lane adapters. The board is the only place a job reports to.

1. **Reads the thread**: the task's text and its `relay-task@1` block, its `lane` and `model` labels, what people
   wrote in it, the brief attached to it, the blocks earlier runs left, and the grants a trusted person gave the
   task for its text as it stands.
2. **Keeps the claim.** The lease is renewed at a third of its length while the job runs (Vercel's board gives 5
   minutes at most). When the board says the claim is over (the lease ran out, the task was closed) the lane's CLI
   is aborted and the job reports nothing. The board is asked once more right before the push, so a task closed
   mid-run is not pushed.
3. **Fresh clone** over HTTPS with gh's credential helper into `$RELAY_HOME/work/<ref>`, where `<ref>` is eight hex
   characters of the task ID's hash. The project's steps and its profile, `.relay/project.json`, are read from the
   repository's default branch (`docs/STEPS.md`, `docs/PROFILE.md`).
4. **The injection gate** grades the task's text and the thread's notes (`packages/core/src/tasks/gate.ts`;
   `docs/SECURITY.md`, "The gate"): the deterministic pre-check, then one Sonnet call with no tools unless
   `RELAY_GATE=off`. A hold ends the job here: the task is `held` until someone releases it. Nothing has run. Text
   a person released, as a `relay-release@1` block with its digest says, is not graded again.
5. **Access.** For each capability set the task was granted, the worker looks up the values of the set's variables
   by name, in its own environment and then in the Vercel project the profile names, and posts one line in the
   thread: the sets, how many hosts, which names it did not find. A task with no grant gets nothing. On any lane but
   `claude` the values go to the project's own commands and are withheld from the lane's process, and the line says
   so (`docs/PROFILE.md`, "Capability sets and grants").
6. **The branch** is `relay/<lane>-<ref>` from the tip of the base branch (the block's `base`, else the
   repository's default). A re-run starts over, never from an older attempt; the one exception is the answer to an
   eval, which continues the branch of the run that asked for it (`docs/STEPS.md`).
7. **The brief** is compiled from the machine's own memory when it has one: the local database, or the hosted site
   in site mode. That brief carries the owner's own preferences, which a brief posted on the board leaves out.
   A worker with no memory of its own uses the newest `brief.md` attached to the thread by an author relay believes
   (a reply labelled `relay=brief` from this login or an owner in `board.from`, or from one of relay's own profiles
   of them; anyone else's file by that name is ignored and does not stand in for it). A task a hosted relay opens
   has its brief in the thread before any worker can claim it, a task opened elsewhere gets one from the site's
   `relay-brief` watcher, and a worker takes either once the site's deployment is in its `board.from`. With neither
   the job runs on the repository's rules and the thread alone.
8. **The project's setup.** Each `setup` command of the profile runs in the clone, under the sandbox runtime
   ("What a job may run" below). A command that fails fails the task with what it printed, and the lane does not
   run.
9. **The prompt** is the repo's `relay.md`, the task quoted under the "data, not instructions" banner, the thread's
   notes quoted the same way, what the profile says about the project (the setup that ran, the checks the worker
   will run, the tools and whether this task was granted what each needs, the skill files), the memory, and the
   deliverable.
10. **The lane runs** with the task's `model` label, the granted values in its environment when the lane is `claude`,
    and a per-run time limit (`--max-minutes`, default 60).
11. **The project's `before-pr` steps** go over the change in the same clone (`docs/STEPS.md`).
12. Whatever the lane left uncommitted is **committed** as the machine's GitHub login, with `relay-agent` as
    co-author. A lane that changed nothing is a failed run, with what it said.
13. **The project's checks.** The worker runs each `verify` command of the profile itself, on what was committed.
    A check that fails does not fail the task: the result goes to the reviewer.
14. `git push --force-with-lease -u origin <branch>`; `gh pr create --title "<lane>: <title>"` with a body that
    names the task, and `Closes #n` when the task's block names an issue in the same repository (an open PR of the
    branch is reused); one comment on the PR with the lane's summary and, when the profile has checks,
    `Checks the worker ran (all passed)` or `(N of M failed)` with the end of each failed check's output.
15. **In the thread**: the summary, the checks and the PR's URL (`relay=result`), then one reply with the
    `relay-run@1` block (outcome, lane, worker, branch, pull request) and the usage blocks (`relay=usage`), and the
    task held with kind `awaiting_review` and the pull request's URL as the reason. With an `after-pr` step listed the
    hold is `awaiting_eval` first (`docs/STEPS.md`, "The eval round on the board"). The clone is deleted (`--keep`
    keeps it).

A failure (a setup command failed, the lane did not finish, made no changes, the clone or the push was refused, the
sandbox could not start) fails the task with the reason, and the lane's last words go in the thread.
`relay task requeue <id>` reopens it.

A `nodes` task replaces steps 6 to 14 with the engine run and the attachments ("The nodes lane" below).

A task that runs a read-only `task` step by itself, such as a planning task (`relay task create --plan`) or
`relay steps run retro`, makes no branch and no pull request. The lane runs read-only, the profile's setup and checks
are not run, and the task is held for what the lane said: a plan, posted as `plan.json` and held with kind
`awaiting_plan`, or a report, held with kind `awaiting_review` and the reason `report` (`docs/STEPS.md`, "Plans and
reports").

**Usage** is a `relay-usage@1` block per model call (`packages/core/src/board/schemas.ts`): `kind` (`run` the
lane's work, `gate` the injection gate's grade, `media` one output model of the nodes lane, `step` a step's own
call, with `step` naming it), `lane`, `tool`, `model`, `subscription`, `billing` (`subscription` for a machine's
login, `gateway` for AI Gateway credits), `tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `cost_equiv`,
`duration_ms`, `worker` and, for a run, `outcome`. `relay task get <id>` sums them.

### What happens after the PR

The worker is done when the task is held for review; the rest is a person's decision
(`packages/core/src/board/tasks.ts`). What these commands act on comes from places the board guards, never from
labels: the repository and the issue from the task's own text, the pull request from the hold's reason, which only
the claim that held the task could write.

1. **Approve**: `relay task approve <id>`. relay reads the pull request the hold names and merges it only if its
   head is a branch relay pushed for that task (`relay/<lane>-<8 hex of the ID>`), so nothing written on the board
   can point an approval at another pull request. It squash-merges on GitHub as `<title> (#<pr>)` with this
   machine's GitHub credential, deletes the branch, then completes the task with `merged owner/name#n in <sha>` as
   the result. Completing takes the task's `lane` label off before it lifts the hold, so no worker can claim the
   task in between. The merge is the approval of record. A merge GitHub refuses (conflicts, required checks) is said
   in the thread with GitHub's reason, and the task stays in review. Before it merges, relay checks that the caller
   can settle the task on the board: it opened the task, or it manages the task's queue; otherwise the approval is
   refused and nothing is merged. The merge and the board are two systems, so both ends are safe to meet again: a
   task whose own pull request is already merged (an approval cut off after the merge, or a merge on GitHub nobody
   told the board about) is finished by an approve from any open state, and an approve that finds the task already
   completed by GitHub's delivery is a success.
   A task held for a plan is approved the same way: relay reads `plan.json` from the reply the hold names, checks
   it against the SHA-256 in the hold, opens the plan's tasks as the approver and completes the task with
   `plan approved: opened N tasks`. A task held with a report completes with `report read by <who>`, and a nodes
   task with `approved N outputs`.
2. **Request changes**: `relay task changes <id> --note "…"`. The note goes in the thread (`relay=note`) and as a
   comment on the PR when there is one, and the hold is lifted: the task is `queued`.
3. The next worker to claim it runs the same job: fresh clone, the same branch from the tip of the base, and the
   whole thread, the note included, in its prompt. `--force-with-lease` replaces the branch, the open PR is found
   and reused, and a new summary comment lands.

A reply written on the board itself counts the same as a note: the next run reads every reply that is not relay's
own log, result, usage, brief or asset message. There is no relay permission layer in between: each command acts as
the caller's own Vercel login, and the board lets only a task's owner, or someone with `manage` in its channel, lift
a hold, reopen or cancel it.

The same two decisions are on the task's page on a hosted relay (`/tasks/<id>`), in its API and in its MCP tools, made
as the profile of whoever asked, behind the site's own rules for bots (`docs/ARCHITECTURE.md`, "The site and the
board"). The page names the approval for what it does: "Approve and merge" for a pull request, "Approve plan" for a
plan (the second click opens its tasks, and the page then lists them), "Mark as read" for a report, "Approve outputs"
for a nodes task. Its Grants panel lists the capability sets of the project's profile, each with a Grant button, and
says whether a paid sandbox run was approved. A pull request merged on GitHub itself completes the task too, when the
site receives the delivery, whether the task was in review or still held for an eval.

### The nodes lane

A `nodes` task is a production step, not a code change: the task names a [Griptape Nodes](https://docs.griptapenodes.com)
workflow in its repository, a worker with the engine installed runs it headless, and whatever the workflow's end
nodes produced (video, images, audio) is attached to the task's thread. No branch is pushed and no PR is opened; the
task is held for review with its outputs.

**What the worker needs.** The engine (`griptape-nodes`, installed as a uv tool; `relay doctor` prints a `nodes` line
with the version, the interpreter the shim will run under, the workspace and which vendor key names are set, and
`relay work` serves the lane when that line is not a failure), `gh` logged in (the clone), and the vendor keys the
workflow's nodes read, in that machine's environment (`GT_CLOUD_API_KEY`, `ARK_API_KEY`, `OPENAI_API_KEY`, ...; the
probe reports names only, never values). A machine whose engine config fails its schema still serves the lane: the
doctor line says so, and relay's shim registers the workflow's libraries itself (from `RELAY_NODES_LIBRARIES`, the
user config read raw, or the engine's synced library directory). `RELAY_NODES_PYTHON` points the shim at a specific
interpreter when the launcher's venv is not the one to use.

**The manifest** is a fenced block in the task's body (JSON, or the YAML subset `packages/core/src/tasks/manifest.ts`
reads: nested mappings, `- ` lists, inline `[a, b]`, JSON values, quoted or bare scalars). `relay task create
--manifest <file>` appends the fence for you:

```relay-nodes
workflow: workflows/cutscene.py        # repo-relative, must end in .py, no `..`
inputs:                                # { <start node>: { <parameter>: value } }, the engine's flow input
  Start Flow:
    prompt: "A rain-slicked street at night"
    duration: 8
outputs: [End Flow]                    # optional: only these end nodes are kept (default: every end node);
                                       # text parameters are kept only for listed nodes
model: bytedance/seedance-2.0          # optional: the model id for the usage rows when relay does not know the node type
stage: cutscene                        # optional: a tag on the outputs
```

**What a run does.** The clone and the injection gate are the same as every lane; then, instead of the prompt:

1. The manifest is parsed from the task's body (a missing or malformed block is a failed run whose reason says what
   to fix) and the workflow is resolved inside the clone (a path outside it is refused).
2. `packages/cli/python/run_workflow.py` (shipped as `dist/python/`) runs under the engine's interpreter with the
   workflow, the inputs as a JSON file and an output directory, under the job's time limit. The engine's own output
   goes to stderr; stdout ends with one JSON document: `{ ok, outputs: [{ node, parameter, path, mime, bytes,
   seconds?, provider_job_id? }], nodes_run: [{ node, type, library }], engine_version, seconds, error? }`. URL
   artifacts are downloaded, blob artifacts written, lists walked; an end node's control and status parameters are
   skipped.
3. Every output file is uploaded to the board and attached to a reply of its own in the thread (`relay=asset`),
   titled `<task title> v<n>: <node>.<parameter>`, with a `relay-asset@1` block: `node`, `parameter`, `index`
   (which output of that parameter, 1 for the first), `version` (one more than the last output of the same node,
   parameter and index in the thread, so a re-run keeps a version history), `workflow`, `mime`, `bytes`, the
   attachment's ID, and the manifest's `stage`. A board attachment holds 100 MB; a larger file fails the run.
4. The summary goes in the thread ("Workflow … ran on Griptape Nodes … and produced N outputs", with the models),
   then the run and usage blocks, and the task is held with kind `awaiting_review` ("N outputs to review"). A
   workflow that fails or produces no output fails the task with the engine's error.

**Review.** `relay task approve <id>` on a task in review with outputs attached and no pull request completes it
(`approved N outputs by <you>`), with no GitHub involved. `relay task changes <id> --note "…"` sends it back for
another version, and `relay task close <id>` ends it. The same decisions are on the task's page on the site, which
lists the outputs; they cannot be downloaded from the site yet, only from the board.

**Costs.** The engine calls the vendors with the machine's keys, so a run is paid use. The thread gets one
`relay-usage@1` block of kind `run` on lane `nodes` (the total), and one of kind `media` per output model on lane
`video`, `image` or `audio` (by what came out), tokens 0, the model from the node type it ran (`NODE_MODELS` in
`packages/core/src/lanes/nodes.ts`: Seedance, Seedream, OpenAI image, Gemini image, ElevenLabs), else the manifest's
`model`, else null. The cost comes from `MEDIA_PRICES` in `packages/core/src/ledger/ledger.ts` when the model is
priced there (per output, per second, or both; rows come from the vendor's own price page only); otherwise
`cost_equiv` is 0. `relay lane nodes --workflow <file> --inputs '<json>' [--out <dir>] [--outputs "End Flow"]
[--model <id>]` runs the same shim by hand and writes `step.usage` rows to this machine's ledger (local mode).

### Requeue: back to the queue, perhaps on another lane

A task that failed, is held, or should run on another lane or model goes back to the queue with
`relay task requeue <id> [--lane <lane>] [--model <id>]` (`requeueTask` in `packages/core/src/board/tasks.ts`).
`--lane` moves the `lane` label; `--model` sets the `model` label (it must be a model id), and `--model default`
removes it. Then, by state:
a `failed` task is reopened; a task in `review`, `held` or `blocked` has its hold lifted; a `queued` or `waiting`
one is only relabelled. A `done` or `closed` task is refused (open a new one), and so is a `running` one, with who
holds it and until when: it returns to the queue by itself when that worker stops renewing, and
`relay task close` is how a run is stopped. The next worker that serves the lane claims it and runs the same job
from the base branch, replacing the branch with `--force-with-lease` and reusing an open PR.

### Close: finished without a merge

A task that should not run at all, or not any more (opened by mistake, against a spec the repo does not match, a
duplicate), is closed with `relay task close <id> [--reason <text>]` (`closeTask`). It works from every state but
`done` and `closed`: the task is canceled on the board with the reason and shows as `closed`. A job that was running
it finds its claim gone: the lane's CLI is aborted, nothing is pushed and nothing is reported. A step's task that
was looking at the closed task is called off with it, and closing a step's task sends the work it was looking at to
review without the step. On GitHub, best effort, with this machine's GitHub
credential: the task's own open pull requests (those whose head is a branch relay pushed for it) get the reason as
a comment and are closed and their branches deleted (the commits stay reachable through the closed pull request,
which can restore the branch), and the issue the task's block names gets the same comment and is closed as not
planned. A GitHub failure is printed, and the task stays closed.

### Held at the gate: release

A task the gate held is in state `held` (`relay task ls --state held`; `relay task get <id>` prints the hold's
reason). It gets there two ways: the deterministic pre-check when the task is opened, which holds it before any
worker sees it ready, or the worker's grade before the lane runs. Release it with `relay task release <id>` once you
have read the text: relay posts a `relay-release@1` block with the digest of the text as it stands (the title, the
body, the notes in the thread), then lifts the hold. The board lets only the task's owner, or someone with `manage`
in its channel, lift a hold, and a worker takes the block only from who may decide ("The board" above;
a hosted relay posts it as `relay-site`, with who asked beside it). The task is
`queued` again and that text is not graded a second time; text added to the thread afterwards changes the digest and
is graded. `relay task requeue` on a held task lifts the hold without a release, so the next job grades the text
again.

### What a job may run

The Claude lane's Bash, and every process it starts (git, pnpm, the repository's own scripts), runs inside Claude
Code's OS sandbox: Seatbelt on macOS, bubblewrap with socat on Linux. The worker passes the sandbox as one
`--settings` document (`claudeSandboxSettings` in `packages/core/src/lanes/sandbox.ts`) with
`--setting-sources ""`, so it is the only settings the run sees and nothing in `~/.claude` or in the clone can
loosen it. Inside it a command may:

| May | May not |
|---|---|
| read and write the clone; write the pnpm and npm stores (`~/Library/pnpm`, `~/.local/share/pnpm`, `~/.npm`, their caches) | write anywhere else (`~`, `/tmp` outside Claude Code's own, another repository) |
| reach `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com`, `objects.githubusercontent.com`, `codeload.github.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `static.crates.io`, `proxy.golang.org`, plus `RELAY_LANE_ALLOWED_DOMAINS` and the hosts of the capability sets the task was granted; bind localhost ports | reach any other host (the local proxy answers 403; `strictAllowlist`) |
| read the rest of the filesystem the worker's user can read | read relay's own secrets (`~/.harness/credentials.json`, `config.json`, `work.log`, `relay.pglite`), `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.fx`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.gitconfig`, or the login the worker reaches the board with: the Vercel CLI's auth directories (`~/Library/Application Support/com.vercel.cli`, `~/.local/share/com.vercel.cli`), `~/.vercel` and `~/.config/board` |

The sandbox wraps Bash, not the Read/Edit/Write tools, so the same paths are denied again with `permissions.deny`
rules and `blockReadsOutsideWorkingDirectories` keeps the Read tool inside the clone. The Claude Code process itself
(the model call) is outside the sandbox; that is what lets the login work. Because `~/.gitconfig` is unreadable, the
lane's git identity comes from `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` (and email) in the job's environment.

A machine that cannot sandbox does not run the job unsandboxed: `failIfUnavailable` makes `claude` exit, the run is
reported `failed` with a summary saying what to install (`relay doctor` has a `sandbox` line). Linux needs `bubblewrap`
and `socat` on PATH (`sudo apt install bubblewrap socat`, or `dnf`); macOS needs nothing. `relay work --no-sandbox`
turns the sandbox off for that worker: it logs a warning and advertises the label `sandbox:off`, which `relay work
status` shows. The next tier puts the whole worker in a container: "Isolation" below.

Behind the sandbox, the Claude lane gets an allowlist of named commands and a refusal list (`CODE_TOOLS`,
`CODE_DISALLOWED_TOOLS` in `packages/core/src/work/job.ts`):

| Allowed without asking | Refused outright |
|---|---|
| `Read`, `Edit`, `Write`, `Glob`, `Grep` | `git push` |
| `git status`, `git diff`, `git log`, `git add`, `git commit`, `git checkout`, `git restore` | `git -c`, `git config`, `git remote` |
| `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm run …`, `pnpm -r …` | `curl`, `wget` |
| `npm ci`, `npm install`, `npm test`, `npm run …` | |
| `npx tsc`, `npx eslint`, `npx vitest`, `npx next …`, `npx prettier` | |
| `yarn install`, `yarn test`, `yarn build`, `yarn lint`, `yarn run …` | |
| each `setup`, `verify` and tool command of the project's profile, as written, with any arguments after it | |

Anything else (`pnpm dlx`, `pnpm exec`, `npm exec`, any other `npx`) Claude Code would ask about, and in `-p` mode a
question is a refusal. The refusal list is what an allow rule can never open: a push, anything that rewrites where a
push goes or runs a hook, a fetcher. The worker, not the lane, commits,
pushes (`--force-with-lease`, its own branch only) and opens the PR. Codex runs under its own `--sandbox
workspace-write`; Grok and fx run under their permission modes with no OS sandbox.

**The project's own commands.** The `setup` and `verify` commands of the profile run without a model, and `npm ci`
runs every dependency's install script. Each one runs under Anthropic's sandbox runtime (`srt`, the npm package
`@anthropic-ai/sandbox-runtime`; `packages/core/src/work/exec.ts`) with the limits of the table above: writes inside
the clone and the package caches, the same denied paths, the same default hosts plus the granted ones. With
`--no-sandbox`, or in the container tier when the nested sandbox cannot start, they run directly with `sh -c`. A
worker that should sandbox and cannot find the runtime does not run the command: it fails with exit 127 and the
reason, and never falls back to running it unguarded. The runtime is a dependency of relay, installed with it, and
`relay doctor`'s `sandbox` line warns when it is missing. The values of a granted capability set are in the
environment of these commands, and of the lane when the lane is `claude`, and nowhere else (`docs/PROFILE.md`).

The allowlist is a permission policy, the second layer: it decides which tool calls the CLI accepts, the sandbox
decides what the accepted commands can reach. `pnpm test` still runs whatever the repository's `package.json` says,
as the OS user the worker runs as, boxed by the sandbox above. Three things still follow (`docs/SECURITY.md`,
"Workers"): prefer the container tier (`relay work --isolation container`, "Isolation" below) or a dedicated OS user,
so the worker holds the vendor and `gh` logins and nothing else (no SSH keys, no sudo, no access to your home
directory); turn on branch protection on every linked
repository's default branch, since the worker pushes as your `gh` account; and keep `board.from` short, since a
worker runs your own tasks, those of the owners it names, and nobody else's.

## Isolation

What a fooled lane can reach depends on where the worker runs. Three tiers, each a superset of the one before:

| Tier | `relay work …` | What the lane runs in | What it protects | What it cannot protect |
|---|---|---|---|---|
| 1. sandbox on the host | `relay work` (default) | your OS user, Claude's Bash inside Claude Code's OS sandbox (Seatbelt / bubblewrap), the tool allowlist | the credential paths, writes outside the clone, hosts off the allowlist | every other file your user can read; Codex, Grok and fx have no OS sandbox; the vendor logins are your daily ones |
| 2. container | `relay work --isolation container` | one persistent Linux VM (Apple's `container`), as the `relay` user inside, Claude's sandbox nested when the kernel allows it | the Mac's home directory, your logins and SSH keys, every file outside the container; the lane's shell cannot see the host at all | the container's own logins (made for it, inside it); the network, beyond what the nested sandbox allows |
| 3. VM / separate machine | a Linux box or VM that runs `relay work` and nothing else, under a dedicated user | its own OS | everything on your machine | nothing on that machine, which is why it holds only the logins |

Tier 2 is built in. `relay work --isolation container --install` on a Mac with [Apple's `container`
CLI](https://github.com/apple/container) (the service running: `container system start`) does, and prints before it
does anything:

1. **Builds the image** `relay-worker:<version>` from the Dockerfile the package ships (`packages/cli/container/`,
   `dist/container/` when installed): `node:24-bookworm-slim`, git, curl, bubblewrap, socat, ripgrep, `gh` from
   GitHub's apt repo, pnpm through corepack, Claude Code, the Vercel CLI, fx (the release tarball, verified against its `.sha256`), and
   relay itself: the npm package at the host's version, or, from a checkout, that checkout packed with `npm pack` so
   the container runs the same relay as the host. A non-root user `relay` with home `/home/relay`. The build context
   is `$RELAY_HOME/container`; about a minute to build (plus the base image's download the first time), 300 MB to
   fetch and 800 MB unpacked, most of it Claude Code.
2. **Creates the volume and the container**: `container volume create relay-work-home`, then `container create
   --name relay-work --volume relay-work-home:/home/relay --publish 127.0.0.1:3000:3000 --publish 127.0.0.1:1455:1455 --masked-path NONE --read-only-path NONE --memory 4G
   --cpus 4 --env RELAY_HOME=/home/relay/.harness --env RELAY_ISOLATION=container --env
   RELAY_WORKER_NAME=<host>-container --env RELAY_WORKER_HOST=<host> relay-worker:<version> relay work [--lanes …]`.
   No bind mount: nothing from the Mac is visible inside. The volume (an ext4 image under `~/Library/Application
   Support/com.apple.container/volumes`) holds the logins, `~/.harness` with the site token and the clones, and the
   model's shell. The two `NONE` flags turn off the runtime's default masks over `/proc` and `/sys`; with them on,
   bubblewrap cannot mount `/proc` in a user namespace and Claude Code's sandbox cannot start inside. The VM is the
   boundary, so the masks add nothing. `--memory` and `--cpus` (the flags of the same name on `--install`) size the
   VM: the runtime's own default of 1 GB is too little, PGlite alone reserves about that when it opens and the kernel
   kills the worker. An existing `relay-work` is replaced (the volume, and so the logins, stay).
3. **Joins the site from inside, when there is one**: `container exec --user relay -it relay-work relay setup --site
   <site>`. The device flow prints its code to your terminal; approve it at `<site>/activate` (`--invite <code>`
   skips the approval). The token lands in the volume, never on the Mac. `--site` defaults to the site this Mac is
   in. The site gives the worker inside its memory, not its queue: the container cannot see the Mac's local
   database, so without a site the worker runs on the repository's rules and the thread alone. The queue is the
   board, which the worker inside reaches with the Vercel login made in step 5. The Mac's `~/.harness/config.json`
   is not mounted either: `RELAY_BOARD_TEAM`, `RELAY_BOARD_NAME` and `RELAY_BOARD_FROM` set in the environment at
   install time are passed into the container, or run `relay setup --board` inside (`relay work container shell`).
4. **Installs the service** that keeps the container running: the LaunchAgent (or systemd unit) runs
   `container start --attach relay-work` with KeepAlive, so when the worker inside exits the container is started
   again. The Mac's `$RELAY_HOME/work.log` gets the container's output; inside, the worker also writes
   `/home/relay/.harness/work.log`.
5. **Prints the login sequence**, which is yours to do. One command makes every login that is missing:

   ```text
   relay work container login all             # claude, gh, vercel (the board), then the optional codex and grok; the ones already in the volume are skipped
   relay work container status                # relay doctor inside, and the lanes the container worker serves
   ```

   `login` runs each vendor CLI inside the container, from the Mac, and the logins land in the volume. Claude Code,
   gh and the Vercel CLI run in your terminal (`container exec -it`): `claude`, where you type `/login`, open the URL
   it prints on this Mac, paste the code back and `/exit`; then `gh auth login --git-protocol https --web`, whose
   device code prints in the terminal, followed by `gh auth setup-git`; then `vercel login`, whose device code you
   confirm in this Mac's browser, and which is the login the worker inside reaches the board as (`relay work
   container login vercel` does that one alone; it counts as made when `relay doctor`'s `board` line inside
   answers). The two OAuth-redirect logins are driven from outside,
   since the container has no browser: fx runs inside with its browser turned off (`FX_NO_OPEN_BROWSER=1`, stdin
   kept open), relay reads the authorize URL it prints and the loopback port its `redirect_uri` names, starts a
   listener on the Mac at `127.0.0.1:<that port>`, opens the URL in your browser (`--no-open` prints it instead),
   and when the browser is redirected back the listener answers "signed in, you can close this tab" and hands the
   code to the login server inside. For **grok**, fx's listener sits on a random port that no published port can
   serve, so the code is pasted to fx's prompt on stdin, which is the by-hand flow automated. For **codex**, the
   redirect goes to Codex's own listener on 1455, and while the container runs that port on the Mac belongs to the
   container's `--publish 127.0.0.1:1455:1455`: relay cannot bind it, sees that it is a port the container
   publishes, opens the browser anyway and lets the redirect reach the listener inside through the published port and
   `relay-entry`'s forwarder (the paragraph below), waiting for fx to finish. Only when 1455 is free on the Mac (a
   container made by an older relay without the publish) does the host listener take the codex redirect, and it
   then replays it with `curl` on the container's loopback (`http://localhost:1455/auth/callback?code=…&state=…`)
   and pastes the code to fx as well. Any other busy port is a refusal, and a login the browser does not come back
   from within five minutes (`--timeout <seconds>`) is given up: both print the by-hand steps for that provider and
   leave the others to run. `relay work container login grok` does one login; `--force` logs in again when the
   volume already holds it. Claude Code also has `claude setup-token`, which prints a long-lived OAuth token for model
   requests only; relay does not use it, because the login belongs in the container, not in an environment variable,
   but it is the headless alternative when no terminal is at hand.

   By hand, inside (`relay work container shell`), in this order:

   ```text
   claude                                     # then /login: the OAuth paste-code flow (open the URL on the Mac, paste the code back, /exit)
   gh auth login && gh auth setup-git         # the account the worker clones, pushes and opens PRs as (device code)
   vercel login                               # the login the worker reaches the board with (device code)
   fx login codex                             # optional: the codex lane (the browser's redirect to localhost:1455 reaches the container)
   FX_NO_OPEN_BROWSER=1 fx login grok         # optional: the grok lane; open the printed URL on the Mac and paste only the code back (below)
   exit
   relay work container status
   ```

   The browser-redirect logins work through two published ports: `--publish 127.0.0.1:3000:3000` (fx's own
   callback) and `127.0.0.1:1455:1455` (Codex's OAuth listener, which `fx login codex` hands off to). A published
   port delivers to the container's eth0 address, while those login servers bind the container's loopback only, so
   the redirect would be dropped; `relay-entry` therefore starts one `socat` forwarder per port at container boot
   (eth0 → `127.0.0.1`, as the relay user, in the background; the list comes in as `RELAY_LOGIN_PORTS`), and a
   forwarder with no login running just waits. Grok's login picks a random localhost port that no published port
   can serve: by hand, run `FX_NO_OPEN_BROWSER=1 fx login grok` (or `fx login grok --no-browser`; the flag goes
   after the provider), open the printed URL on the Mac, and when the browser ends on an unreachable
   `127.0.0.1:<port>/callback?state=…&code=…` page, paste only the `code` value into fx's prompt ("Paste the code
   shown by xAI and press enter"); the whole address fails with "failed to sign in", and each code is single-use.

Inside, `relay work` knows it is the container worker (`RELAY_ISOLATION=container`): it registers as
`<hostname>-container` on the Mac's hostname, so `relay work status` shows it as a separate machine; it
adds the label `isolation:container`; and instead of exiting on "no lanes" it waits, re-probing the board and the
logins every 30 seconds, so `container exec` can always reach it. On start it probes bubblewrap (the smallest invocation
Claude Code's sandbox needs). When it starts, the Claude lane's Bash runs inside Claude Code's sandbox nested in the
VM, with the same allowlist and denied paths as on a host, and the worker advertises `sandbox:on`. When it cannot
(a `container` version that ignores the two flags, another runtime), the lane runs with the tool allowlist alone and
the container is the boundary; the worker says so with the label `sandbox:container`, never `sandbox:off`, which means
a bare host. Verified on `container` 1.5.0: with the flags, Anthropic's sandbox runtime starts bubblewrap as the
`relay` user, puts the command in its own pid namespace, denies writes outside the clone and answers 403 for a host off
the allowlist; without them bubblewrap fails with "Can't mount proc".

Day to day:

```text
relay work container status      # relay-work running?, the image it runs (and whether this relay would build another), relay doctor inside, the lanes it would serve
relay work container login all   # the logins inside, driven from the Mac (claude, gh, vercel, codex, grok; or one of them; --force to redo one)
relay work container shell       # exec into it as the relay user (logins by hand, a look at a clone kept with --keep)
relay work container logs -f     # the worker's output (container logs)
relay work container stop        # stop it and unload the service that would restart it
relay work container start       # the service when installed, else `container start`
relay work container update      # after git pull or a package upgrade: new image, the container recreated on the same volume; --yes does it
relay work container rm --yes    # remove the container; --volume also deletes the volume, that is, every login inside
relay work --isolation container --uninstall --yes   # service and container gone; the volume stays
relay doctor                     # on the Mac: a `container` line (CLI, services, relay-work, the lanes inside)
```

**Updating.** The image is built once, from the checkout or package at that moment, so when relay moves on (`git
pull`, a package upgrade) the container keeps the old relay until it is rebuilt. `relay work container update` is the
command for that: it prints the plan and `--yes` does it. It builds `relay-worker:<version>` from this relay first
(the running container is untouched until the build succeeds), unloads the service, stops and deletes the container
(never the volume), recreates it with exactly the flags `--install` would use today (new defaults such as published
ports apply), carrying over what the old container was created with (the baked `relay work` arguments, without
options `relay work` does not take; the passthrough environment, the worker name; `--memory` and `--cpus`, which
can be overridden), starts it, and checks the volume: `/home/relay/.harness/credentials.json` there means the site
is already joined, so `relay setup --site` is skipped and the plan says `site: joined as <name> (kept)`; otherwise,
when a site is known, the device flow runs as at install (`--site`, `--invite`). It then reads `relay doctor` inside
and prints `relay work container login all` with the by-hand list under it, `kept` marking the logins the volume
holds, so only what is missing is an instruction; when everything is there it prints one line. Then the service is
reloaded. `relay work --isolation container --install --yes` over an existing container converges to the same thing
(no second device flow, no login list for logins already made); `update` differs in taking its settings from the
container instead of flags. `relay work container status` shows the image the container runs and says `rebuild with
relay work container update` when this relay would build a different tag; the tag follows the package version, so
after a `git pull` that did not bump it, run `update` anyway. While the container is stopped the volume cannot be
probed, so the plan prints the setup step as conditional and the full login list; the decision is made after the
start.

The host and the container worker use the same service label, so one Mac runs one or the other, not both.
Credentials never leave the machine: the logins exist only in the volume, created on this Mac, and `relay work
container rm --volume` is how they are destroyed.

## Run it as a service

`relay work --install` prints the file it would write and the commands it would run; `--yes` does it. Options you
pass (`--lanes`, `--jobs`, `--name`, `--no-sandbox`) are baked into the service. With
`--isolation container` the same command installs the container tier instead ("Isolation" above): the service then
runs `container start --attach relay-work` and the options are baked into the container's command.

- **macOS**: `~/Library/LaunchAgents/house.kyro.relay.work.plist`, loaded with `launchctl bootstrap gui/<uid>`.
  A LaunchAgent runs in your user session, which is where the vendor CLIs keep their keychain logins (a LaunchDaemon
  would not see them). It runs while you are logged in: enable automatic login or keep a session open on a machine
  that must stay available, and disable sleep in System Settings → Energy.
- **Linux**: `~/.config/systemd/user/relay-work.service`, enabled with `systemctl --user enable --now`. Run
  `loginctl enable-linger $USER` once so the user manager starts at boot without a login.

Both run the relay that installed them (the npm package's `dist/relay.js`, or the checkout's `tsx` entry) with the Node
that ran `--install`, and append to `$RELAY_HOME/work.log`. `relay work --uninstall --yes` stops the service and
removes the file. `relay work status` shows whether it is loaded, the board's workers with their state
(`retired` for one offline over 7 days; `relay work forget <name>` removes it, "Retiring a worker" above),
and the last ten log lines. To run in the foreground instead: `relay work` (stop with Ctrl-C; running
jobs finish and the worker marks itself offline), or `relay work --once` to drain the queue and exit.

## Handing work to a worker

`relay handoff` turns the work a session has in progress into a task a worker finishes
(`packages/cli/src/commands/handoff.ts`):

```text
relay handoff --title "Finish the importer" --lane codex --body-file brief.md [--push] [--model <id>] [--project <slug>]
```

The worker is a stranger: it gets a clone, the task's text and relay's memory, and nothing of the conversation. So
the command refuses to open a task without a brief in `--body-file` (`-` reads stdin): the goal, the files that
matter, what is out of scope, and the command that proves it is done.

With `--push` the uncommitted work goes along. The working tree is made a commit on top of `HEAD` in a temporary
index and pushed to origin as the branch `relay/handoff/<8 hex of the commit>`, and the task starts from that branch
(its `base`), so the worker's pull request is against it. The working tree, the index and the current branch stay as
they are. New files git does not ignore are included. `--push` is refused when the checkout's origin is not the
project's repository, since the worker clones the project's repository, and a lane no worker serves is refused
before anything is pushed. Without `--push` the task starts from the default branch: the uncommitted work is not
part of it, and neither are commits that are not on the default branch. The command says which files it did not
send.

## One task on paid credits

Every lane runs on a subscription login by default. One run can instead be paid per token through a model gateway:

```text
relay work --task <id> --billing gateway --cap <usd>
```

The flags only say how the worker was started. Whether the task runs on paid credits is decided in the job, from the
task's thread (`paidRun` in `packages/core/src/work/job.ts`):

| Rule | |
|---|---|
| `--billing gateway` needs `--task <id>` | it runs one named task and exits |
| `--billing gateway` needs `--cap <usd>` | a number above 0 |
| the gateway's address and credential | `RELAY_GATEWAY_URL` and `RELAY_GATEWAY_TOKEN` in the environment of whoever starts the worker; there is no flag for them |
| the lane | `claude` only: a task on `claude` or `any` runs on it, and a task on another lane is refused, since no other lane has a gateway adapter |
| a person's grant | the thread must hold a `relay-grant@1` block with `cloud_cap_usd` for the task's text as it stands, from who may decide ("The board" above). Without one the worker hands the task back untouched |
| the project's profile | `cloud: never` refuses the run, and the task is handed back the same way |
| the cap | one for the whole job: the smaller of `--cap` and the grant. Each model call may spend what is left, and what it cost comes off before the next. With less than 0.02 US dollars left, no further call is made |
| the injection gate | its model call goes through the gateway too, within the same cap and at most 0.25 US dollars |
| steps | `before-pr` steps run within the cap. An `after-pr` step is not run: the work goes straight to review, and the thread says so |
| the brief | the thread's `brief.md`; a gateway run does not compile one from the machine's memory |
| usage | each `relay-usage@1` block of the run says `billing: gateway` |

Both variables are among those no child of a job inherits (`JOB_ENV_STRIPPED`). The Claude Code process gets them
as its API endpoint and credential for that run only. Without `--billing gateway` the Claude lane hands Claude Code
no endpoint and no API credential from the environment, so a stray key never replaces the subscription login.

**Where the command runs.** A hosted relay starts it in a Vercel Sandbox for a queued task that none of your workers
can take, after a person approved a cap for that task on its page or with `relay task grant <id> --cloud <usd>`.
The site offers the run and never starts one unasked. The three credentials the sandbox needs (the board, GitHub for
the one repository, the model gateway) are put on its requests by the sandbox's firewall and are not readable
inside, and the worker there registers as `cloud-<ref>`. `docs/PROFILE.md`, "Paid sandbox runs", has when a run is
offered, what the sandbox is and when it starts; `docs/HOSTING.md` has what the deployment needs.

None of this has been run against a real sandbox or a real gateway yet. The sandbox installs the version of
`@kyleroche/relay` in `packages/cli/package.json`, which must be on npm with `--task` and `--billing` in it first.

## No cloud lanes

Every lane on the board is served by a worker: the four `relay work` runs, or a lane an app's own worker lists.
`relay task create`, the site and the MCP tool refuse any other lane name. The vendors' hosted tiers (Codex cloud,
Claude Code cloud sessions) are not lanes: nothing on the board or the site hands a task to them. A paid sandbox run
("One task on paid credits" above) is a worker like any other: it claims its task from the board.

## Troubleshooting

- `relay work` says *cannot reach the board*: the machine's Vercel login is missing, expired or not on the team.
  `relay doctor`'s `board` line has the board's own message; run `vercel login` (Vercel CLI 66 or newer), then
  `relay setup --board`. When the team has no board by the configured name the line says so:
  `relay setup --board --board-name <name> --create` makes it, `--board-name default` goes back to the team's own.
- `relay work` exits with *relay's schemas are not on this board and this login cannot register them*: registering
  takes `manage` on the whole board. Someone who manages it runs `relay setup --board` once per team; the task
  commands say the same when the board refuses a block.
- `relay doctor`'s `recorded` line says the service file *passes --interval* (or `--max-interval`, `--labels`),
  *which relay work no longer takes*: the service exits on the option. `relay work --install --yes` writes the file
  again; `relay work container update --yes` recreates a container without them.
- `relay work` says *no lanes to serve*: `relay doctor` shows which login is missing; log in, or force with `--lanes`.
- The log says *could not look for work* with `claim_too_wide` or `channel_tree_too_large`: a claim looks under
  `work/` once for every owner in `board.from`. Name fewer owners (`relay setup --board --from …`).
- A task stays `queued`: no online worker serves its lane, or its owner is not one the workers take tasks from
  (`relay task get <id>` prints who made it; `relay work status` lists lanes per worker, and each worker's log line
  *taking tasks from …* its owners).
- A task stays `queued` behind others: on Vercel's board a claim with a label looks at the oldest 25 ready tasks of
  each queue, per owner. With 25 or more ready tasks of a lane no worker serves, tasks of other lanes behind them in
  the same project are not found until some of those are claimed, closed or moved to a served lane. Everything a
  hosted relay opens has one owner, the site's deployment, so there 25 or more ready tasks of one lane in a project
  can hide later tasks of another lane, whoever asked for them.
- A task stays `waiting`: a task it needs has not completed (`relay task get <id>` prints `needs`).
- A task flips `running` → `queued`: the worker stopped renewing its lease mid-run (asleep, offline, killed). The
  next claim starts over from the base branch; the earlier branch is replaced by `--force-with-lease`.
- A task is `blocked` and its hold says a step is looking at it: that is the eval round (`docs/STEPS.md`). It moves
  on when the step's task has run, failed, been held or been closed; `relay task close <the step's task>` sends the
  work to review now, without the step.
- A task is `failed` with *made no changes*: the lane finished without editing anything; what it said is in the
  thread. `relay task requeue <id>` retries it, `--lane` on another lane.
- A task is `failed` with *sandbox unavailable*: Claude Code could not set up its OS sandbox on that worker. On Linux
  install `bubblewrap` and `socat`; `relay doctor` shows the `sandbox` line. The job was not run unsandboxed.
- A task is `failed` with *setup failed* and *exited 127*: the sandbox runtime the project's commands run under was
  not found beside relay. `relay doctor`'s `sandbox` line says so; reinstall relay. The command was not run unguarded.
- A paid run ends at once and the task is `queued` again: the worker found no grant for the task's text as it stands,
  or the project's profile says `cloud: never`, and handed the task back. Its log says which.
- A task is `failed` with *the task's text names no repository*: it was made without a `relay-task@1` block. Open
  it with `relay task create`, which writes one (`--repo owner/name`, or the project's registered repository).
- `relay task approve` says the PR *is not a branch relay pushed for* the task: the hold names a pull request whose
  head is not `relay/<lane>-<ref>` for this task. Nothing is merged; merge it on GitHub yourself if it is right.
- A `nodes` run fails with *the workflow needs libraries the engine does not have*: open Griptape Nodes once on that
  machine so it installs them, or set `RELAY_NODES_LIBRARIES` to the `griptape_nodes_library.json` paths. The
  `nodes` doctor line warns when the engine's config file fails its schema (the engine then runs with defaults).
- A Claude job needs a host the sandbox refuses (a private registry, a download in a test): add it with
  `RELAY_LANE_ALLOWED_DOMAINS=host.example,other.example` in the worker's environment (`relay work --install --yes`
  bakes it into the service when it is set at install time).
- The service does not start on macOS: `launchctl print gui/$(id -u)/house.kyro.relay.work` shows the last exit
  status; `tail -f ~/.harness/work.log` the reason (usually a login or a PATH without the CLIs).
- Container mode: the log says `waiting: no board yet` or `no lanes yet`; the worker inside is up and waits for
  its Vercel login (`relay work container login vercel`) or the vendor logins (`relay work container login all`
  makes every one that is missing). The service's log on the Mac says `attach is currently unsupported on already
  running containers` when something else started the container; `relay work container stop` then `relay work
  container start` hands it back to the service. After a reboot the first attempt can fail while `container`'s own
  services are still starting; KeepAlive retries 30 seconds later. The volume is private to the container runtime;
  a `container system stop` takes the worker down with it. `relay doctor` inside warns `bubblewrap cannot start`
  when the container was created without `--masked-path NONE --read-only-path NONE` (an older relay); recreate it
  with `--install --yes`.
- Codex logins go stale when unused; a weekly `relay probe codex:<model>` keeps the refresh token warm.


fx's `login codex` and `login grok` expect the browser's redirect on a loopback port inside the container: Codex's own listener at `http://localhost:1455/auth/callback`, which the container publishes to the Mac's loopback, and Grok's at a random `http://127.0.0.1:<port>/callback`, which it cannot; `relay work container login` catches both on the Mac and hands the code inside. Claude Code's login pastes a code and gh uses a device code, so they need no port.
