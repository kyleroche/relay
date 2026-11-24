# The project profile

A worker that takes a task has a fresh clone, the task's text and relay's memory. The **profile** is the one file
that tells it the rest: how to make the clone ready, which checks the project runs, which scripts matter, and what a
task may be allowed to reach. It is `.relay/project.json`, checked into the repository.

Code: `packages/core/src/steps/profile.ts` (the file), `packages/core/src/work/job.ts` (what a job does with it),
`packages/core/src/work/exec.ts` (how its commands run), `packages/core/src/work/secrets.ts` (where granted values
come from), `packages/core/src/board/tasks.ts` (`grantTask`, `grantsOf`), `packages/core/src/board/schemas.ts`
(`relay-grant@1`, `isDecidingActor`), `packages/core/src/cloud/` (the rules of a paid sandbox run),
`packages/core/src/adopt/draft.ts` (the first draft `relay link` proposes), `apps/web/lib/profile.ts` (the profile
as the site reads it).

## The file

```json
{
  "steps": ["remove-yap", "eval"],
  "setup": ["npm ci"],
  "verify": ["npm test", "npm run typecheck"],
  "tools": [
    { "name": "sync-orders", "run": "node scripts/sync-orders.mjs", "about": "Pulls the day's orders into the local database", "needs": "orders-api" }
  ],
  "skills": ["docs/skills/release/SKILL.md"],
  "sets": {
    "orders-api": { "env": ["ORDERS_API_KEY"], "hosts": ["api.example.com"] }
  },
  "vercel": { "project": "shop" },
  "cloud": "ask"
}
```

Every key is optional. The file holds names and never a value: a set lists the names of environment variables, and
the values stay wherever the worker finds them ("Where the values come from" below). A key the file does not have is
named as a problem and ignored, so a misspelt `verify` is seen. A set may not name a variable that steers the run
instead of carrying a secret: relay's own (`RELAY_*`), git's (`GIT_*`), a proxy, `NODE_OPTIONS`, `PATH`, `HOME` and
the like (`STEERING_ENV` in `packages/core/src/steps/profile.ts`).

| Key | Shape | Meaning |
|---|---|---|
| `steps` | list of step names | the steps the project runs around a task, in order (`docs/STEPS.md`) |
| `setup` | list of one-line commands | make a fresh clone ready; run before the lane's work |
| `verify` | list of one-line commands | the project's own checks; run by the worker after the lane's work |
| `tools` | list of `{ name, run, about, needs }` | the scripts that matter: `run` is the command as typed from the repository's root, `about` is one line on what it is for, `needs` names the capability set it cannot work without |
| `skills` | list of paths inside the repository | skill files the lane is told about |
| `sets` | object of `{ env, hosts }` by name | capability sets: names of environment variables and network hosts |
| `vercel` | `{ project, team }` | the Vercel project whose development environment granted values are read from; `team` is optional |
| `cloud` | `ask` or `never` | whether a task of this project may ever run in a paid sandbox; `ask` when absent |

