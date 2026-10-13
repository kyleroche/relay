# AGENTS.md — relay

relay is an open-source harness that lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: GitHub issues are the task bus, self-hosted runners on the user's own machines execute steps with the vendor CLIs under the machine's own login, a Postgres database holds shared memory and an append-only event feed, and a small web app shows it all. Credentials never leave the machine they were created on.

## Layout

- `packages/core` — TypeScript library: `db/` (Postgres schema + migrations + typed queries; PGlite locally, Neon in production), `brief/` (the brief compiler and `relay.md` renderer), `memory/` (transcript capture: parse, gate, extract decisions with the Sonnet lane), `onboard/` (official-vendor-docs ingestion gate), `lanes/` (headless adapters for `claude -p`, `fx`, `codex exec`, `grok -p`), `ledger/` (step.usage writer and price table), `assets/` (Blob or local store, versions, review), `rules/` (owned-section installer for `AGENTS.md`/`CLAUDE.md`), `hooks/` (per-CLI hook installers and the brief cache), `state/` (project registration and file digests).
- `packages/cli` — the `relay` command. `src/commands/` holds one file per command group (`setup`, `link`, `brief`, `recall`, `decide`, `prefer`, `capture`, `memory`, `assets`, `token`), `hooks/*.mjs` are the dependency-free scripts the CLIs' hooks point at, `templates/` the caller workflows `relay link` installs. `relay onboard <model>` ingests vendor guidance; `relay feed`, `relay usage`, `relay doctor`; `relay token create` mints scoped bearer tokens for the web app (hash stored, shown once).
- `packages/mcp` — the relay MCP server `@relay/mcp`: `bin/relay-mcp.mjs` (stdio for the CLIs), `createMcpHandler` (Streamable HTTP for the web app), one tool set for both: public read tools (`relay_get_*`), memory tools (`relay_recall`, `relay_brief`, `relay_guidance`, `relay_feed`, `relay_project`, `relay_decide`, `relay_prefer`) and asset tools (`relay_asset_*`), gated by the scopes a token carries (`TOOL_SCOPES` in `src/server.ts`).
- `apps/web` — Next.js app: event feed, projects, usage meters, workers, asset library with review (`/assets`), info and docs pages, webhook ingest (GitHub, Vercel), the public read API and the asset API under `/api/v1`, the MCP server at `/mcp`, the retention cron, and the agent-readiness files (`/.well-known/*`, `/openapi.json`, `/llms.txt`). Data goes through `apps/web/lib/data.ts`: `RELAY_DATA=db` or any `DATABASE_URL` selects `lib/data-db.ts` over `@relay/core` (PGlite when `DATABASE_URL` is unset, one handle per instance in `lib/db.ts`); otherwise `lib/data-mock.ts` serves `lib/mock.ts`. Bearer tokens are checked in `lib/auth.ts` (`tokens` table, then `RELAY_API_TOKENS`, then `RELAY_MEMORY_TOKEN`). `DESIGN.md` there holds the UX brief and tokens.
- `skills/relay/SKILL.md` — the agent skill for installing relay, served at `/.well-known/agent-skills/index.json`.
- `.github/workflows` — reusable runner workflows that repos call with a thin caller.
- `docs/` — `ARCHITECTURE.md` is the source of truth for design; `AGENT-READINESS.md` is the contract for the hosted site; `VERSIONING.md` is the API deprecation policy; `research/` holds dated surveys.

## Commands

```bash
pnpm install          # Node 24 is pinned via .npmrc
pnpm -r typecheck
pnpm -r test          # vitest; DB tests run on PGlite, no server needed
pnpm relay --help
pnpm relay setup      # plan hooks + MCP server for the CLIs on this machine; --yes writes
pnpm relay link       # in a repo: relay.md, owned sections, caller workflows, labels
pnpm relay brief 42   # the memory envelope a lane would get for issue 42
pnpm --filter @relay/web dev                      # mock data
RELAY_DATA=db pnpm --filter @relay/web dev        # the CLI's PGlite file (stop the CLI first; PGlite is single-process)
pnpm --filter @relay/web build && pnpm --filter @relay/web typecheck
pnpm relay token create --name ci --scopes feed:read,assets:write   # bearer token for /api/v1 and /mcp, shown once
RELAY_PUBLIC_URL=https://harness.kyro.house pnpm --filter @relay/web check:agentic   # is-agentic score gate, after deploy
```

Memory commands (`docs/MEMORY.md`): `relay brief`, `relay recall`, `relay decide`, `relay prefer`, `relay capture`, `relay memory history`. Hooks call the CLI through the repo's own `tsx`, so the checkout must stay where `relay setup` ran (re-run it after moving).

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

1. `git clone <repo> && cd relay && pnpm install`
2. `pnpm relay doctor` — reports which CLIs are installed and logged in (`claude`, `codex` or `fx`, `grok`, `gh`), Node version, and database reachability. Tell the user what is missing; logins are theirs to do.
3. `pnpm relay setup` — prints every file it would touch in `~/.claude`, `~/.codex`, `~/.grok` (hooks and the memory MCP server) and writes nothing; run `pnpm relay setup --yes` only if the user said so. Run it through `pnpm` so the hooks record the pinned Node 24.
4. In each repo they want managed: `pnpm --dir <relay checkout> relay link` — registers the project, writes `relay.md`, adds the owned section to `AGENTS.md`/`CLAUDE.md`, the GitHub labels (`gh`), and the caller workflows.
5. Optional, for runners: follow `docs/RUNNERS.md` to register a self-hosted GitHub Actions runner on a machine that holds the logins.
6. Optional, for a model the user will prompt (image/video models): `pnpm relay onboard <provider/model>`.

Never move or copy a login, token, or `auth.json` between machines. Never run with permission checks disabled on a machine that holds the user's logins.
