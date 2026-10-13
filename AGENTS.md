# AGENTS.md — relay

relay is an open-source harness that lets one person's coding-agent subscriptions (Claude, Codex, Grok) work as one system: GitHub issues are the task bus, self-hosted runners on the user's own machines execute steps with the vendor CLIs under the machine's own login, a Postgres database holds shared memory and an append-only event feed, and a small web app shows it all. Credentials never leave the machine they were created on.

## Layout

- `packages/core` — TypeScript library: `db/` (Postgres schema + migrations + typed queries; PGlite locally, Neon in production), `memory/` (decisions, preferences, recall), `onboard/` (official-vendor-docs ingestion gate), `lanes/` (headless adapters for `claude -p`, `fx`, `codex exec`, `grok -p`), `events/` (feed writers), `rules/` (generated `relay.md` owned-section installer), `hooks/` (per-CLI hook installers).
- `packages/cli` — the `relay` command. `relay setup` configures the CLIs on this machine; `relay link` registers a repo; `relay onboard <model>` ingests vendor guidance; `relay feed`, `relay usage`, `relay doctor`.
- `packages/mcp` — the memory MCP server (stdio for CLIs, HTTP handler for the web app).
- `apps/web` — Next.js app: event feed, projects, usage meters, workers, info and docs pages, webhook ingest (GitHub, Vercel), the public read API under `/api/v1`, the MCP server at `/mcp`, and the agent-readiness files (`/.well-known/*`, `/openapi.json`, `/llms.txt`). Data goes through `apps/web/lib/data.ts`; `RELAY_DATA=mock` (the default without `DATABASE_URL`) serves `lib/mock.ts`. `DESIGN.md` there holds the UX brief and tokens.
- `skills/relay/SKILL.md` — the agent skill for installing relay, served at `/.well-known/agent-skills/index.json`.
- `.github/workflows` — reusable runner workflows that repos call with a thin caller.
- `docs/` — `ARCHITECTURE.md` is the source of truth for design; `AGENT-READINESS.md` is the contract for the hosted site; `VERSIONING.md` is the API deprecation policy; `research/` holds dated surveys.

## Commands

```bash
pnpm install          # Node 24 is pinned via .npmrc
pnpm -r typecheck
pnpm -r test          # vitest; DB tests run on PGlite, no server needed
pnpm relay --help
pnpm --filter @relay/web dev
pnpm --filter @relay/web build && pnpm --filter @relay/web typecheck
RELAY_PUBLIC_URL=https://harness.kyro.house pnpm --filter @relay/web check:agentic   # is-agentic score gate, after deploy
```

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
3. `pnpm relay setup` — installs hooks and the memory MCP server into each detected CLI's config. It prints every file it will touch and asks before writing; use `--yes` only if the user said so.
4. In each repo they want managed: `pnpm relay link` — adds the owned section to `AGENTS.md`/`CLAUDE.md`, the GitHub labels, and the caller workflow.
5. Optional, for runners: follow `docs/RUNNERS.md` to register a self-hosted GitHub Actions runner on a machine that holds the logins.
6. Optional, for a model the user will prompt (image/video models): `pnpm relay onboard <provider/model>`.

Never move or copy a login, token, or `auth.json` between machines. Never run with permission checks disabled on a machine that holds the user's logins.
