# Workers

relay is its own scheduler. A **worker** is a machine you own that runs `relay work`: it holds your vendor logins,
registers with the relay site, watches the queue's doorbell on a tick that stretches to 5 minutes while nothing is
queued, claims the oldest queued task whose lane it can serve, runs the vendor CLI in a fresh clone, opens the pull
request, and reports tokens and cost. No GitHub Actions runner, no org, and no per-repo
execution workflow is involved; GitHub stays the task bus (issues, labels, PRs) and relay does the dispatch.

The machine that installs relay is a worker. Credentials never leave it: the lane runs under the CLI login you made
on that machine, `gh` pushes as you, and the site only ever sees a relay bearer token.

## A machine becomes a worker

```text
npx @kyleroche/relay setup --site https://relay.example.com      # site mode: device flow, or --invite <code>
npx @kyleroche/relay doctor                                      # logins, and the lanes this machine would serve
npx @kyleroche/relay work --install --yes                        # the service that keeps `relay work` running
npx @kyleroche/relay work status                                 # the service, the site's workers, the log tail
```

`relay setup --site` stores the site URL in `~/.harness/config.json` and the token in `~/.harness/credentials.json`
(mode 0600). The token a worker needs carries `work:claim` (register, heartbeat, claim, report) and `memory:read`
(the brief). Without a site, `relay work` schedules against the machine's own database (`DATABASE_URL`, else the
embedded PGlite file), which is how the tests run and how a single laptop can serve itself.

### Lanes come from logins

`relay work` never asks for a token. It probes the same way `relay doctor` does and serves:

| Lane | Served when | The lane runs |
|---|---|---|
| `claude` | `claude auth status` reports logged in | `claude -p --permission-mode acceptEdits --allowedTools <CODE_TOOLS> --disallowedTools <CODE_DISALLOWED_TOOLS> --max-turns 40`, no MCP servers, no user settings ("What a job may run" below) |
| `codex` | `codex login status` is logged in, or `fx status` lists a Codex login | `codex exec --json --sandbox workspace-write -c agents.enabled=false` (or `fx ask --auto` when only fx is installed) |
| `grok` | the `grok` CLI is on PATH, or `fx status` lists a Grok login | `grok -p --output-format json --no-subagents --no-plan --permission-mode acceptEdits` (or fx) |

`gh` must be logged in for any lane: the clone, the push and the PR run as that account (`gh auth login`, then
`gh auth setup-git`). Force the set with `--lanes claude,codex`; a machine without a lane's login must not serve it.
Models come from `RELAY_MODEL_CLAUDE` (`opus` by default), `RELAY_MODEL_CODEX`, `RELAY_MODEL_GROK`. No lane ever runs
with permission checks bypassed, and the job's environment (`cleanEnv`) drops any `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `XAI_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN` so the run cannot slip onto a key instead of the
subscription, and the worker's own `RELAY_TOKEN`, `RELAY_SITE` and `RELAY_HOME` so the lane never sees the site
credential or `~/.harness`.

**Labels** are extra capabilities a worker advertises (`--labels gpu,xcode`). A project can require them with a
preference: `relay prefer lane.labels gpu --scope project --scope-id <slug>` (or `--scope lane --scope-id claude`,
narrowest wins). A task whose required labels the worker lacks is left for another worker.

## The protocol

Every step is a REST call under `/api/v1` with the bearer token; the same functions back the local mode.

| Step | Route | Writes |
|---|---|---|
| register | `POST /workers` `{name, host, lanes, labels, version}` | upsert by name (the id is stable); `worker.registered` on first sight, `worker.online` when a worker returns after an offline report |
| heartbeat | `POST /workers/{id}/heartbeat` `{status?, interval_ms?}` every 60 s while a lease is held, at most every 5 min while idle | `last_seen` and `poll_ms`; every live lease the worker holds is extended to 30 minutes from now; `status: offline` writes `worker.offline` |
| doorbell | `GET /work/doorbell?lanes=claude,codex` (`work:claim` or `feed:read`) on every idle tick | nothing. Returns `{version, queued, ts}`: the queue version and how many tasks look queued for those lanes ("The loop" below) |
| claim | `POST /work/claim` `{worker_id, lanes?, labels?}` when the doorbell says so | the oldest `queued` task whose lane and labels match, leased for 30 minutes; `claim: null` when nothing is claimable |
| start | `POST /work/{owner}/{repo}%23{issue}/start` `{worker_id, branch}` | `run.started` as `runner:<name>`; the task is `running` |
| release | `POST /work/{owner}/{repo}%23{issue}/release` `{worker_id, outcome, pr, pr_url, summary, error, usage}` | `finished` → `run.finished` (+ PR); `failed` → `run.failed`; `released` frees the lease only. `usage` → one `step.usage` row as `agent:<lane>` |
| list | `GET /workers` (`feed:read`) | every worker with `state` (online < 2 min, idle < 1 h, offline) and its current claim |

