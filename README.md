# relay

**Your coding-agent subscriptions, working as one system.**

relay turns Claude Code, Codex, and Grok Build into a team that shares memory, picks up tasks from your team's Vercel Board, runs on machines you own, and shows you everything it did and what it cost. No new agent to learn, no tokens leaving your machines.

> Status: alpha, deployed. The reference deployment is [relay.kyro.house](https://relay.kyro.house); its public pages, API, and MCP endpoint are open to agents and it scores 100/100 on [is-agentic.com](https://is-agentic.com/scan/relay.kyro.house). Workers and the CLI's task commands run on Vercel Board; the web app's board page and task API still use the site's own task table and move to the board next.

## What you get

- **One memory.** Decisions made in Codex show up in Claude and Grok. A generated rules file in each repo plus a small MCP server keep every tool on the same page.
- **Work from anywhere.** Open a task with `relay task create` from any machine that has your Vercel login. A worker on your own machine claims it, opens a PR and holds the task for your review. `relay task approve` merges the pull request the worker opened for that task and nothing else; `relay task changes --note` sends it back and the next run reads the note; a task that failed or is on the wrong lane goes back to the queue with `relay task requeue`. Before a worker runs anything, an injection gate grades the task text and holds what reads as instructions to the agent; `relay task release` lets it through once you have read it ([docs/SECURITY.md](docs/SECURITY.md), "The gate").
- **A second opinion before yours.** A project lists the steps its tasks run: comment cleanup before the PR opens, a second lane that judges the finished work and the first lane's answer to each finding, a cleanup pass on demand. Steps are Markdown files you can replace ([docs/STEPS.md](docs/STEPS.md)).
- **Every dollar and token accounted for.** An event feed records what each agent did, on which subscription, at what cost. You see which plan is about to run out before it does.
- **Vendor guidance built in.** Before relay lets a lane use a model, it ingests that vendor's official docs and skills, so prompts for image and video models follow the maker's own guide.

## Quick install

Paste this into whichever coding agent you use:

```text
Set up relay from https://github.com/kyleroche/relay following its AGENTS.md "Installing relay for a user" section. Stop and tell me when a step needs my browser.
```

Or by hand, with Node 24 or newer and no checkout:

```bash
npx @kyleroche/relay setup --site https://relay.example.com   # join a hosted relay (device flow or --invite <code>); skip for a single machine
npm install -g @kyleroche/relay   # the relay command; doctor's path line says what to do if the shell cannot find it
vercel login                      # the tasks live on your team's Vercel Board, which takes this machine's own login (Vercel CLI 66 or newer)
relay setup --board               # checks that login on the board, saves which board and whose tasks, registers relay's schemas
relay doctor                      # what is installed, logged in, reachable, and which lanes this machine can serve
npx @kyleroche/relay work --install --yes   # this machine becomes a worker: a service that claims and runs tasks for those lanes (add --isolation container to run it all in a Linux container; then `relay work container login all` makes the logins inside)
npx @kyleroche/relay setup      # hooks + memory server into each CLI you have, and Claude Code's plan-meter status line; --yes writes
cd ~/code/some-repo && npx @kyleroche/relay link
```

The published package (`@kyleroche/relay` on npm) carries the CLI, the session hooks and the memory MCP server;
`relay setup` points the CLIs at the installed copy. To work from source instead, clone the repo and use its own
entry points, which the hooks then call through `tsx`:

```bash
git clone https://github.com/kyleroche/relay && cd relay   # needs Node 24+ (.node-version) and pnpm
pnpm install
pnpm relay setup --board
pnpm relay doctor
pnpm relay setup
cd ~/code/some-repo && ~/relay/bin/relay link
```

To point a machine at a hosted relay instead of its own database, nobody hands it a token:

```bash
npx @kyleroche/relay setup --site https://relay.kyro.house     # prints a code; approve it once at relay.kyro.house/activate
npx @kyleroche/relay setup --site https://relay.kyro.house --invite <code>   # zero-browser: a code from `relay invite create`
```

Agents get access the same way, by themselves: `POST /oauth/device`, a person approves the short code once, then the
bearer token works on `/mcp` and `/api/v1` and renews itself ([Connect in one step](docs/INTEGRATIONS.md)).

`relay link` is the only per-repo step: it registers the repo, digests its files and writes the project summary
(Sonnet, a few cents), renders `relay.md` from that summary, and installs the owned sections and
labels. On a hosted relay it ends by checking that the site's GitHub App is installed on the repo, and prints the
install link when it is not (without it the repo's issues, labels, PRs and previews never reach the site). It prints
each stage and one cost line, and a second run with nothing changed makes no model calls. `--refresh` rewrites the
summary after memory changes; `--no-digest` skips the model steps; `--no-events` skips the GitHub App check.

A project without a checkout, such as a film production whose tasks end in an asset rather than a pull request, is
registered with `npx @kyleroche/relay project add <slug> --repo owner/name`; several productions can share one
repository. A worker with Griptape Nodes runs the task's workflow and attaches the outputs to the task's thread,
held for review ([docs/WORKERS.md](docs/WORKERS.md), "The nodes lane").

## Link your model accounts

relay never asks for a token. Log in to each tool you own, on each machine that will run work:

| Tool | Login | Plan |
|---|---|---|
| Claude Code | `claude` then `/login` | Pro or Max |
| Codex | `codex login`, or `fx login codex` | ChatGPT |
| Grok Build | `grok login`, or `fx login grok` | SuperGrok |
| GitHub | `gh auth login` | any |
| Vercel (the board the tasks live on) | `vercel login` (Vercel CLI 66 or newer), then `relay setup --board` | a team with a board |
| Griptape Nodes (the `nodes` lane: video, image and audio workflows) | install the engine from [docs.griptapenodes.com](https://docs.griptapenodes.com); the vendor keys the workflow uses stay in that machine's environment | pay per output |

`relay doctor` tells you which ones it found. Machines without a login simply do not get that lane's label.

## Memory in daily use

Once `relay setup --yes` has run, every Claude Code, Codex or Grok Build session that starts inside a linked repo
begins with that project's brief (decisions, preferences, summary; ≤2.5K tokens, cached), each prompt in Claude Code
and Grok Build is prefixed with the decisions that match it (≤1K tokens), and the session's durable decisions are
extracted when it ends. The same memory is one `relay_recall` / `relay_decide` tool call away through the `relay`
MCP server. By hand:

```bash
pnpm relay decide "We use vitest because it runs PGlite in-process"
pnpm relay prefer commit_style "imperative, one topic" --scope project
pnpm relay recall "which test runner"
pnpm relay memory history
```

See [docs/MEMORY.md](docs/MEMORY.md) for the data model, the brief compiler and the hooks.

## How it fits together

A task is a thread in its project's queue on your team's Vercel Board. A `lane` label picks the lane; where the work happens is in the task's own text, and what a run produced is in blocks the board verifies the author of. Workers (your machines running `relay work`) claim tasks from the board, run the vendor CLI in a fresh clone, open a PR on GitHub and report in the task's thread; no GitHub Actions runner is needed. Postgres holds memory and the event feed. A small web app shows the feed, projects, workers, and usage. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the rules and the task lifecycle, [docs/WORKERS.md](docs/WORKERS.md) for how a machine becomes a worker, and [docs/STEPS.md](docs/STEPS.md) for the steps a project runs around a task.

## Hosting

The web app deploys to Vercel with a Neon Postgres database. Locally it runs on an embedded Postgres with no setup. See `docs/HOSTING.md`.

## Contributing

Read [AGENTS.md](AGENTS.md) first; it is written for both people and agents. Apache-2.0.
