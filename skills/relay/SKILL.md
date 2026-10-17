---
name: relay
description: Install and operate relay, the open-source harness that makes Claude Code, Codex and Grok subscriptions work as one system through GitHub issues, workers on the user's own machines and shared memory. Use when a user asks to set up relay, make a machine a relay worker, link a repo to it, onboard a model, or read the relay feed and usage.
license: Apache-2.0
---

# relay

relay lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: GitHub issues are the task bus, workers on the user's own machines run the vendor CLIs under the machine's own login, Postgres holds shared memory and an append-only event feed, and a small web app shows it all. relay is its own scheduler: the machine that installs relay becomes a worker (`relay work`); no GitHub Actions runner is needed. Credentials never leave the machine they were created on.

## Installing relay for a user

Do these steps in order and stop at anything that needs the user's browser.

relay is published on npm as `@kyleroche/relay`; `npx @kyleroche/relay <command>` runs it with no checkout. It needs Node 24 or newer (`node -v`); if the machine has an older Node, install 24 with the user's version manager or `brew install node@24` before anything else.

### "Set up relay from <site> on this machine" (the common case: a hosted relay exists)

1. Join the site. The device flow opens the user's browser; an invite code skips it:

   ```bash
   npx @kyleroche/relay setup --site <site>              # device flow: tell the user to approve in the browser
   npx @kyleroche/relay setup --site <site> --invite <code>
   ```

   This stores the site URL in `~/.harness/config.json` and a scoped token in `~/.harness/credentials.json` (mode 0600). Memory, feed, task and work commands now talk to the site.

2. Report what is present and which lanes this machine can serve:

   ```bash
   npx @kyleroche/relay doctor
   ```

   It lists which CLIs are installed and logged in (`claude`, `codex` or `fx`, `grok`, `gh`), the Node version, the site check, and a `lanes` line: the lanes `relay work` would serve from these logins. Tell the user what is missing. Logins are theirs to do: `claude` then `/login`, `codex login` or `fx login codex`, `grok login` or `fx login grok`, `gh auth login` then `gh auth setup-git` (every lane pushes as the gh account).

3. Make the machine a worker:

   ```bash
   npx @kyleroche/relay work --install          # prints the LaunchAgent (macOS) or systemd user unit (Linux)
   npx @kyleroche/relay work --install --yes    # writes it and starts the service
   npx @kyleroche/relay work status             # the service, the site's workers, the log tail
   ```

   Run `--install --yes` only if the user said so. Then report the lanes the worker now serves (from `relay work status` or the `lanes` line of `doctor`), and that tasks labelled with those lanes will be claimed by this machine. Force a subset with `--lanes claude,codex`; advertise capabilities with `--labels gpu`.

4. Install hooks and the memory MCP server into each detected CLI's config (optional but recommended):

   ```bash
   npx @kyleroche/relay setup
   ```

   It prints every file it will touch and writes nothing. Run `npx @kyleroche/relay setup --yes` only if the user said so.

5. In each repository the user wants managed:

   ```bash
   cd ~/code/some-repo && npx @kyleroche/relay link
   ```

   This is the only per-repo step: it registers the repo, digests its files and writes the project summary (Sonnet, needs the `claude` login; `--no-digest` skips it), writes `relay.md`, and adds the owned section to `AGENTS.md`/`CLAUDE.md` and the `agent:*` GitHub labels. The caller workflows it offers are optional (`--no-workflows` skips them); a worker needs none of them. If link says the GitHub App is not installed, give the user the install link it printed: one install covers every repo they pick, and until then that repo's issues, labels, PRs and previews do not reach the site.

6. Optional, for a model the user will prompt (image or video models):

   ```bash
   npx @kyleroche/relay onboard <provider/model>
   ```

   relay ingests only the vendor's official docs and skills. Do not add community prompt guides.

### Without a hosted site

Skip step 1: `doctor`, `setup`, `link` and `work` then use the embedded database under `~/.harness`, and `relay work` schedules the tasks that machine opened itself.

Working from source instead (contributing, or a machine that must track `main`): `git clone https://github.com/kyleroche/relay && cd relay && pnpm install`, then `pnpm relay doctor`, `pnpm relay setup`, `pnpm relay work --install`, and `~/relay/bin/relay link` in each repo. Node 24 is pinned through `.node-version`; if `pnpm` is missing, run `corepack enable` first. A checkout's `setup` and `work --install` record the checkout's own entry points, so the checkout must stay where it was when they ran (re-run them after moving).

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
- Never run with permission checks disabled on a machine that holds the user's logins; `relay work` never passes a bypass flag.
- Every model call goes through a lane adapter and writes a `step.usage` event. Nothing calls a model directly.
- Secrets live in environment variables, never in files or examples.

## Reading the feed

- Web: the site root is the public overview for anonymous visitors and the feed once signed in; `/workers` shows each worker's lanes, state and current task; `/docs` explains the system.
- Terminal: `npx @kyleroche/relay feed --limit 20`, `npx @kyleroche/relay usage --window 7d`, `npx @kyleroche/relay task ls --state claimed`, `npx @kyleroche/relay work status` (`pnpm relay …` from a checkout).
- API: `GET /api/v1/feed`, `GET /api/v1/projects`, `GET /api/v1/workers`, `GET /api/v1/info` (OpenAPI at `/openapi.json`).
- MCP: Streamable HTTP at `/mcp` with `relay_get_info`, `relay_get_feed`, `relay_get_project`, `relay_get_methodology`.

## Where to read more

`AGENTS.md` at the repo root is written for agents and is the source of truth for commands and conventions; `docs/ARCHITECTURE.md` holds the five rules and a task's life; `docs/WORKERS.md` is how a machine becomes a worker and what a job does.
