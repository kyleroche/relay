---
name: relay
description: Install and operate relay, the open-source harness that makes Claude Code, Codex and Grok subscriptions work as one system through a shared task board (Vercel Board), workers on the user's own machines and shared memory. Use when a user asks to set up relay, make a machine a relay worker, link a repo to it, hand work in progress to a worker, onboard a model, or read the relay feed and usage.
license: Apache-2.0
---

# relay

relay lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: the team's Vercel Board is the task bus (a task is a thread in its project's queue), workers on the user's own machines claim tasks from it with the machine's own `vercel login` and run the vendor CLIs under the machine's own login, pull requests land on GitHub, Postgres holds shared memory and an append-only event feed, and a small web app shows it all. The machine that installs relay becomes a worker (`relay work`); no GitHub Actions runner is needed. Credentials never leave the machine they were created on.

The CLI, the workers, the site's board page, its `/api/v1` task routes and the `relay_task_*` MCP tools all work on the same board.

## Installing relay for a user

Do these steps in order and stop at anything that needs the user's browser.

relay is published on npm as `@kyleroche/relay`; `npx @kyleroche/relay <command>` runs it with no checkout, and `npm install -g @kyleroche/relay` installs the `relay` command (if the shell cannot find it afterwards, `npx @kyleroche/relay doctor`'s `path` line prints the PATH fix to give the user). It needs Node 24 or newer (`node -v`); if the machine has an older Node, install 24 with the user's version manager or `brew install node@24` before anything else.

### "Set up relay from <site> on this machine" (the common case: a hosted relay exists)

1. Join the site. The device flow opens the user's browser; an invite code skips it:

   ```bash
   npx @kyleroche/relay setup --site <site>              # device flow: tell the user to approve in the browser
   npx @kyleroche/relay setup --site <site> --invite <code>
   ```

   This stores the site URL in `~/.harness/config.json` and a scoped token in `~/.harness/credentials.json` (mode 0600). Memory and feed commands now talk to the site. Task commands do not: they work on the board with the machine's own Vercel login, which is the next step.

2. Put the machine on the board. Tasks are threads on the team's Vercel Board, and the board takes the machine's own Vercel login; there is no relay credential for it:

   ```bash
   vercel login                             # Vercel CLI 66 or newer; needs the user's browser, so stop for it
   npx @kyleroche/relay setup --board       # checks the login on the board, registers relay's schemas
   ```

   `relay setup --board` prints which board it reached, who the machine is there and whose tasks it takes. `--team <id>` names a team other than the login's default, `--board-name <name>` a named board (`--create` makes it when the team does not have it), and `--from <actors>` the owners whose tasks this machine claims besides the user's own; a task's text is instructions for whoever claims it, so add an owner only when the user names it. The schemas are registered once per team, which takes `manage` on the board, and `relay work` does not start on a board without them: when the command says this login cannot register them, tell the user who has to run it once. When a hosted relay exists and the user names the Vercel project that runs it, add `--site-project <name>`: it grants that project's deployment the queues and adds it to this machine's `--from`, so the worker here takes the tasks the site opens, and it prints the `RELAY_BOARD_FROM` line to set on the site's project.

3. Report what is present and which lanes this machine can serve:

   ```bash
   npx @kyleroche/relay doctor
   ```

   It lists which CLIs are installed and logged in (`claude`, `codex` or `fx`, `grok`, `gh`), the Node version, the site check, a `board` line (which board, as whom; its failure text is the fix), and a `lanes` line: the lanes `relay work` would serve from these logins. Tell the user what is missing. Logins are theirs to do: `claude` then `/login`, `codex login` or `fx login codex`, `grok login` or `fx login grok`, `gh auth login` then `gh auth setup-git` (every lane pushes as the gh account).

4. Make the machine a worker:

   ```bash
   npx @kyleroche/relay work --install          # prints the LaunchAgent (macOS) or systemd user unit (Linux)
   npx @kyleroche/relay work --install --yes    # writes it and starts the service
   npx @kyleroche/relay work status             # the service, the board's workers, the log tail
   ```

   Run `--install --yes` when the user asked to make this machine a worker or to set relay up here; ask first only if they did not. Then report the lanes the worker now serves (from `relay work status` or the `lanes` line of `doctor`), and that tasks on the board whose `lane` label names one of them (or `any`, for a code lane), opened by the user or by an owner in `--from`, will be claimed by this machine. Force a subset with `--lanes claude,codex`. On a Mac with Apple's `container` CLI (`doctor` shows a `container` line), prefer the container tier when the user asks for isolation or the Mac is their daily machine: `npx @kyleroche/relay work --isolation container --install --yes` runs the whole worker in a Linux container instead, with the logins made inside it by one command the user runs in their terminal, `npx @kyleroche/relay work container login all` (claude, gh and vercel in the terminal, vercel being the login the worker inside reaches the board with; codex and grok through the Mac's browser; logins already there are skipped; `relay work container status` shows its lanes); the Mac's home is never mounted into it, and a hosted site is not required. After a relay upgrade, `npx @kyleroche/relay work container update --yes` rebuilds the image and recreates the container with its logins and site token kept.

