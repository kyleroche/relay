# AGENTS.md — relay

relay is an open-source harness that lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: GitHub issues are the task bus, self-hosted runners on the user's own machines execute steps with the vendor CLIs under the machine's own login, a Postgres database holds shared memory and an append-only event feed, and a small web app shows it all. Credentials never leave the machine they were created on.

## Layout

- `packages/core` — TypeScript library: `db/` (Postgres schema + migrations + typed queries; PGlite locally, Neon in production), `brief/` (the brief compiler and `relay.md` renderer), `memory/` (transcript capture: parse, gate, extract decisions with the Sonnet lane), `onboard/` (official-vendor-docs ingestion gate), `lanes/` (headless adapters for `claude -p`, `fx`, `codex exec`, `grok -p`), `ledger/` (step.usage writer and price table), `assets/` (Blob or local store, versions, review), `rules/` (owned-section installer for `AGENTS.md`/`CLAUDE.md`), `hooks/` (per-CLI hook installers and the brief cache), `state/` (project registration and file digests), `tasks/` (`openTask`: a GitHub issue with a lane label, state derived from the feed), `github/` (`client.ts`: issues over the GitHub App, `GITHUB_TOKEN` or `gh`; `app.ts`: installation tokens from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` via jose, cached per installation), `oauth/` (the OAuth 2.1 authorization server, framework-free: PKCE codes, refresh rotation, RFC 8628 device codes, RFC 7591 registration, revocation, the `urn:relay:invite` grant; `db/oauth.ts` holds its queries, `db/settings.ts` the sealed settings), `webhooks/` (signed outbound deliveries with retries), `client/` (`RelayClient`: the command surface over the local database or a hosted site, chosen by `openHarness()`; `device.ts` is the CLI side of the device flow, invites and refresh).
- `packages/cli` — the `relay` command. `src/commands/` holds one file per command group (`setup`, `link`, `brief`, `recall`, `decide`, `prefer`, `capture`, `memory`, `assets`, `token`, `invite`, `task`, `webhook`), `hooks/*.mjs` are the dependency-free scripts the CLIs' hooks point at, `templates/` the caller workflows `relay link` installs. `relay onboard <model>` ingests vendor guidance; `relay feed`, `relay usage`, `relay doctor`; `relay token create` mints scoped bearer tokens for the web app (hash stored, shown once); `relay task` opens and reads tasks; `relay webhook` manages outbound webhooks. `relay setup --site <url>` puts the CLI in site mode through the device flow (it prints a code approved at `<site>/activate`; `--invite <code>` redeems an invite instead, `--token <t>` pastes one): commands and hooks call the hosted site's `/api/v1` and `/mcp` instead of a local database and the token renews itself (`docs/MEMORY.md`, "Site mode"). `relay invite create` mints one-time codes; `relay doctor` shows how the machine authenticates. Published to npm as `@kyleroche/relay`: `tsup.config.ts` bundles `src/main.ts` and the MCP stdio entry with `@relay/core` and `@relay/mcp` into `dist/relay.js` and `dist/relay-mcp.js` (runtime dependencies stay external and are listed in `package.json`, `sharp` optional), and `scripts/postbuild.mjs` copies `hooks/*.mjs` and the SQL migrations beside them. `runtimePaths()` in `packages/core/src/runtime.ts` tells the hook installers, the migration loader and the template copier where relay's files are in either layout (checkout or installed package); path code does not count `..` from `import.meta.url` on its own, because the bundle has one `import.meta.url` for every module.
- `packages/mcp` — the relay MCP server `@relay/mcp`: `bin/relay-mcp.mjs` (stdio for the CLIs from a checkout; the published package ships it bundled as `dist/relay-mcp.js`), `createMcpHandler` (Streamable HTTP for the web app), one tool set for both: public read tools (`relay_get_*`), memory tools (`relay_recall`, `relay_brief`, `relay_guidance`, `relay_feed`, `relay_project`, `relay_decide`, `relay_prefer`), asset tools (`relay_asset_*`), task tools (`relay_task_create`, `relay_task_get`, `relay_task_list`), `relay_event_log` (external bots' own `external.*` events, actor always `bot:<token name>`), `relay_webhook_subscribe` / `relay_webhook_unsubscribe` and the public `relay_whoami`, gated by the scopes a token carries (`TOOL_SCOPES` in `src/server.ts`).
- `apps/web` — Next.js app: event feed, projects, usage meters, workers, asset library with review (`/assets`), the token page (`/tokens`), the OAuth 2.1 authorization server (`/.well-known/oauth-authorization-server`, `/oauth/register|authorize|token|device|revoke`, the consent page, `/activate` for device codes; `lib/oauth.ts` wires `@relay/core`'s server to the site), the GitHub App setup (`/setup/github` with the one-click manifest flow; `lib/github-app.ts` resolves the app from the environment or the sealed settings), info and docs pages, webhook ingest (GitHub org or App deliveries, Vercel), the public read API, the asset API, tasks, external events, tokens, invites, access approvals (`/api/v1/access`), `whoami`, outbound webhooks and project uploads under `/api/v1`, the MCP server at `/mcp`, the retention cron, and the agent-readiness files (`/.well-known/*`, `/openapi.json`, `/llms.txt`). Outbound webhooks fan out from `lib/dispatch.ts` with `after()` wherever a feed row is written. Data goes through `apps/web/lib/data.ts`: `RELAY_DATA=db` or any `DATABASE_URL` selects `lib/data-db.ts` over `@relay/core` (PGlite when `DATABASE_URL` is unset, one handle per instance in `lib/db.ts`); otherwise `lib/data-mock.ts` serves `lib/mock.ts`. Bearer tokens are checked in `lib/auth.ts` (`tokens` table with expiry, then `RELAY_API_TOKENS`, then `RELAY_MEMORY_TOKEN`); every 401 names the authorization server through `resource_metadata`. `DESIGN.md` there holds the UX brief and tokens.
- `skills/relay/SKILL.md` — the agent skill for installing relay, served at `/.well-known/agent-skills/index.json`.
- `.github/workflows` — reusable runner workflows that repos call with a thin caller.
- `docs/` — `ARCHITECTURE.md` is the source of truth for design; `AGENT-READINESS.md` is the contract for the hosted site; `VERSIONING.md` is the API deprecation policy; `INTEGRATIONS.md` is the connect-in-one-step guide (OAuth with consent, device flow, invite codes, the GitHub App, tools, webhook contract, Grok Bot walkthrough); `SECURITY.md` ("Access for agents") has token lifetimes, rotation and revocation; `HOSTING.md` has the GitHub App setup; `research/` holds dated surveys.

## Commands

```bash
pnpm install          # Node 24+ required (.node-version); bin/relay finds one itself
pnpm -r typecheck
pnpm -r test          # vitest; DB tests run on PGlite, no server needed
pnpm relay --help
pnpm relay setup      # plan hooks + MCP server for the CLIs on this machine; --yes writes
pnpm relay link       # in a repo (bin/relay link from elsewhere): digests, summary, relay.md, owned sections, workflows, labels; idempotent
pnpm relay brief 42   # the memory envelope a lane would get for issue 42
pnpm --filter @kyleroche/relay build              # the npm package: packages/cli/dist (relay.js, relay-mcp.js, hooks/, migrations/)
scripts/check-package.sh                          # build, pack, install the tarball into an empty directory, run relay and relay-mcp from there (CI runs it)
pnpm --filter @relay/web dev                      # mock data
RELAY_DATA=db pnpm --filter @relay/web dev        # the CLI's PGlite file (stop the CLI first; PGlite is single-process)
pnpm --filter @relay/web build && pnpm --filter @relay/web typecheck
pnpm relay token create --name ci --scopes feed:read,assets:write   # bearer token for /api/v1 and /mcp, shown once
pnpm relay setup --site https://relay.kyro.house                    # site mode via the device flow: approve the printed code at /activate; --invite <code> or --token <t> instead; --no-site reverts
pnpm relay invite create --for woodhouse --scopes tasks:read,tasks:write,events:write --expires 24h --uses 1   # one-time code; redeemed with --invite or grant urn:relay:invite
pnpm relay task create --title "Add dark mode" --lane codex --priority high   # open a task (GitHub issue + label); relay task get <owner/repo#n>, relay task ls --state review
pnpm relay webhook add --url https://bot.example/relay --events pr.merged,run.failed --bearer <key>   # outbound webhook; secret shown once; relay webhook test <id>
RELAY_PUBLIC_URL=https://relay.kyro.house pnpm --filter @relay/web check:agentic   # is-agentic score gate, after deploy
```

Memory commands (`docs/MEMORY.md`): `relay brief`, `relay recall`, `relay decide`, `relay prefer`, `relay capture`, `relay memory history`. `relay setup` records the hooks and the MCP server as absolute paths: the installed package's `dist/` files when it ran from `npx @kyleroche/relay`, the checkout's `packages/cli/hooks` scripts (which call the CLI through the repo's own `tsx`) when it ran from a clone, so a clone must stay where `relay setup` ran (re-run it after moving).

## Conventions

- TypeScript strict, ESM, `.ts` imports with extensions. No default exports except Next.js pages/routes.
- Plain SQL migrations in `packages/core/src/db/migrations/NNN_*.sql`; never edit a shipped migration.
- Every model call goes through a lane adapter and writes a `step.usage` event. Nothing calls a model directly.
- Official vendor sources only for model guidance (`onboard/registry.ts` allowlists domains). Do not add community prompt guides.
- Secrets live in environment variables, never in files or examples. `.env.example` lists names only.
- Keep `AGENTS.md`, `llms.txt`, and `README.md` accurate when you change commands or layout; CI checks that README commands exist.
- Commit messages: imperative, one topic each. Do not commit generated output, databases, or anything under `.harness/`.

## Installing relay for a user (agent instructions)

If a user asks you to set up relay, do these steps and stop at anything that needs their browser:

relay is on npm as `@kyleroche/relay`; `npx @kyleroche/relay <command>` runs it with no checkout. It needs Node 24 or newer: check `node -v` first and have the user install 24 (their version manager, or `brew install node@24`) if it is older.

1. `npx @kyleroche/relay doctor` — reports which CLIs are installed and logged in (`claude`, `codex` or `fx`, `grok`, `gh`), Node version, and database reachability; the first run creates relay's embedded database under `~/.harness`. Tell the user what is missing; logins are theirs to do.
2. `npx @kyleroche/relay setup` — prints every file it would touch in `~/.claude`, `~/.codex`, `~/.grok` (hooks and the memory MCP server) and writes nothing; run `npx @kyleroche/relay setup --yes` only if the user said so. The hooks record the installed package's own files and the Node that ran `setup`.
3. In each repo they want managed: `cd <repo> && npx @kyleroche/relay link`. This is the only per-repo step and runs the whole pipeline: registers the project and hashes its files, digests the changed files and writes the project summary (Sonnet lane, needs the `claude` login; `--no-digest` skips it, `--max-files` caps it at 400 by default), writes `relay.md` from that summary, adds the owned section to `AGENTS.md`/`CLAUDE.md`, the GitHub labels (`gh`), and the caller workflows. It prints every stage and ends with one cost line. Re-running is safe and makes no model calls unless files changed; `--refresh` rewrites the summary. Do not run `relay project digest` or `relay project summarize` by hand.
4. Optional, for runners: follow `docs/RUNNERS.md` to register a self-hosted GitHub Actions runner on a machine that holds the logins.
5. Optional, for a model the user will prompt (image/video models): `npx @kyleroche/relay onboard <provider/model>`.
6. To make this machine use a hosted relay instead of its own database: `npx @kyleroche/relay setup --site https://relay.kyro.house` (`pnpm relay setup --site <url>` from a checkout). It prints a code and `<site>/activate`; show both to the user, who approves once in the browser; the token is stored and renews itself. `--invite <code>` (from the operator's `relay invite create`) needs no browser. Never ask the user to paste a token: the device flow or an invite is the way in, and `/tokens` is only a fallback.

If you are an agent that wants to call the hosted site yourself, request access the same way, without a human handing you a token: `POST <site>/oauth/device` (`client_name`, `scope`), show the user the `user_code` to approve at `<site>/activate`, poll `POST <site>/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, then call `/mcp` or `/api/v1` with the bearer; `docs/INTEGRATIONS.md` has the sequence and the invite and consent alternatives.

From a checkout instead (contributors, or a machine that should track `main`): `git clone <repo> && cd relay && pnpm install`, then `pnpm relay doctor`, `pnpm relay setup` (through `pnpm`, so the hooks record the pinned Node 24) and `<relay checkout>/bin/relay link` in each repo. Everything else is the same.

Never move or copy a login, token, or `auth.json` between machines. Never run with permission checks disabled on a machine that holds the user's logins.
