# relay

**Your coding-agent subscriptions, working as one system.**

relay turns Claude Code, Codex, and Grok Build into a team that shares memory, picks up work from GitHub, runs on machines you own, and shows you everything it did and what it cost. No new agent to learn, no tokens leaving your machines.

> Status: alpha, deployed. The reference deployment is [relay.kyro.house](https://relay.kyro.house); its public pages, API, and MCP endpoint are open to agents and it scores 100/100 on [is-agentic.com](https://is-agentic.com/scan/relay.kyro.house). The first end-to-end runner lane is being wired.

## What you get

- **One memory.** Decisions made in Codex show up in Claude and Grok. A generated rules file in each repo plus a small MCP server keep every tool on the same page.
- **Work from anywhere.** File an issue from your phone, a chat bot, or a terminal. A runner on your own machine picks it up, opens a PR, and your deploy preview appears.
- **Every dollar and token accounted for.** An event feed records what each agent did, on which subscription, at what cost. You see which plan is about to run out before it does.
- **Vendor guidance built in.** Before relay lets a lane use a model, it ingests that vendor's official docs and skills, so prompts for image and video models follow the maker's own guide.

## Quick install

Paste this into whichever coding agent you use:

```text
Set up relay from https://github.com/kyleroche/relay following its AGENTS.md "Installing relay for a user" section. Stop and tell me when a step needs my browser.
```

Or by hand:

```bash
git clone https://github.com/kyleroche/relay && cd relay   # needs Node 24+ (.node-version) and pnpm
pnpm install
pnpm relay doctor     # what is installed, logged in, and reachable
pnpm relay setup      # hooks + memory server into each CLI you have
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
(Sonnet, a few cents), renders `relay.md` from that summary, and installs the owned sections, caller workflows and
labels. It prints each stage and one cost line, and a second run with nothing changed makes no model calls.
`--refresh` rewrites the summary after memory changes; `--no-digest` skips the model steps.

## Link your model accounts

relay never asks for a token. Log in to each tool you own, on each machine that will run work:

| Tool | Login | Plan |
|---|---|---|
| Claude Code | `claude` then `/login` | Pro or Max |
| Codex | `codex login`, or `fx login codex` | ChatGPT |
| Grok Build | `grok login`, or `fx login grok` | SuperGrok |
| GitHub | `gh auth login` | any |

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

Issues are tasks. Labels pick the lane. Self-hosted runners on your machines run the vendor CLI in a fresh worktree and open a PR. Postgres holds memory and the event feed. A small web app shows the feed, projects, and usage. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the rules and the task lifecycle.

## Hosting

The web app deploys to Vercel with a Neon Postgres database. Locally it runs on an embedded Postgres with no setup. See `docs/HOSTING.md`.

## Contributing

Read [AGENTS.md](AGENTS.md) first; it is written for both people and agents. Apache-2.0.