| Rule | Limit |
|---|---|
| a command (`setup`, `verify`, a tool's `run`) | one line, at most 400 characters |
| a tool's or a set's name | lowercase letters, digits and dashes, a letter first, at most 48 characters |
| a tool's `about` | kept to 300 characters |
| a skill path | relative, inside the repository, no `..`, at most 300 characters |
| a name in a set's `env` | capital letters, digits and underscores, a capital first, at most 96 characters |
| a host | a host name such as `api.example.com`, or `*.example.com` for its subdomains |

A set may not name a variable that no job may carry: the API keys and tokens in `JOB_ENV_STRIPPED`
(`packages/core/src/work/env.ts`), which include the model providers' keys, `GH_TOKEN`, `GITHUB_TOKEN` and the
credentials the worker itself reaches the board, the site and Vercel with. A tool's `needs` must name a set the
profile defines.

A part that does not fit these rules is left out and named as a problem; nothing malformed is half-applied. A key
the profile does not have is a problem too and is ignored: a misspelt `verify` would otherwise be a check that never
runs. A job writes each problem to the worker's log as `profile: …`, and the site shows them on the task's page. A
file that is not a JSON object is a profile with nothing in it and one problem.

## Read from the default branch

A job reads the profile with `git show` from the repository's default branch on the remote, never from the task's
working tree and whatever `base` the task starts from. A task therefore cannot widen its own access or drop a check
that judges it: changing the profile takes a merged pull request. The project's steps are read the same way
(`docs/STEPS.md`).

## What a job does with it

On a code task, in this order:

1. **Setup.** Each `setup` command runs in the clone before the lane starts. A command that exits non-zero fails the
   task, with the end of what it printed in the thread, and the lane does not run.
2. **The lane is told.** The prompt gets a section that says which setup commands already ran, which checks the
   worker will run afterwards, each tool with its command and what it is for, and each skill file with the
   `description` from its frontmatter. For a tool that needs a set, it says whether this task was granted the set.
   When it was not, the lane is told the tool will fail and to say so in its summary instead of working around it.
3. **The allowlist.** Each `setup`, `verify` and tool command is added to the Claude lane's Bash allowlist as
   written, with any arguments after it.
4. **Verify.** After the lane's work is committed, the worker runs each `verify` command itself. The results go in
   the pull request's comment and in the task's thread as `Checks the worker ran (all passed)` or
   `(N of M failed)`, with the end of the output of each one that failed. A failed check does not fail the task: the
   pull request still opens and the reviewer reads the result.

A read-only step run by itself, such as `plan` or `retro`, runs no `setup` and no `verify`.

## Capability sets and grants

A task gets no capability set by default. A set defined in the profile does nothing until a person grants it to one
task: on a machine with `relay task grant`, or on a hosted relay in the Grants panel of the task's page
(`/tasks/<id>`), which lists each set of the profile with its variables and hosts and a Grant button.

```bash
relay task grant <task-id> --set orders-api
```

On the board a grant is a `relay-grant@1` block in a reply to the task:

| Field | Meaning |
|---|---|
| `set` | the name of a capability set |
| `cloud_cap_usd` | or: the most a paid sandbox run of this task may cost, in US dollars, above 0 and at most 1000 |
| `digest` | the SHA-256 of what a lane is given as the task when the grant was given: its title, its body and every note people added in the thread (`grantDigest`) |

A grant holds exactly one of `set` and `cloud_cap_usd`. The rules:

- **A grant is for the text as it stands.** A worker counts a grant only when its `digest` matches the task's title,
  body and notes at the time of the run. A grant given before the text was edited, or before somebody added a note
  to the thread, counts for nothing, and the person grants again after reading the new text. This is the same rule
  as a release of the gate's hold.
- **A grant that was edited is none.** An edit keeps its author's name whoever made it, and relay never edits a
  grant, so a grant or a release on an edited message is not believed.
- **A grant is believed only from who may decide** (`isDecidingActor`): a trusted principal itself (the worker's own
  login, an owner in `board.from`: a person at the CLI) or the site's own profile of one, `relay-site`, which the site
  writes only after a signed-in person asked. A worker's profile (`relay-<worker>-<lane>`) reports what a run did and
  never decides, so a lane that got hold of its worker's board credential cannot grant its own task anything. A gate
  release is believed under the same rule.
- **On a site only a signed-in person grants.** A request that carries a token is refused with 403: a token never
  decides what a task may reach or what it may spend. The site posts the block as `relay-site` and says who asked.
  There is no MCP tool for a grant.
- **A finished task is granted nothing.** A grant on a `done` or `closed` task is refused.
- **A set the profile does not define adds nothing.** The run says so in the thread.

At the start of a run with granted sets, the worker posts one line in the thread: the sets, how many hosts, how many
of the variables it found, and the names of the ones it did not. Names only. relay itself never writes a value to
the thread, the log, a prompt or a file, and it takes granted values out of text that could carry one: what a
command printed and what a lane said are stripped of every granted value (each becomes its variable's name in
brackets) before they reach the thread, the pull request or the task's reason, and a change that contains a granted
value is not pushed: the task fails and says which variable. A value shorter than 6 characters is not looked for.

A granted set does two things for that run:

| Part of the set | Effect |
|---|---|
| `env` | the values the worker finds for those names are set in the environment of the profile's commands, and of the lane when the lane is `claude` |
| `hosts` | the hosts are added to the network allowlist of the Claude lane's sandbox and of the sandbox the profile's commands run in |

Only the Claude lane can be held to the hosts a set names. On any other lane the values go to the profile's own
commands, which relay sandboxes itself, and are withheld from the lane's process. The thread's access line and the
lane's prompt say which names were withheld, so the lane reports that a tool needing one will fail there.

The lane is told which variables are set and never to print a value or write one to a file. A variable that was
granted and not found is named to the lane too, so it reports the failure instead of guessing.

## Where the values come from

`relay work` looks for each granted name in two places, in order:

1. **The worker's own environment**, as its operator set it.
2. **The Vercel project the profile names** (`vercel`), read with the worker's own `vercel login`:
   `vercel link` and `vercel env pull` for the development environment, in a private scratch directory outside the
   clone. Only the granted names are taken from the pulled file, and the directory is deleted before the lane
   starts.

A name found in neither place is left out and the run says which. When the Vercel CLI is not on the worker, or the
link or the pull fails, the worker keeps what its own environment gave, logs why the rest is missing, and the run
goes on. Nothing is copied between machines and nothing is kept.

## The sandbox the commands run in

`setup` and `verify` commands run without a model, and `npm ci` runs every dependency's install script. So each
command runs under Anthropic's sandbox runtime (`srt`, the npm package `@anthropic-ai/sandbox-runtime`: Seatbelt on
macOS, bubblewrap on Linux), with the same limits as the Claude lane's Bash (`docs/WORKERS.md`, "What a job may
run"):

