---
name: relay
description: Install and operate relay, the open-source harness that makes Claude Code, Codex and Grok subscriptions work as one system through GitHub issues, self-hosted runners and shared memory. Use when a user asks to set up relay, link a repo to it, register a runner, onboard a model, or read the relay feed and usage.
license: Apache-2.0
---

# relay

relay lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: GitHub issues are the task bus, self-hosted runners on the user's own machines run the vendor CLIs under the machine's own login, Postgres holds shared memory and an append-only event feed, and a small web app shows it all. Credentials never leave the machine they were created on.

## Installing relay for a user

Do these steps in order and stop at anything that needs the user's browser.

1. Clone and install:

   ```bash
   git clone https://github.com/kyleroche/relay && cd relay
   pnpm install
   ```

   Node 24 is pinned through `.npmrc`; pnpm fetches it. If `pnpm` is missing, run `corepack enable` first.

2. Report what is present:

   ```bash
   pnpm relay doctor
   ```

   It lists which CLIs are installed and logged in (`claude`, `codex` or `fx`, `grok`, `gh`), the Node version, and database reachability. Tell the user what is missing. Logins are theirs to do: `claude` then `/login`, `codex login` or `fx login codex`, `grok login` or `fx login grok`, `gh auth login`.

3. Install hooks and the memory MCP server into each detected CLI's config:

   ```bash
   pnpm relay setup
   ```

   It prints every file it will touch and asks before writing. Pass `--yes` only if the user said so.

4. In each repository the user wants managed:

   ```bash
   cd ~/code/some-repo && ~/relay/bin/relay link
   ```

   This is the only per-repo step: it registers the repo, digests its files and writes the project summary (Sonnet, needs the `claude` login; `--no-digest` skips it), writes `relay.md`, and adds the owned section to `AGENTS.md`/`CLAUDE.md`, the `agent:*` GitHub labels, and the caller workflow. Re-running it is safe; `--refresh` rewrites the summary.

5. Optional, for runners: follow `docs/RUNNERS.md` to register a self-hosted GitHub Actions runner on a machine that holds the logins.

6. Optional, for a model the user will prompt (image or video models):

   ```bash
   pnpm relay onboard <provider/model>
   ```

   relay ingests only the vendor's official docs and skills. Do not add community prompt guides.

## Rules you must keep

- Never move or copy a login, token, or `auth.json` between machines.
- Never run with permission checks disabled on a machine that holds the user's logins.
- Every model call goes through a lane adapter and writes a `step.usage` event. Nothing calls a model directly.
- Secrets live in environment variables, never in files or examples.

## Reading the feed

- Web: the site root is the feed; `/projects`, `/usage`, `/workers` are rollups; `/info` explains the system.
- Terminal: `pnpm relay feed --limit 20`, `pnpm relay usage --window 7d`.
- API: `GET /api/v1/feed`, `GET /api/v1/projects`, `GET /api/v1/info` (OpenAPI at `/openapi.json`).
- MCP: Streamable HTTP at `/mcp` with `relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`.

## Where to read more

`AGENTS.md` at the repo root is written for agents and is the source of truth for commands and conventions; `docs/ARCHITECTURE.md` holds the five rules and a task's life.
