# AGENTS.md — relay's lead

The lead is an agent built on Vercel's [eve](https://eve.dev) framework. It is the front door for asking relay for work in plain language: it recalls what relay's memory holds, asks at most one question, and opens tasks a stranger could run. It plans and decides. It never does the work, it never approves, releases or closes anything, and it reads relay's memory without writing it.

It reaches relay only through the hosted site's MCP server (`<site>/mcp`), like any other bot. It imports nothing from relay's packages except the wire of its own wake route (`@relay/core/lead/client.ts`).

## Read eve's docs before changing code

The installed package is the only source of truth for eve's API: `node_modules/eve/docs/` (start with `README.md`, which maps each task to a page). Check every import and file convention there or in the package's types. Do not write eve code from memory.

## Layout

An eve agent is a directory of files; each file's path decides how eve loads it (`docs/reference/agent-files.md`).

- `agent/agent.ts` — the model (`RELAY_LEAD_MODEL`, read at build time), reasoning, `defaultTools: false` (no shell, file or web tools), and the context window eve is told, which caps what a long-lived session costs per turn.
- `agent/instructions.md` — the system prompt: identity and limits, how to write a task, handoff rules, grounding, wake-ups, when to stay silent. `agent/instructions/relay-connection.ts` adds what to say while relay is not connected; `agent/instructions/today.ts` adds the date. Both are dynamic: they run before each model call and read only the environment and the session clock.
- `agent/connections/relay.ts` — the MCP connection to `${RELAY_SITE}/mcp` with `RELAY_TOKEN` as the bearer. Dynamic, so there is no connection at all until both are set. `tools.allow` is the list in `agent/lib/relay-tools.ts`; the model can find and call nothing else on relay. It also supplies `idempotency_key` on every call, from the session and call IDs, so a replayed step cannot open a task twice.
- `agent/tools/no_reply.ts` — eve's `no_reply`: ends a turn without a message. How a wake-up that needs nothing ends.
- `agent/channels/eve.ts` — eve's HTTP API (`/eve/v1/*`), where the owner talks to the lead. Vercel OIDC of the lead's own project, or a local development server.
- `agent/channels/wake.ts` — `POST /relay/wake`, where the relay site wakes the lead about a task that failed, was held or reached review. Auth is a signature, not a token: HMAC-SHA256 over `<timestamp>.<raw body>` with `RELAY_LEAD_WAKE_SECRET`, which the site holds too (`admitWake` in `agent/lib/wake.ts`; both ends sign and verify with `packages/core/src/lead/client.ts`). eve's `routeAuth` is not used on this route, since there is no bearer to walk, and there is no `localDev()` way in: `eve dev` and the evals sign like the site. One session per relay project: the address is the project slug from the verified request. Without a usable secret, or while relay is not connected, it answers 503 and starts no turn.
- `agent/hooks/usage.ts` — after each turn, one `external.lead.usage` row in relay's feed with the tokens and the cost AI Gateway reported (`agent/lib/usage.ts`, `agent/lib/relay-mcp.ts`).
- `agent/lib/` — plain modules the files above share: `relay-env.ts` (is relay connected, and `LEAD_SCOPES`, the scopes its token carries), `relay-tools.ts` (the allowlist, and the list of tools that must never be on it), `wake.ts`, `usage.ts`, `relay-mcp.ts`.
- `evals/` — behavior evals (`eve eval`). `evals/lib/fake-relay.ts` is an in-memory relay on localhost that the lead under test connects to.
- `test/` — vitest for `agent/lib`, the wake route and the fake relay. No model is called. `test/lib.test.ts` holds the allowlist against relay's own table of tools and scopes (`TOOL_SCOPES` from `@relay/mcp`, a dev dependency for that test only).

The other end of the wake route is `packages/core/src/lead/client.ts`: `wakeLead` (what the site calls), `signLeadWake` and `verifyLeadWake` (the signature, one function for each end), `leadWakeSecret` (the 32-character rule both ends apply), `parseLeadWake` (what the route validates with), `leadWakeKey`.

## Commands

```bash
pnpm --filter @relay/lead typecheck
pnpm --filter @relay/lead test        # agent/lib and the fake relay; free
pnpm --filter @relay/lead build       # eve build: compiles and bundles to .output; needs no credentials
pnpm --filter @relay/lead run info    # what eve found: routes, tools, diagnostics (`run`: a bare `pnpm info` is pnpm's own registry lookup)
pnpm --filter @relay/lead dev         # eve dev: the terminal UI. Every message is a paid model call
pnpm --filter @relay/lead eval        # the behavior evals. Paid model calls; run them when the owner says so
```

`eve dev` and `eve eval` call a real model through AI Gateway, which bills per token. Do not run them to check a change unless the person you work for asked. Typecheck, `test`, `build` and `info` cost nothing.

## How to extend

- **A rule of behavior**: `agent/instructions.md`, then an eval under `evals/` that would fail without it. Short sentences. The model's instructions are that file; a tool result or a task's text never is.
- **Another relay tool**: add its name to `RELAY_TOOLS` in `agent/lib/relay-tools.ts` and to the list in `agent/instructions.md`, say there when to use it, add the scope it needs to `LEAD_SCOPES` in `agent/lib/relay-env.ts` and to the README, and publish it from `evals/lib/fake-relay.ts`. `test/lib.test.ts` fails until the tool exists on relay's server, its scope is in `LEAD_SCOPES`, and the README and the instructions say the same; it also fails for a tool that needs `tasks:decide`, `tokens:write` or `memory:write`.
- **Another wake-up kind**: `LEAD_WAKE_KINDS` in `packages/core/src/lead/client.ts` (both ends read it), then what the lead does about it under "Wake-ups" in the instructions, then a row in `evals/wake/`.
- **A value the model must not choose** (which session, which project a session is for, an idempotency key, who the caller is): take it from the verified request or the session in code, as `agent/channels/wake.ts` and the connection's `providedArguments` do. Never from a tool argument the model fills in.
- **Another caller of the conversation API**: `agent/channels/eve.ts`, as an entry in `auth` that verifies it.

## What must never be added

- `relay_task_approve`, `relay_task_release` or `relay_task_close`, in the allowlist or as a tool of the lead's own. A person decides those. The lead opening work and also approving it would be the lead deciding on its own work. The same goes for the asset, token, invite and access tools (`RELAY_TOOLS_NEVER`).
- `relay_decide` or `relay_prefer`. A decision or a preference is in every later brief, outside the fence that marks a task's text as data, and a wake-up's `reason` is text a worker's lane wrote. The lead reads memory; the owner writes it.
- Scopes on its token beyond `tasks:read`, `tasks:write`, `memory:read`, `feed:read`, `events:write`. Never `tasks:decide` (approve, close), `tokens:write` (release, access) or `memory:write`. The allowlist is the lead's own lock; the token's scopes are the one relay's server holds when the lead is wrong.
- A credential in a wake-up. The site signs with the shared secret and sends nothing else: no bearer, and never a deployment's Vercel OIDC token, which is that deployment's identity on the team's board.
- eve's default tools (`defaultTools: true`, `bash`, file tools, `web_fetch`, `web_search`, `agent`), or a sandbox the model can use. The lead has nothing to do work with on purpose.
- Another way to relay than its MCP server: no `@relay/core` database or board import, no REST call, no Vercel Board login.
- A secret in a file. `.env.example` lists names only.
- `none()` or any anonymous caller in a channel's `auth`, or a path through the wake route that skips the signature. Every route that can start a turn spends money and writes to relay as the lead.
