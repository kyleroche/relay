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

## Connecting a machine to a hosted relay

A machine that should use a hosted relay (for example https://relay.kyro.house) instead of its own database does not need anyone to hand it a token:

```bash
npx @kyleroche/relay setup --site https://relay.kyro.house
```

This starts the device flow: it prints a code like `RLAY-4F7Q` and the URL `https://relay.kyro.house/activate`. Show both to the user, who approves once in the browser (or any relay bot holding `tokens:write` can approve it over `POST /api/v1/access/RLAY-4F7Q/approve`); the CLI then stores the token, which renews itself. With an invite code from the operator (`relay invite create --for <name> --scopes …`), `--invite <code>` needs no browser at all. `relay doctor` shows how the machine authenticates.

## Getting access as an agent

If you are an agent that found this site and want to call `/mcp` or `/api/v1` yourself, do not ask the user for a token:

1. `POST https://relay.kyro.house/oauth/device` with `client_name=<your name>` and `scope=tasks:read tasks:write events:write webhooks:write`. The reply has `device_code`, `user_code` and `verification_uri`.
2. Tell the user "approve `<user_code>` at https://relay.kyro.house/activate" and poll `POST https://relay.kyro.house/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` and `client_id` every 5 seconds until it returns `access_token` and `refresh_token`.
3. Use `Authorization: Bearer <access_token>`; refresh with `grant_type=refresh_token` before 24 hours. `relay_whoami` tells you what you are.

Full guide: `docs/INTEGRATIONS.md`; metadata: `/.well-known/oauth-authorization-server`.

## Rules you must keep

- Never move or copy a login, token, or `auth.json` between machines.
- Never run with permission checks disabled on a machine that holds the user's logins.
- Every model call goes through a lane adapter and writes a `step.usage` event. Nothing calls a model directly.
- Secrets live in environment variables, never in files or examples.

## Reading the feed

- Web: the site root is the public overview for anonymous visitors and the feed once signed in; `/docs` explains the system.
- Terminal: `pnpm relay feed --limit 20`, `pnpm relay usage --window 7d`.
- API: `GET /api/v1/feed`, `GET /api/v1/projects`, `GET /api/v1/info` (OpenAPI at `/openapi.json`).
- MCP: Streamable HTTP at `/mcp` with `relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`.

## Where to read more

`AGENTS.md` at the repo root is written for agents and is the source of truth for commands and conventions; `docs/ARCHITECTURE.md` holds the five rules and a task's life.
