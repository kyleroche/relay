# relay

**Your coding-agent subscriptions, working as one system.**

relay turns Claude Code, Codex, and Grok Build into a team that shares memory, picks up work from GitHub, runs on machines you own, and shows you everything it did and what it cost. No new agent to learn, no tokens leaving your machines.

> Status: alpha. The pieces work individually; the first end-to-end lane is being wired. Watch the feed at a demo soon.

## What you get

- **One memory.** Decisions made in Codex show up in Claude and Grok. A generated rules file in each repo plus a small MCP server keep every tool on the same page.
- **Work from anywhere.** File an issue from your phone, a chat bot, or a terminal. A runner on your own machine picks it up, opens a PR, and your deploy preview appears.
- **Every dollar and token accounted for.** An event feed records what each agent did, on which subscription, at what cost. You see which plan is about to run out before it does.
- **Vendor guidance built in.** Before relay lets a lane use a model, it ingests that vendor's official docs and skills, so prompts for image and video models follow the maker's own guide.

## Quick install

Paste this into whichever coding agent you use:

```text
Set up relay from https://github.com/<org>/relay following its AGENTS.md "Installing relay for a user" section. Stop and tell me when a step needs my browser.
```

Or by hand:

```bash
git clone https://github.com/<org>/relay && cd relay
pnpm install
pnpm relay doctor     # what is installed, logged in, and reachable
pnpm relay setup      # hooks + memory server into each CLI you have
cd ~/code/some-repo && ~/relay/bin/relay link
```

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