| | Allowed |
|---|---|
| write | the clone and the package caches |
| read | everything except the credential paths the Claude lane's sandbox denies |
| network | the default hosts of the Claude lane's sandbox, plus the hosts of the granted sets |

The settings file for each command is written to a scratch directory outside the clone, readable by the worker's
user only, and deleted when the command ends. Each command has 20 minutes.

| Worker | How the commands run |
|---|---|
| `relay work` (the default) | under the sandbox runtime |
| `relay work --no-sandbox` on a host | still under the sandbox runtime: the flag is about the Claude lane's Bash. Where the runtime cannot start, the command fails and does not run |
| the container tier, when the nested sandbox cannot start | directly, inside the container, which is the boundary and holds the logins made in it |
| a paid run's microVM | directly, inside the microVM |

The runtime is a dependency of relay and is installed with it. `relay doctor`'s `sandbox` line warns when it is not
found beside relay. A worker that should sandbox and cannot find it does not run the command: it fails with exit 127
and says what is missing. It never falls back to running the command unguarded. With a `setup` command in the
profile, that fails the task.

## Paid sandbox runs

Every lane runs on your subscriptions, on your machines, and waiting for one of them is the default. A hosted relay
can offer to run one queued task in a Vercel Sandbox on paid credits instead. Nothing starts and nothing is spent
until a person approves a cap for that one task. `cloud` in the profile says whether a task of the project may ever
run that way: `ask` (the default) or `never`.

**Experimental.** No paid run has been made against a real sandbox or a real gateway. A deployment offers none
unless `RELAY_GATEWAY_TOKEN` is set. Read "What a paid run's lane can reach" in `docs/SECURITY.md` before you set it:
inside the sandbox the lane can run any code, and what the sandbox's firewall signs for it, that code can use.

**The offer.** The site computes it each time it renders a queued task, on the board's card and on the task's page,
and writes nothing to make it (`cloudOffer` in `packages/core/src/cloud/offer.ts`). A task is offered a run only
when all of this holds:

| Condition | |
|---|---|
| the deployment is set up | `RELAY_GATEWAY_TOKEN` is set (`docs/HOSTING.md`) |
| the task is `queued` | |
| its lane is `claude` or `any` | a paid run uses the Claude lane, the only one with a gateway adapter |
| the profile could be read and does not say `cloud: never` | |
| no worker on a person's own subscriptions that is online or idle serves the lane | a paid run's own worker does not count |
| it has waited long enough | `RELAY_CLOUD_AFTER_MINUTES`, 15 by default, counted from when the task was opened |

