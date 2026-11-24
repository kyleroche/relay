# relay's lead

The lead is the front door for asking relay for work in plain language. You say what you want. It reads what relay's memory holds about the project, asks at most one question when the answer would change the task, and opens one or more tasks a stranger could run: a title, what to do, what is out of scope, and the command or observation that proves it is done. Work that needs breaking down becomes a plan task, so a worker that has read the repository proposes the pieces. The lane and the model come from your standing preferences in relay's memory.

It plans and decides and never does the work. It cannot approve, release or close a task, claim one, edit a repository, or write to relay's memory. Two things hold that, and the second does not depend on the lead: its own list of tools has none of those (`agent/lib/relay-tools.ts`), and relay's server refuses them to its token, which carries no scope that settles a task, releases one or writes memory ("Its token" below).

It is an agent built on Vercel's [eve](https://eve.dev) framework, deployed as its own Vercel project. It reaches relay the way any bot does, through the site's MCP server at `<site>/mcp` with a scoped token (`docs/INTEGRATIONS.md`). On relay's board and in its feed, what it does shows under its token's name.

## The one part of relay that is not a subscription

Everything else relay runs uses the coding-agent subscriptions you already pay for, on your own machines. The lead's model calls are different: they go through Vercel AI Gateway and are **billed per token** to the Vercel team that owns the lead's project.

- Every message to the lead and every wake-up from the site is at least one paid model call.
- After each turn the lead writes one `external.lead.usage` row to relay's feed with the tokens it used and the cost AI Gateway reported. When the gateway reports no cost the row says so; nothing is estimated.
- `agent/agent.ts` tells eve a context window of 100,000 tokens, so a session that has run for months still sends at most about that much per turn.
- eve stops a session from starting model calls after 40,000,000 new input tokens (its default `limits.sessionUsage`). A wake session that reaches it waits for a person who is not there: wake-ups for that project then queue until the session is ended. A budget on the project in AI Gateway is the limit to rely on.
- `pnpm --filter @relay/lead dev` and `pnpm --filter @relay/lead eval` spend money too. Typecheck, `test`, `build` and `info` do not.

## Environment

Names only; `.env.example` lists them. Values live in the Vercel project's environment (or `.env.local` for `eve dev`).

| Variable | Needed | What it is |
|---|---|---|
| `RELAY_SITE` | yes | The hosted relay's URL, such as `https://relay.example.com`. The lead connects to `<RELAY_SITE>/mcp`. |
| `RELAY_TOKEN` | yes | The lead's bearer token for the site. See "Its token" below. |
| `RELAY_LEAD_MODEL` | no | A Vercel AI Gateway model id. Default `openai/gpt-6-luna-fast`, which is eve's own default. Read when the app is built, so a new value takes a new deployment. |
| `RELAY_LEAD_WAKE_SECRET` | for wake-ups | A secret shared with the relay site, which signs each wake-up with it. At least 32 characters; `openssl rand -hex 32` makes one. Set the same value on the site's project. Without it, or with a shorter one, the wake route answers `503` to everyone. |

No model provider key is needed on Vercel: a deployment reaches AI Gateway with its own project's OIDC token.

Until `RELAY_SITE` and `RELAY_TOKEN` are both set, the lead has no relay connection. Its instructions then tell it to say so and to tell whoever asks what the operator must do. It does not pretend to open tasks. The wake route answers `503` without starting a turn, so an unconnected lead costs nothing to wake.

`RELAY_LEAD_WAKE_SECRET` is used for one thing: it proves to the lead that a wake-up came from the site. It is not a relay token and opens nothing on relay, on the board or on Vercel. To change it, set the new value on both projects and redeploy both; wake-ups sent in between are refused and dropped, and the tasks they were about stay on the board.

## Its token

The token needs these scopes and no others:

```
tasks:read,tasks:write,memory:read,feed:read,events:write
```

One for each tool on its list: `tasks:read` reads tasks, `tasks:write` opens one, sends one in review back with a note and requeues one, `memory:read` reads decisions, preferences, briefs and a project's record, `feed:read` reads a project with its recent events, `events:write` logs its own `external.lead.*` rows.

Mint it one of two ways, then set it as `RELAY_TOKEN`:

- On the site's Access page (`<site>/access`), "Mint a token by hand", name `lead`.
- On a machine set up for the site (`relay setup --site <site>`):
  ```bash
  relay token create --name lead --scopes tasks:read,tasks:write,memory:read,feed:read,events:write
  ```

Both give an operator token, which lasts until it is revoked. `relay invite create --for lead --scopes …` is not the way for this app: redeeming an invite yields an access token that lasts 24 hours plus a refresh token that rotates on every use (`docs/SECURITY.md`, "Access for agents"), and the lead keeps its token in an environment variable, with nowhere to store a rotated one.

Never give the token any of these three:

- `tasks:decide` approves a task (which merges its pull request) and closes one. Those are a person's decisions.
- `tokens:write` releases a task the injection gate held, approves other agents' access and mints invites.
- `memory:write` records decisions and preferences. What they say is in every later brief, and a wake-up carries text a worker's lane wrote, so the lead reads memory and never writes it.

relay's server checks the scope on every call, so a lead that was talked into trying one of these is refused there, whatever its own tool list says. A lead token minted before `tasks:decide` existed needs no change for that: `tasks:write` no longer approves or closes. Mint a new one without `memory:write` if the old one carried it, and revoke the old one. Revoke the token on the Access page to stop the lead at once.