### The loop

A worker polls; nothing on the site can reach a machine behind NAT. The cost of polling is what the loop is built
around: the site runs on Vercel over Neon, and a worker that ran a claim every 15 seconds and a heartbeat every
minute made about 7,200 requests a day, each one a database transaction, so the database never reached its
auto-suspend timeout and an empty queue cost compute around the clock. The loop does two things about it.

**The doorbell.** `queue_state` holds one row with a `version` that moves on every write that can change what a
claim would return: a task row created (`relay task create`, `relay_task_create`, `POST /api/v1/tasks`, or an
`agent:*` label seen by the GitHub webhook), a lease released (the run finished or failed, or the worker gave it
back) and a lease expired. A claim itself does not move it; one worker taking work is not news to the others. On
each tick the worker reads `GET /api/v1/work/doorbell?lanes=<its lanes>`, two indexed reads and no write, and runs
a claim only when the `version` differs from the one it last saw or `queued` is above zero. `queued` is an estimate
from one query (no live lease, and the latest state-changing event leaves the task queued); it does not check the
labels a project requires, so a worker may see `queued: 1` and get `claim: null`, which costs it one claim per tick
and nothing else.

**Adaptive backoff.** The tick starts at 15 seconds (`--interval`) after any activity and doubles while nothing
happens: 15, 30, 60, 120, 240, then 300 seconds and stays there (`--max-interval <seconds>`, or
`RELAY_WORK_MAX_INTERVAL`; the default is 5 minutes). A successful claim resets it to 15 seconds, and when a job
finishes the worker claims once more right away, since a queue that held one task often holds another, before going
back to the doorbell. A doorbell that shows work the worker cannot take does not reset the tick. Heartbeats follow
the same shape: every minute while a lease is held (each one renews the lease), otherwise at most every 5 minutes,
sent on the tick, carrying `interval_ms` so the workers page and `relay work status` show how often the worker is
checking in (`every 5m`). The state derivation is unchanged: online under 2 minutes, idle under an hour, offline
beyond, so an idle worker on the 5-minute cadence shows `idle`, the normal state of a worker with nothing to do.

What this buys: an idle worker now makes about 300 doorbell reads and 300 heartbeats a day (one of each per 5
minutes) instead of 7,200 requests, and the reads are cheap. Pickup latency is one tick: a task opened right after
activity is claimed within 15 seconds; after a long quiet spell, within 5 minutes. Lower `--max-interval` to trade
requests for latency. Note that Neon's auto-suspend fires after 5 minutes of silence by default, so a 5-minute cap
keeps the database awake; set `--max-interval 900` or more (and accept pickup within that long when idle) if you
want it to sleep. `RELAY_DEBUG=1 relay work` logs every interval and version change; `relay work --once` skips the
doorbell and drains the queue with claims alone. A site that predates the doorbell answers 404 and the worker
claims on every tick, with the same backoff. Local mode (no site) runs the identical loop against the machine's own
database.

### Leases

- A claim is taken inside a transaction (`SELECT … FOR UPDATE SKIP LOCKED` on the task, then the insert); a partial
  unique index allows one live claim per task, so two workers polling the same site never run the same task.
- The lease is 30 minutes and every heartbeat renews it, so a live worker keeps its task however long the lane runs.
- Before each claim the server releases every lease that ran out (`outcome = expired`). The task is `queued` again;
  if a `run.started` was recorded under that lease with no finish, the derivation says `queued`, not `running`.
- Task states (docs/INTEGRATIONS.md): `queued` → `claimed` (a live lease, no run yet) → `running` → `review` or
  `failed` → `done`. `relay task ls --state claimed` shows what workers are holding.

## What a job does on the machine

`packages/core/src/work/job.ts` is `scripts/runner/run-lane.sh` in TypeScript, over the lane adapters:

1. Fresh clone with `gh repo clone` into `$RELAY_HOME/work/<owner>_<repo>_<n>`; branch `relay/<lane>-<issue>` from
   the tip of the default branch (a re-run starts over, never from an older attempt).
2. `start` is reported. The brief is fetched from the site (`GET /api/v1/projects/<slug>/brief?issue=N&lane=<lane>`)
   or compiled locally; the prompt is the repo's `relay.md`, the issue quoted under the "data, not instructions"
   banner, the brief, and the deliverable.
3. The lane runs with a per-run time limit (`--max-minutes`, default 60).
4. Whatever the lane left uncommitted is committed as `relay-agent`; a lane that changed nothing is a failed run.
5. `git push --force-with-lease -u origin <branch>`; `gh pr create --title "<lane>: <title>" --body "Closes #N"`
   (or the existing PR is reused); one comment with the lane's summary and the `<!-- relay:usage -->` block.
6. `release` reports the outcome, the PR and the usage. The clone is deleted (`--keep` keeps it).