The offer reads "Waiting for a worker" with two choices. "Keep waiting" folds it away for that viewer and does
nothing else. "Run in cloud" opens a sheet with an estimate and a cap to edit:

| Number | Rule |
|---|---|
| estimate | the median cost of the project's past runs on the Claude lane, from the feed; "no history yet" with fewer than 3 |
| the cap shown first | twice the estimate, at least 1 US dollar, at most the deployment's limit |
| the deployment's limit | `RELAY_CLOUD_MAX_CAP_USD`, 10 US dollars by default, never above 1000 |

**What the cap is.** relay stops its own model calls at the cap: each call relay starts gets what is left of it. It
is not a limit the gateway keeps. The sandbox's firewall adds the site's gateway key to any request for the gateway's
coding endpoint, whichever process in the sandbox sent it, so code a fooled lane runs there can call the gateway
outside relay's count and spend more. The only limit on that is the budget set on the key itself, at the gateway
(`docs/HOSTING.md`, 8c). The sheet says this beside the amount (`CLOUD_CAP_NOTE` in
`packages/core/src/cloud/offer.ts`).

**The branch rule.** A run is approved, and later started, only for a repository whose default branch takes changes
through a pull request that someone else approved (`apps/web/lib/cloud/guard.ts`). The site asks GitHub, as its
GitHub App, each time:

| GitHub must say | Why |
|---|---|
| a pull request is required | else the lane could `git push` its work straight to the default branch |
| with at least 1 approval | the run's token opened the pull request, and GitHub lets nobody approve their own |
| of the most recent push | else the lane could push onto someone else's open pull request, approve that one as relay's App, and merge it |
| and relay's GitHub App may not bypass the rule | the run's token is the App's |

Without it the sheet says what to turn on and Approve is off; the approve action and the pool refuse the same way.
Use a ruleset (Settings, Rules, Rulesets). Classic branch protection is believed only when the App may read its
settings, which takes the Administration permission relay's App does not ask for. When GitHub does not say whether
the App may bypass a ruleset, the run is allowed and the sheet says that it is not known.

The rule has a cost, and it is the price of this design: relay's own Approve merges as the same GitHub App, so on
such a repository it merges a pull request only after a person approved it on GitHub.