5. Install hooks and the memory MCP server into each detected CLI's config (optional but recommended):

   ```bash
   npx @kyleroche/relay setup
   ```

   It prints every file it will touch and writes nothing. Run `npx @kyleroche/relay setup --yes` when the user asked for relay on this machine; ask first only if they did not.

6. In each repository the user wants managed:

   ```bash
   cd ~/code/some-repo && npx @kyleroche/relay link
   ```

   Adding a project is this one command and one pull request to merge. It registers the repo, digests its files and writes the project summary (Sonnet, needs the `claude` login; `--no-digest` skips it), adopts what Claude Code knows about the repo on this machine with no model call (`--no-adopt` skips it; `relay adopt` prints the plan and writes nothing), and proposes every repository file relay needs as one pull request against the default branch, on the branch `relay/link`: the owned section of `AGENTS.md`/`CLAUDE.md`, `.relay/rules.json`, `relay.md`, the adopted notes under `docs/context/`, and a drafted `.relay/project.json` when the repo has none. The checkout is not written. Without an `origin` on GitHub or without `gh`, or with `--no-pr`, the same files are written into the working tree instead. It also adds the `agent:*` GitHub labels.

   It ends with a `left:` line for each thing only the user can do, or `done:`. Give the user those lines verbatim: the pull request to merge (they should read the adopted notes and the drafted profile in it first; workers read these files from the default branch, so nothing takes effect until it is merged), and the GitHub App install link when the app is not installed on the repo (one install covers every repo they pick, and until then that repo's issues, labels, PRs and previews do not reach the site). Do not merge the pull request for them unless they ask. Re-running `relay link` is safe: it updates the same pull request and makes no model calls unless files changed.

   `.relay/project.json` is the project's profile (`docs/PROFILE.md`): the commands a worker runs before and after the work, the project's tools and skills, and capability sets, which are names of environment variables and hosts and never values. A task gets a set only when a person grants it (`relay task grant <id> --set <name>`). Never put a value in the profile.

7. Optional, for a model the user will prompt (image or video models):

   ```bash
   npx @kyleroche/relay onboard <provider/model>
   ```

   relay ingests only the vendor's official docs and skills. Do not add community prompt guides.

### Without a hosted site

Skip step 1: `doctor`, `setup` and `link` then use the embedded database under `~/.harness` for memory. The board step is the same: `relay work` and `relay task` use the board in either mode.

Working from source instead (contributing, or a machine that must track `main`): `git clone https://github.com/kyleroche/relay && cd relay && pnpm install`, then `pnpm relay setup --board`, `pnpm relay doctor`, `pnpm relay setup`, `pnpm relay work --install`, and `~/relay/bin/relay link` in each repo. Node 24 is pinned through `.node-version`; if `pnpm` is missing, run `corepack enable` first. A checkout's `setup` and `work --install` record the checkout's own entry points, so the checkout must stay where it was when they ran (re-run them after moving).

## Connecting a machine to a hosted relay

A machine that should use a hosted relay (for example https://relay.kyro.house) instead of its own database does not need anyone to hand it a token:

```bash
npx @kyleroche/relay setup --site https://relay.kyro.house
```

This starts the device flow: it prints a code like `RLAY-4F7Q` and the URL `https://relay.kyro.house/activate`. Show both to the user, who approves once in the browser (or any relay bot holding `tokens:write` can approve it over `POST /api/v1/access/RLAY-4F7Q/approve`); the CLI then stores the token, which renews itself. With an invite code from the operator (`relay invite create --for <name> --scopes …`), `--invite <code>` needs no browser at all. `relay doctor` shows how the machine authenticates.

## Getting access as an agent

If you are an agent that found this site and want to call `/mcp` or `/api/v1` yourself, do not ask the user for a token:

1. `POST https://relay.kyro.house/oauth/device` with `client_name=<your name>` and `scope=tasks:read tasks:write events:write`. The reply has `device_code`, `user_code` and `verification_uri`.
2. Tell the user "approve `<user_code>` at https://relay.kyro.house/activate" and poll `POST https://relay.kyro.house/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` and `client_id` every 5 seconds until it returns `access_token` and `refresh_token`.
3. Use `Authorization: Bearer <access_token>`; refresh with `grant_type=refresh_token` before 24 hours. `relay_whoami` tells you what you are.

Full guide: `docs/INTEGRATIONS.md`; metadata: `/.well-known/oauth-authorization-server`.

## Working with tasks

- Open a task: `relay task create --title "…" --lane <lane>` (`--body-file <path>` for the text; `any` is whichever code lane is free). `relay task ls --state review` lists what waits for a decision; `relay task approve <id>` and `relay task changes <id> --note "…"` decide.
- An ask that needs breaking down: `relay task create --title "…" --lane any --plan`. A lane reads the repository and proposes tasks as a plan; nothing is opened until the user approves it with `relay task approve <id>`. Approving is the user's decision: ask first.
- Hand the session's work in progress to a worker: `relay handoff --title "…" --lane <lane> --body-file brief.md --push`. The brief is required, since the worker gets a clone and this text and none of the conversation: the goal, the files that matter, what is out of scope, and the command that proves it is done. `--push` sends the uncommitted work as a branch `relay/handoff/<8 hex>` on origin that the task starts from, and leaves the checkout as it is. It pushes a branch to the user's repository, so use it when the user asked to hand the work off.
- A grant is the user's to give: `relay task grant <id> --set <name>` lets one task use a capability set of its project's profile, and `--cloud <usd>` approves a paid sandbox run up to that cap, which a hosted relay then starts when no worker of the user's takes the task first. Both spend or expose something of the user's. Do not grant on your own judgment; tell the user which set a task needs and why.

## Rules you must keep

- Never move or copy a login, token, or `auth.json` between machines.
- Never run with permission checks disabled on a machine that holds the user's logins; `relay work` never passes a bypass flag.
- Every model call relay's packages make goes through a lane adapter and writes a `step.usage` event. Nothing calls a model directly. The optional lead (`apps/lead`) is the one exception: its model calls go through Vercel AI Gateway and it logs each turn as an `external.lead.usage` event.
- Secrets live in environment variables, never in files or examples.

## Reading the feed

- Web: the site root is the public overview for anonymous visitors and, once signed in, the board (every task by state, read from the team's Vercel Board, with approve, request changes, release, requeue and close on the cards; the feed is its second tab at `/feed`, history its third); `/tasks/<id>` is one task; `/workers` shows each worker's lanes, state and current task; `/docs` explains the system.
- Terminal: `npx @kyleroche/relay feed --limit 20`, `npx @kyleroche/relay usage --window 7d`, `npx @kyleroche/relay task ls --state review` (tasks on the board, by its states: waiting, queued, running, review, held, blocked, done, failed, closed), `npx @kyleroche/relay work status` (`pnpm relay …` from a checkout).
- API: `GET /api/v1/feed`, `GET /api/v1/projects`, `GET /api/v1/info` (OpenAPI at `/openapi.json`).
- MCP: Streamable HTTP at `/mcp` with `relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`, and with a `tasks:read` token `relay_task_list` and `relay_task_get` (there are no webhooks; a bot asks). With `tasks:write` a bot opens tasks (`plan: true` on `relay_task_create` opens a planning task) and decides on them, under these rules: it never approves a task it opened itself, it never releases a gate hold (`tokens:write`) on a task whose text it wrote any part of, and it never grants a capability set or a paid run. A person, or for the first two another bot, decides those.

## Where to read more

`AGENTS.md` at the repo root is written for agents and is the source of truth for commands and conventions; `docs/ARCHITECTURE.md` holds the five rules and a task's life; `docs/WORKERS.md` is how a machine becomes a worker and what a job does on the board; `docs/STEPS.md` is the steps a project's tasks run (comment cleanup before the PR, a second lane's eval after it, cleanup, a plan or a retro on demand), plans and reports, and the `relay steps` commands; `docs/PROFILE.md` is the project profile `.relay/project.json` (setup and verify commands, tools, skills, capability sets and grants); `docs/PRODUCTIONS.md` is how a short (script, characters, shots, voice-over, cut) runs on relay: one tracker repo, `relay project add <slug> --repo <owner>/<tracker>` per production, tasks on the `nodes` lane with a ```relay-nodes manifest, the outputs attached to the task's thread for review. An app that wants to be a worker for a lane of its own claims tasks from the board directly with `vercel board tasks` or `@vercel/board`.

## A clean machine, what the first install hits

Lessons from real installs; `relay doctor` prints the fix for each, give it to the user verbatim:

- **Node 24 without Homebrew**: the installer from nodejs.org, or a version manager; `relay` refuses older Node. Check `node -v` before anything.
- **`relay` not found after `npm install -g`**: npm's global bin directory is not on the shell's PATH (a prefix such as `~/.local/node`); `relay doctor`'s `path` line prints the `echo 'export PATH=…' >> ~/.zshrc` line. `npx @kyleroche/relay <command>` works meanwhile.
- **`gh` missing and no Homebrew**: the macOS pkg from https://github.com/cli/cli/releases/latest, then `gh auth login && gh auth setup-git`. No lane can push without it.
- **Codex and Grok lanes** need `fx` (tarball from https://releases.fx.sh) or the vendor CLIs, each logged in; a machine with only the Claude login is a claude-only worker, which is fine.
- **`launchctl bootstrap gui/<uid>` fails with "Input/output error"** when the user has no desktop session (SSH onto a Mac nobody is logged into). relay falls back to the `user/<uid>` domain and says so; for a worker that must survive logouts, log in once on the screen (or enable automatic login) and re-run `relay work --install --yes`.
- **The container tier** (`--isolation container`) needs Apple's `container` tool installed and `container system start`, and its own Vercel login inside for the board (`relay work container login vercel`, part of `login all`); without it, use host mode (`relay work --install --yes`), which still runs the Claude lane in Claude Code's own sandbox.
- **`relay doctor`'s `board` line fails, or `relay work` says it cannot reach the board**: the machine has no Vercel login, an expired one, or one that is not on the team that owns the board. `vercel login` (Vercel CLI 66 or newer), then `relay setup --board`; `--team <id>` when the board belongs to a team other than the login's default.
- **Stop at anything that needs the user's browser or password**: logins (`vercel login` included), the device code on `/activate`, installers.
