# Workers

relay is its own scheduler. A **worker** is a machine you own that runs `relay work`: it holds your vendor logins,
registers with the relay site, claims the oldest queued task whose lane it can serve, runs the vendor CLI in a fresh
clone, opens the pull request, and reports tokens and cost. No GitHub Actions runner, no org, and no per-repo
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
| `claude` | `claude auth status` reports logged in | `claude -p --permission-mode acceptEdits --allowedTools <CODE_TOOLS> --disallowedTools <CODE_DISALLOWED_TOOLS> --settings <sandbox> --max-turns 40`, no MCP servers, no user settings; Bash runs in Claude Code's OS sandbox ("What a job may run" below) |
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
| heartbeat | `POST /workers/{id}/heartbeat` `{status?}` every 60 s | `last_seen`; every live lease the worker holds is extended to 30 minutes from now; `status: offline` writes `worker.offline` |
| claim | `POST /work/claim` `{worker_id, lanes?, labels?}` | the oldest `queued` task whose lane and labels match, leased for 30 minutes; `claim: null` when nothing is claimable |
| start | `POST /work/{owner}/{repo}%23{issue}/start` `{worker_id, branch}` | `run.started` as `runner:<name>`; the task is `running` |
| release | `POST /work/{owner}/{repo}%23{issue}/release` `{worker_id, outcome, pr, pr_url, summary, error, usage}` | `finished` → `run.finished` (+ PR); `failed` → `run.failed`; `released` frees the lease only. `usage` → one `step.usage` row as `agent:<lane>` |
| list | `GET /workers` (`feed:read`) | every worker with `state` (online < 2 min, idle < 1 h, offline) and its current claim |

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

The Claude lane's Bash, and every process it starts (git, pnpm, the repository's own scripts), runs inside Claude
Code's OS sandbox: Seatbelt on macOS, bubblewrap with socat on Linux. The worker passes the sandbox as one
`--settings` document (`claudeSandboxSettings` in `packages/core/src/lanes/sandbox.ts`; `relay lane settings` prints
it) with `--setting-sources ""`, so it is the only settings the run sees and nothing in `~/.claude` or in the clone can
loosen it. Inside it a command may:

| May | May not |
|---|---|
| read and write the clone; write the pnpm and npm stores (`~/Library/pnpm`, `~/.local/share/pnpm`, `~/.npm`, their caches) | write anywhere else (`~`, `/tmp` outside Claude Code's own, another repository) |
| reach `registry.npmjs.org`, `registry.yarnpkg.com`, `github.com`, `objects.githubusercontent.com`, `codeload.github.com`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `static.crates.io`, `proxy.golang.org`, plus `RELAY_LANE_ALLOWED_DOMAINS`; bind localhost ports | reach any other host (the local proxy answers 403; `strictAllowlist`) |
| read the rest of the filesystem the worker's user can read | read `~/.harness`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.fx`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.gitconfig` |

The sandbox wraps Bash, not the Read/Edit/Write tools, so the same paths are denied again with `permissions.deny`
rules and `blockReadsOutsideWorkingDirectories` keeps the Read tool inside the clone. The Claude Code process itself
(the model call) is outside the sandbox; that is what lets the login work. Because `~/.gitconfig` is unreadable, the
lane's git identity comes from `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` (and email) in the job's environment.

A machine that cannot sandbox does not run the job unsandboxed: `failIfUnavailable` makes `claude` exit, the run is
reported `failed` with a summary saying what to install (`relay doctor` has a `sandbox` line). Linux needs `bubblewrap`
and `socat` on PATH (`sudo apt install bubblewrap socat`, or `dnf`); macOS needs nothing. `relay work --no-sandbox`
turns the sandbox off for that worker: it logs a warning and registers the label `sandbox:off`, which the workers page
shows. A dedicated OS user or an Apple `container` for the worker is the next tier (planned as `relay work --isolation
container`, not built yet).

Behind the sandbox, the Claude lane gets an allowlist of named commands and a refusal list (`CODE_TOOLS`,
`CODE_DISALLOWED_TOOLS` in `packages/core/src/work/job.ts`; `scripts/runner/run-lane.sh` carries the same lists for
Actions runners):

| Allowed without asking | Refused outright |
|---|---|
| `Read`, `Edit`, `Write`, `Glob`, `Grep` | `git push`, `git -c`, `git config`, `git remote` |
| `git status`, `git diff`, `git log`, `git add`, `git commit`, `git checkout`, `git restore` | `pnpm dlx`, `pnpm exec`, `npm exec`, `npx` |
| `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm -r …`, `npm test` | `curl`, `wget` |

Anything else Claude Code would ask about, and in `-p` mode a question is a refusal. The worker, not the lane, commits,
pushes (`--force-with-lease`, its own branch only) and opens the PR. Codex runs under its own `--sandbox
workspace-write`; Grok and fx run under their permission modes with no OS sandbox.

The allowlist is a permission policy, the second layer: it decides which tool calls the CLI accepts, the sandbox
decides what the accepted commands can reach. `pnpm test` still runs whatever the repository's `package.json` says,
as the OS user the worker runs as, boxed by the sandbox above. Three things still follow (`docs/SECURITY.md`,
"Workers"): prefer running `relay work` as a dedicated OS user or in a container that holds the vendor and `gh` logins
and nothing else (no SSH keys, no sudo, no access to your home directory); turn on branch protection on every linked
repository's default branch, since the worker pushes as your `gh` account; and set `RELAY_ALLOWED_SENDERS` so that
only the logins you name can turn a label into a job on your machine.

## Run it as a service

`relay work --install` prints the file it would write and the commands it would run; `--yes` does it. Options you
pass (`--lanes`, `--labels`, `--jobs`, `--name`) are baked into the service.

- **macOS**: `~/Library/LaunchAgents/house.kyro.relay.work.plist`, loaded with `launchctl bootstrap gui/<uid>`.
  A LaunchAgent runs in your user session, which is where the vendor CLIs keep their keychain logins (a LaunchDaemon
  would not see them). It runs while you are logged in: enable automatic login or keep a session open on a machine
  that must stay available, and disable sleep in System Settings → Energy.
- **Linux**: `~/.config/systemd/user/relay-work.service`, enabled with `systemctl --user enable --now`. Run
  `loginctl enable-linger $USER` once so the user manager starts at boot without a login.

Both run the relay that installed them (the npm package's `dist/relay.js`, or the checkout's `tsx` entry) with the Node
that ran `--install`, and append to `$RELAY_HOME/work.log`. `relay work --uninstall --yes` stops the service and
removes the file. `relay work status` shows whether it is loaded, the workers the site knows with their state and
current task, and the last ten log lines. To run in the foreground instead: `relay work` (stop with Ctrl-C; running
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
- `run.failed` with *sandbox unavailable*: Claude Code could not set up its OS sandbox on that worker. On Linux install
  `bubblewrap` and `socat`; `relay doctor` shows the `sandbox` line. The job was not run unsandboxed.
- A Claude job needs a host the sandbox refuses (a private registry, a download in a test): add it with
  `RELAY_LANE_ALLOWED_DOMAINS=host.example,other.example` in the worker's environment (`relay work --install --yes`
  bakes it into the service when it is set at install time).
- The service does not start on macOS: `launchctl print gui/$(id -u)/house.kyro.relay.work` shows the last exit
  status; `tail -f ~/.harness/work.log` the reason (usually a login or a PATH without the CLIs).
- Codex logins go stale when unused; a weekly `relay probe codex:<model>` keeps the refresh token warm.
