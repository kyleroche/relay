# The project profile

A worker that takes a task has a fresh clone, the task's text and relay's memory. The **profile** is the one file
that tells it the rest: how to make the clone ready, which checks the project runs, which scripts matter, and what a
task may be allowed to reach. It is `.relay/project.json`, checked into the repository.

Code: `packages/core/src/steps/profile.ts` (the file), `packages/core/src/work/job.ts` (what a job does with it),
`packages/core/src/work/exec.ts` (how its commands run), `packages/core/src/work/secrets.ts` (where granted values
come from), `packages/core/src/board/tasks.ts` (`grantTask`, `grantsOf`), `packages/core/src/board/schemas.ts`
(`relay-grant@1`), `packages/core/src/adopt/draft.ts` (the first draft `relay link` proposes).

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
the values stay wherever the worker finds them ("Where the values come from" below).

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

A part that does not fit these rules is left out and named as a problem; nothing malformed is half-applied. A job
writes each problem to the worker's log as `profile: …`. A file that is not a JSON object is a profile with nothing
in it and one problem.

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
task.

```bash
relay task grant <task-id> --set orders-api
```

On the board a grant is a `relay-grant@1` block in a reply to the task:

| Field | Meaning |
|---|---|
| `set` | the name of a capability set |
| `cloud_cap_usd` | or: the most a paid sandbox run of this task may cost, in US dollars, above 0 and at most 1000 |
| `digest` | the SHA-256 of the task's title and body as they stood when the grant was given |

A grant holds exactly one of `set` and `cloud_cap_usd`. The rules:

- **A grant is for the text as it stands.** A worker counts a grant only when its `digest` matches the task's title
  and body at the time of the run. A grant given before the text was edited counts for nothing, and the person
  grants again after reading the new text.
- **A worker believes a grant only from an author it trusts**: its own login and the owners in `board.from`
  themselves, and relay's own `relay-…` profiles of them (`docs/WORKERS.md`, "The board").
- **On a site only a signed-in person grants.** A request that carries a token is refused with 403: a token never
  decides what a task may reach or what it may spend. The site posts the block as `relay-site` and says who asked.
  There is no MCP tool for a grant.
- **A finished task is granted nothing.** A grant on a `done` or `closed` task is refused.
- **A set the profile does not define adds nothing.** The run says so in the thread.

At the start of a run with granted sets, the worker posts one line in the thread: the sets, how many hosts, how many
of the variables it found, and the names of the ones it did not. Names only. A value is never written to the thread,
the log, a prompt or a file.

A granted set does two things for that run:

| Part of the set | Effect |
|---|---|
| `env` | the values the worker finds for those names are set in the environment of the lane and of the profile's commands |
| `hosts` | the hosts are added to the network allowlist of the Claude lane's sandbox and of the sandbox the profile's commands run in |

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
link or the pull fails, the worker logs why and the run goes on without the values. Nothing is copied between
machines and nothing is kept.

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
| `relay work --no-sandbox` | directly, with `sh -c`, as the worker's OS user |
| the container tier, when the nested sandbox cannot start | directly, inside the container, which is the boundary |

A worker that should sandbox and cannot find the runtime beside relay does not run the command: it fails with exit
127 and says what is missing. It never falls back to running the command unguarded. With a `setup` command in the
profile, that fails the task.

## Paid sandbox runs

`cloud` says whether a task of the project may ever run in a paid sandbox: `ask` (the default) or `never`.
`relay task grant <task-id> --cloud <usd>` records a person's approval for one task, with the most the run may
cost. When a task has several such grants for its current text, the latest one counts.

A run on paid credits is `relay work --task <id> --billing gateway --cap <usd>` (`docs/WORKERS.md`, "One task on
paid credits").

> Not documented yet: what starts a paid sandbox for a granted task, how it reads `cloud` and the granted cap, and
> the site's pages for grants. That code is still being written.

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

- The tool allowlist entries and the granted hosts apply to the Claude lane, the lane relay sandboxes itself. The
  Codex and Grok lanes get the granted values in their environment; Codex runs under its own sandbox and Grok under
  its permission modes, and relay adds no host allowlist there.
- A key the profile does not define is ignored without a problem.
- The values of a granted set are read from the Vercel project's development environment only.
- `relay task grant` on a machine acts as that machine's own Vercel login. A worker counts it when that login is an
  owner the worker takes tasks from.