## Deploy

The lead is its own Vercel project on the same team as the relay site.

1. Create a project from this repository with **Root Directory** `apps/lead`, no framework preset, build command `pnpm build` (which runs `eve build`), and Node 24 or newer. On Vercel, `eve build` writes the deployment under `.vercel/output`.
2. Set the environment variables above for Production.
3. Deploy. Check it answers: `curl https://<lead>/eve/v1/health`.
4. Tell the site where the lead is: set `RELAY_LEAD_URL` on the site's project to the lead's origin, set `RELAY_LEAD_WAKE_SECRET` there to the same value as on the lead, and redeploy it. The site then wakes the lead from its `lead` board watcher (`apps/web/lib/lead.ts`) with `wakeLead({ url, secret, project, task, event })` from `@relay/core`. With the URL set and no usable secret the site sends nothing and says why once in its log. A site the board does not wake (local dev, a board at `BOARD_URL`) wakes no lead.

**Deployment Protection.** The site's wake-up carries a signature and no Vercel credential, so Vercel's own protection does not let it through. If `RELAY_LEAD_URL` is an address that Deployment Protection covers (Vercel Authentication or Password Protection set to cover production, or a deployment-specific URL), Vercel answers the wake-up with its own `401` before the lead sees it, and the site logs "not delivered (401)". relay does not send a bypass and does not fall back to the site's Vercel token. Point `RELAY_LEAD_URL` at an address of the lead that protection leaves open: normally its production domain under Standard Protection, or a domain listed under Deployment Protection Exceptions. Every route of the lead that can start a turn checks its caller itself: the wake route by the signature, `/eve/v1/*` by a Vercel OIDC token of the lead's own project.

`eve link` and `eve deploy` from `apps/lead` do the same from the CLI (`node_modules/eve/docs/guides/deployment/vercel.mdx`). This app depends on the workspace package `@relay/core`, so the deployment must be built from the repository, not from a copy of this directory alone.

## Talking to it

- From a machine linked to the lead's Vercel project: `pnpm exec eve remote connect --url https://<lead>`. The conversation API (`/eve/v1/*`) takes Vercel OIDC tokens of the lead's own project.
- Locally: `pnpm --filter @relay/lead dev` with `RELAY_SITE` and `RELAY_TOKEN` in `apps/lead/.env.local`. To wake a local lead, put `RELAY_LEAD_WAKE_SECRET` there as well: the wake route has no development bypass.
- To let another agent or deployment talk to it, add an authenticator for that caller in `agent/channels/eve.ts`. There is no anonymous access.

## Wake-ups

The site posts to `POST /relay/wake` when a task failed, was held by the injection gate, or reached review. The request and its validation are in `packages/core/src/lead/client.ts`:

```http
POST /relay/wake
content-type: application/json
accept: application/json
x-relay-wake-timestamp: <Unix seconds when the site signed it>
x-relay-wake-signature: sha256=<hex of HMAC-SHA256(RELAY_LEAD_WAKE_SECRET, "<timestamp>.<raw body>")>

{"project":"site","task":{"id":"<board ID>","title":"…","lane":"codex"},"event":{"kind":"failed","cursor":"<board cursor>","reason":"…"},"idempotencyKey":"relay-wake:<board cursor>"}
```

There is no `authorization` header and no Vercel OIDC token. The site's Vercel identity is its credential on the team's board, so it is never sent to the lead. The lead recomputes the signature over the timestamp and the body exactly as it arrived, compares in constant time, and refuses a timestamp more than 5 minutes from its own clock. Then it validates the body.

`event.kind` is `failed`, `held` or `review`. The lead answers `202` with the session and delivery IDs once the message is in the project's session; a redelivered event with the same key starts no second turn, and that covers a signed request replayed inside the 5 minutes too. Its other answers: `503` with `wake_not_configured` while the lead has no usable secret, `401` with `wake_unauthorized` for a missing, wrong or stale signature, `503` with `relay_not_connected`, `413` over 16 KiB, `400` with `invalid_wake`.

There is one session per relay project, so the lead sees what it did there before. Most wake-ups end with nothing said. The lead acts in two cases: a task failed in a way that reads like the lane and not the task, in which case it requeues the task once on another lane and logs `external.lead.requeued` with the reason; or someone asked it to watch that task, which it recorded as `external.lead.watch`. It never requeues the same task twice.

## Checking it

```bash
pnpm --filter @relay/lead typecheck
pnpm --filter @relay/lead test     # the pure modules and the fake relay
pnpm --filter @relay/lead build
pnpm --filter @relay/lead eval     # behavior, against a real model: paid
```

The `eve` CLI sends usage telemetry unless `EVE_TELEMETRY_DISABLED=1` is set or `eve telemetry disable` was run on the machine (`node_modules/eve/docs/reference/telemetry.md`).

The evals under `evals/` cover the rules that matter: a clear ask becomes one task with a done-check on the lane memory names; an ambiguous one gets one question; a large one becomes a plan task; a failed recall is reported as a failure; a wake-up that needs nothing ends silently; a lane failure is requeued once and never twice; nothing outside the lead's tool list is ever called; memory is never written, whether the owner states a lasting choice or a wake-up's text asks for it. They run against an in-memory relay on localhost (`evals/lib/fake-relay.ts`), never a real site.

`AGENTS.md` has the layout, how to extend it, and what must never be added.