The usage block in the PR comment is marked `"source": "relay-work"`; the GitHub webhook shows it to humans but does
not count it again, because the release already wrote the `step.usage` row. One worker runs one job at a time by
default; `--jobs 2` allows two, and the lane adapters still serialize per vendor login.

### What a job may run

The Claude lane gets an allowlist of named commands and a refusal list (`CODE_TOOLS`, `CODE_DISALLOWED_TOOLS` in
`packages/core/src/work/job.ts`; `scripts/runner/run-lane.sh` carries the same lists for Actions runners):

| Allowed without asking | Refused outright |
|---|---|
| `Read`, `Edit`, `Write`, `Glob`, `Grep` | `git push`, `git -c`, `git config`, `git remote` |
| `git status`, `git diff`, `git log`, `git add`, `git commit`, `git checkout`, `git restore` | `pnpm dlx`, `pnpm exec`, `npm exec`, `npx` |
| `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm -r …`, `npm test` | `curl`, `wget` |

Anything else Claude Code would ask about, and in `-p` mode a question is a refusal. The worker, not the lane, commits,
pushes (`--force-with-lease`, its own branch only) and opens the PR. Codex runs under its own `--sandbox
workspace-write`; Grok and fx run under their permission modes with no OS sandbox.

This allowlist is a permission policy, **not a sandbox**: `pnpm test` runs whatever the repository's `package.json`
says, with the rights of the OS user the worker runs as, which is the user that holds your logins. Three things
follow (`docs/SECURITY.md`, "Workers"): run `relay work` as a dedicated OS user or in a container that holds the
vendor and `gh` logins and nothing else (no SSH keys, no sudo, no access to your home directory); turn on branch
protection on every linked repository's default branch, since the worker pushes as your `gh` account; and set
`RELAY_ALLOWED_SENDERS` so that only the logins you name can turn a label into a job on your machine.

## Run it as a service

`relay work --install` prints the file it would write and the commands it would run; `--yes` does it. Options you
pass (`--lanes`, `--labels`, `--jobs`, `--name`, `--max-interval`) are baked into the service.

- **macOS**: `~/Library/LaunchAgents/house.kyro.relay.work.plist`, loaded with `launchctl bootstrap gui/<uid>`.
  A LaunchAgent runs in your user session, which is where the vendor CLIs keep their keychain logins (a LaunchDaemon
  would not see them). It runs while you are logged in: enable automatic login or keep a session open on a machine
  that must stay available, and disable sleep in System Settings → Energy.
- **Linux**: `~/.config/systemd/user/relay-work.service`, enabled with `systemctl --user enable --now`. Run
  `loginctl enable-linger $USER` once so the user manager starts at boot without a login.

Both run the relay that installed them (the npm package's `dist/relay.js`, or the checkout's `tsx` entry) with the Node
that ran `--install`, and append to `$RELAY_HOME/work.log`. `relay work --uninstall --yes` stops the service and
removes the file. `relay work status` shows whether it is loaded, the workers the site knows with their state,
poll cadence and current task, and the last ten log lines. To run in the foreground instead: `relay work` (stop with Ctrl-C; running
jobs finish and the worker reports offline), or `relay work --once` to drain the queue and exit.

## Cloud lanes

`claude-cloud` and `codex-cloud` tasks are not claimed by workers. When one is opened (`relay task create --lane
codex-cloud`, `relay_task_create`, `POST /api/v1/tasks`), the site compiles the brief, posts one issue comment that
mentions `@codex` or `@claude` with the brief quoted as data, fires the Claude Routine when `RELAY_CLAUDE_ROUTINE_URL`
and `RELAY_CLAUDE_ROUTINE_TOKEN` are set, and writes `run.dispatched`; the vendor's PR arrives through the GitHub
webhook. The site needs a GitHub token (`GITHUB_TOKEN` or `GITHUB_APP_TOKEN`) for the comment. The `relay-cloud.yml`
caller workflow that `relay link` installs covers the other path, an `agent:*-cloud` label put on an issue by hand on
GitHub; it is optional. docs/RUNNERS.md has the once-per-vendor setup and the limits of the cloud tiers.

## Troubleshooting

- `relay work` says *no lanes to serve*: `relay doctor` shows which login is missing; log in, or force with `--lanes`.
- A task stays `queued`: no online worker serves its lane, or its project requires labels no worker has
  (`relay task get <id>`; the workers page lists lanes and labels per worker).
- A task flips `running` → `queued`: the worker lost its lease mid-run (asleep, offline, killed). The next claim starts
  over from the base branch; the earlier branch is replaced by `--force-with-lease`.
- `run.failed` with *made no changes*: the lane finished without editing anything; its summary is in the event.
- The service does not start on macOS: `launchctl print gui/$(id -u)/house.kyro.relay.work` shows the last exit
  status; `tail -f ~/.harness/work.log` the reason (usually a login or a PATH without the CLIs).
- Codex logins go stale when unused; a weekly `relay probe codex:<model>` keeps the refresh token warm.