**The approval is a grant.** Approving posts a `relay-grant@1` block with `cloud_cap_usd` in the task's thread, under
the rules of every grant: a signed-in person only, for the task's text as it stands. `relay task grant <task-id>
--cloud <usd>` on a machine writes the same grant. Granting a paid run also puts the label `cloud=approved` on the
task. The label is a hint that tells the site which threads to read; a run is started for the grant in the thread,
never for the label. When a task has several such grants for its current text, the latest one counts. A grant above
the deployment's limit is not acted on.

**The start** (`packages/core/src/cloud/start.ts`, `apps/web/lib/cloud/pool.ts`). The site's pool is the only thing
that starts a sandbox, and only for a queued task that carries such a grant and whose profile still allows it. It
looks right after an approval on the site, and again when the board, the feed or the usage page is loaded, at most
every 15 seconds. Nothing wakes it otherwise, so a grant made with the CLI is acted on at the next such load. One of
your own workers that claims the task first wins: the task has left the queue and nothing starts.

- A start is marked in the task's thread, as `relay-site`, before the sandbox is made, under a key made from the
  task, the grant and the try. Two instances that look at once make one mark and one sandbox.
- A start that did not come up (the sandbox was refused, a tool would not install) is marked failed and tried again,
  3 times at most.
- A grant is one run. A start that may have run and spent is never followed by another by itself: when the task is
  in the queue again, the person is asked again.

**What the sandbox is** (`packages/core/src/cloud/plan.ts`, `apps/web/lib/cloud/launch.ts`):

| | |
|---|---|
| image and size | Vercel's `vercel/sandbox/universal` image, 2 vCPUs, not persistent |
| lifetime | 10 minutes plus 10 per dollar of the cap, at least 15 minutes and at most 60, and never past the life of the credentials at its firewall |
| network | deny by default. Allowed: the board, the model gateway's coding endpoint, GitHub as the next rows say, `registry.npmjs.org`, and the hosts of the capability sets granted to the task. A set's wildcard that takes in the board's, the gateway's or GitHub's host (`*.github.com`) is refused, and the run does not start |
| `github.com` | git over https for the task's one repository: `info/refs`, `git-upload-pack`, `git-receive-pack`. Every other path on the host is answered 403 by the firewall, so no other repository is reachable, public ones included (a project whose install fetches git dependencies from GitHub cannot run this way) |
| `api.github.com` | `GET /`, `POST /graphql`, and reads under `/repos/<repo>`. Every other request is answered 403 by the firewall; the REST paths that merge, that move or delete a ref, and those of branch protection and rulesets are refused by name, for any repository |
| credentials | three, all added to requests by the sandbox's firewall and none readable inside. The board: the site's deployment under the worker's profile, held to the task's own queue `work/<project>` and the workers channel. GitHub: an installation token of the site's GitHub App for the one repository, minted with `contents: write`, `pull_requests: write` and `metadata: read` and nothing else the App holds. The gateway: the site's key. The variables inside hold a placeholder. The launcher refuses to start if a credential would be readable there, if GitHub's token may do more than those three permissions, or if the board's policy names another queue or another profile |
| what runs | it checks Node 24, git and gh, installs `@kyleroche/relay` at the site's own version and Claude Code at one exact version (`CLOUD_CLAUDE_CODE_VERSION` in `packages/core/src/cloud/plan.ts`, changed only on purpose), then runs `relay work --task <id> --billing gateway --cap <usd> --no-sandbox` as the worker `cloud-<ref>`. The microVM is the isolation, so Claude Code's own OS sandbox is off there, and the lane can run any code in it |

What the firewall cannot do. `gh` opens and comments on a pull request through `/graphql`, and a firewall rule sees
a path, not a request's body: a merge sent as a GraphQL mutation is signed like any other request there. A push to
the default branch is the same request as a push of the run's own branch. The branch rule above is what stops both.

**The job decides again** (`paidRun` in `packages/core/src/work/job.ts`; `docs/WORKERS.md`, "One task on paid
credits"). The worker inside runs on paid credits only when the thread holds a person's grant for the text as it
stands and the profile does not say `cloud: never`. Otherwise it hands the task back untouched. The run has one cap
for all the model calls relay makes: the smaller of the grant and `--cap`.

What a paid run does not do:

- The values of a granted capability set do not reach a cloud sandbox. Its hosts are allowed; its variables are not
  found there, and the run says which.
- An `after-pr` step is not run: the sandbox cannot open a task another worker takes. The work goes straight to
  review and the thread says so.

Nothing here has been run against a real sandbox or a real gateway yet: not the firewall's rules, not `gh` and
`git` behind them, not the narrowed token. The sandbox installs the version of `@kyleroche/relay` in
`packages/cli/package.json`, so that version must be published to npm, with `relay work --task` and `--billing` in
it, before a paid run can work.

## A first profile from adoption

`relay link` proposes a drafted `.relay/project.json` in its pull request when the repository has none and Claude
Code has a directory for the repository on that machine. The draft comes from the commands Claude Code's transcripts
show were run there, counted with their arguments dropped and with no model call, and from what the repository says
about itself: the checks its CI runs, its lockfile, its package scripts, and for the scripts run most, the names of
the environment variables they read and the hosts they call. Names only: no value of any variable is read from
anywhere. Installed and built scripts are left out of the tools. A draft that looks like it holds a secret is not
proposed.

The draft is for a person to edit in the pull request. A repository that already has a profile keeps it untouched;
`relay adopt` prints what the commands that were run would add to it and writes nothing.

## Limits

- The tool allowlist entries and the granted hosts apply to the Claude lane, the lane relay sandboxes itself. On the
  Codex and Grok lanes the granted values are withheld from the lane and reach the profile's commands only.
- The values of a granted set are read from the Vercel project's development environment only.
- `relay task grant` on a machine acts as that machine's own Vercel login. A worker counts it when that login is an
  owner the worker takes tasks from.
