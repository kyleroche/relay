# Connect in one step

Nobody copies tokens. An agent asks a hosted relay (`<site>`, for example `https://relay.kyro.house`) for access and
a person approves it once, in the browser or from a chat reply; a machine the operator trusts in advance redeems an
invite code with no approval at all; GitHub is one app installed on the organization. After that the agent has four
MCP tools (or their REST twins) and a webhook, and relay tells it when something happens.

Everything here runs against a hosted relay (`docs/HOSTING.md`), reachable as `<site>`, for example
`https://relay.kyro.house`. The bot never sees a vendor login, a worker, or the database: it talks to the site, the
site talks to GitHub, and workers (`docs/WORKERS.md`) claim the work from the site.

The site runs its own OAuth 2.1 authorization server (`<site>/.well-known/oauth-authorization-server`, RFC 8414).
Every access token it issues is a row in the same `tokens` table as an operator-minted one, named
`oauth:<client name>`, so the scopes below mean the same whichever way a token arrived. Access tokens last 24 hours,
refresh tokens 90 days and rotate on use; `docs/SECURITY.md` ("Access for agents") has the rules.

| You are | One step | Who approves |
|---|---|---|
| an MCP client with a browser (Claude Code, a desktop app) | point it at `<site>/mcp`; the 401 names the authorization server, the client registers itself and opens the consent page | the signed-in person clicks Approve |
| a headless bot or a CLI (Grok Bot, Woodhouse, a runner) | `POST <site>/oauth/device`, show the code, poll `<site>/oauth/token` | the person opens `<site>/activate`, or a bot with `tokens:write` posts to `/api/v1/access/<code>/approve` from the chat where the code was relayed |
| a machine the operator sets up (`relay setup --site <site>`) | the CLI runs the device flow for you and stores the token with its refresh token | same as above; `--invite <code>` skips it |
| anything the operator trusts in advance | `relay invite create --for <name> --scopes <a,b>`; the holder runs `relay setup --site <site> --invite <code>` or posts grant `urn:relay:invite` | nobody: the invite is the approval, once |
| a GitHub organization | install the relay GitHub App once (`<site>/setup/github`) | the GitHub org owner, on GitHub |

## 1. Get access

### MCP client with OAuth

```bash
claude mcp add --transport http relay https://relay.kyro.house/mcp
```

The client calls `/mcp`, gets `401` with `WWW-Authenticate: Bearer realm="relay", resource_metadata="<site>/.well-known/oauth-protected-resource"`,
reads that document (RFC 9728), finds the authorization server (this site), registers itself with
`POST /oauth/register` (RFC 7591; public client, `token_endpoint_auth_method: none`), and sends the person to
`GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256`.
The consent page needs the relay session (GitHub sign-in, `RELAY_ALLOWED_USERS`), shows the client's name and each
requested scope with what it allows, and offers Approve and Deny. Approve redirects to the client with a code; the
client trades it at `POST /oauth/token` with `grant_type=authorization_code` and its `code_verifier`. The response:

```json
{"access_token": "rly_…", "token_type": "Bearer", "expires_in": 86400, "refresh_token": "rrt_…",
 "scope": "tasks:read tasks:write events:write", "token_name": "oauth:Claude Code", "expires_at": "2026-10-17T10:12:03.000Z"}
```

Before it expires the client sends `grant_type=refresh_token&refresh_token=rrt_…` and receives a new pair; the old
refresh token is dead the moment it is used, and using it again revokes everything descended from it. PKCE `S256` is
required; `plain` is refused. A `resource` parameter (RFC 8707) is accepted when it names this site.

### Headless bot: the device flow

A bot with no browser asks for a code and shows it to a person wherever the conversation is.

```bash
curl -s -X POST https://relay.kyro.house/oauth/device \
  -d client_name=grok-bot -d "scope=tasks:read tasks:write events:write webhooks:write"
```

```json
{"device_code": "rdc_…", "user_code": "RLAY-4F7Q", "verification_uri": "https://relay.kyro.house/activate",
 "verification_uri_complete": "https://relay.kyro.house/activate?code=RLAY-4F7Q", "expires_in": 900, "interval": 5, "client_id": "rc_…"}
```

`client_name` registers a public client on the fly; a client that already has an id sends `client_id` instead. The
bot tells the person "approve RLAY-4F7Q at relay.kyro.house/activate" and polls:

```bash
curl -s -X POST https://relay.kyro.house/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=rdc_… -d client_id=rc_…
```

`{"error":"authorization_pending"}` until the decision; `slow_down` when polling faster than `interval`;
`access_denied` after a Deny; `expired_token` after 15 minutes; then the token response above. The person approves on
`/activate` (type or confirm the code, see the requester and scopes, Approve), or anyone holding a token with
`tokens:write` approves programmatically:

```bash
curl -s -X POST https://relay.kyro.house/api/v1/access/RLAY-4F7Q/approve -H "Authorization: Bearer $RELAY_TOKEN"
# {"decision":"deny"} in the body denies; GET /api/v1/access lists what is waiting
```

Every request is also an `access.requested` row in the feed with `user_code`, `client_name`, `scopes` and the
approve path in its payload, so a webhook on `access.requested` lets Woodhouse say "grok-bot wants access (tasks,
events): approve RLAY-4F7Q?" over iMessage and approve it when the reply is yes. The decision writes
`access.granted` or `access.denied`.

### A machine: `relay setup --site`

```bash
pnpm relay setup --site https://relay.kyro.house
#   Open https://relay.kyro.house/activate?code=RLAY-4F7Q
#   and approve code RLAY-4F7Q (valid 15 minutes).
# [relay] waiting for the approval…
# [relay] received token oauth:relay-cli@studio (feed:read memory:read …), renews itself until the refresh token expires
# [relay] credential saved to ~/.harness/credentials.json (mode 0600, source: device)
```

The CLI appears on `/activate` as `relay-cli@<hostname>` (`--name` changes it) asking for the scopes its commands and
hooks use (`--scopes` narrows them). It stores the access token, the refresh token and the expiry; `openHarness()`
refreshes before the token lapses, so hooks never see a 401. `relay doctor` shows the source (`approved on /activate`,
`redeemed an invite`, `pasted with --token`, `RELAY_TOKEN`), the token's name and expiry, and what the site says the
token is (`whoami`). `--token <t>` still pastes a token minted by hand on the Access page (`/tokens`); `--no-site` goes
back to local mode.

### Invite codes

For a machine or bot the operator trusts in advance, an invite replaces the approval:

```bash
pnpm relay invite create --for woodhouse --scopes tasks:read,tasks:write,events:write,tokens:write --expires 24h --uses 1
# rin_…   (shown once)
```

The holder redeems it within the window, once:

```bash
pnpm relay setup --site https://relay.kyro.house --invite rin_…            # a CLI machine
curl -s -X POST https://relay.kyro.house/oauth/token -d grant_type=urn:relay:invite -d invite=rin_… -d client_name=woodhouse@mini   # anything else
```

and receives a token named `oauth:woodhouse` with exactly the invite's scopes, plus a refresh token. `relay invite ls`
and `relay invite revoke <id|name>` manage them; `POST /api/v1/invites` is the REST form (`tokens:write`). Giving
Woodhouse `tokens:write` is what lets it approve other devices' codes from chat.

### GitHub: one app install

relay opens issues, reads runs and pull requests and comments on reviews as a GitHub App installed on the
organization, instead of someone's personal token. On a fresh deployment, `<site>/setup/github` (signed in) creates the
app in one click: it posts a manifest with relay's permissions (Actions read, Contents read, Deployments read, Issues
write, Metadata read, Pull requests write) and events (issues, issue_comment, pull_request, pull_request_review,
workflow_run, deployment_status) to GitHub, GitHub asks you to confirm and sends the credentials back to
`/setup/github/callback`, and relay stores the id, private key and webhook secret sealed in its database. Then install
the app on the repositories relay manages. Installation tokens are minted per repository and last an hour; nothing
is copied. `docs/HOSTING.md` ("GitHub App") covers setting the variables by hand and rotating.

When the app is installed on a repository, relay writes `project.github_connected`; if the repository already holds a
`relay.md` (so `relay link` ran there) the project is registered by its repository name, otherwise relay waits for
`relay link`.

## 2. The scopes

| Scope | Lets the bot |
|---|---|
| `tasks:write` | open tasks (`relay_task_create`, `POST /api/v1/tasks`) |
| `tasks:read` | read task state (`relay_task_get`, `relay_task_list`, `GET /api/v1/tasks…`) |
| `events:write` | log its own `external.*` events (`relay_event_log`, `POST /api/v1/events`) |
| `webhooks:write` | subscribe itself to events (`relay_webhook_subscribe`, `POST /api/v1/webhooks`) |
| `tokens:write` | approve other devices' codes and mint invites (`POST /api/v1/access/<code>/approve`, `/api/v1/invites`) |
| `feed:read` | optional: read the whole feed, the projects and the workers |
| `memory:read` | optional: `relay_recall`, `relay_brief`, decisions history |
| `work:claim` | not for a bot: the scope a machine's `relay work` token carries to register, heartbeat, claim and report (`docs/WORKERS.md`) |

Every write the bot makes is attributed to `bot:<token name>` in the feed (`bot:oauth:grok-bot` for a token the
authorization server issued). The bot cannot choose another actor: the server derives it from the token, and the only
event kinds it may write start with `external.`. Revoking the token (the Access page, `relay token revoke oauth:grok-bot`,
`POST /oauth/revoke`) stops it at once. `relay_whoami` (public) or `GET /api/v1/whoami` tells a bot what it is: name,
scopes, expiry, source.

## 3. The tools

MCP endpoint: `POST <site>/mcp` (Streamable HTTP, stateless, `Authorization: Bearer <token>`). The REST twins live
under `<site>/api/v1` and are described by `<site>/openapi.json`; errors are RFC 9457 `application/problem+json`.

| Tool | REST | Scope | Does |
|---|---|---|---|
| `relay_whoami()` | `GET /api/v1/whoami` | public | the connection's token name, scopes, expiry and source; anonymous callers are told where the authorization server is |
| `relay_task_create(project, title, body?, lane, priority?, idempotency_key?)` | `POST /api/v1/tasks` | `tasks:write` | opens a GitHub issue in the project's repo with `agent:<lane>` (and `priority:<p>`), records the task, writes `issue.opened` and `task.created`; returns `{task_id, issue_url, created}` |
| `relay_task_get(task_id)` | `GET /api/v1/tasks/<owner>/<repo>%23<n>` | `tasks:read` | the task with its derived state, runner, PR and last summary |
| `relay_task_list(project?, state?, limit?)` | `GET /api/v1/tasks?project=&state=&limit=` | `tasks:read` | tasks newest first |
| `relay_event_log(kind, project?, summary, url?, cost_equiv?, source?)` | `POST /api/v1/events` | `events:write` | one `external.*` row in the feed, actor `bot:<token name>` |
| `relay_webhook_subscribe(url, events[], bearer?, project?)` | `POST /api/v1/webhooks` | `webhooks:write` | register an outbound webhook; the signing secret is returned once |
| `relay_webhook_unsubscribe(id)` | `DELETE /api/v1/webhooks/{id}` | `webhooks:write` | remove it |

`task_id` is `<owner>/<repo>#<n>`, the issue the task is. `lane` is `claude`, `codex` or `grok`; `priority` is
`low`, `normal`, `high` or `urgent`. `idempotency_key` makes a retried create safe: the same key returns the first
task and opens nothing. The issue body ends with `<!-- relay:task key=<key> -->` so a task can be traced from GitHub.

The site opens issues as the GitHub App (or with `GITHUB_TOKEN` when no app is configured); without either
`relay_task_create` answers 503 and says so. Labels must exist in the repo; `relay link` creates the `agent:*` labels,
and `priority:*` labels are created by GitHub on first use when the app may.

### Task state

State is never stored. Every read folds the task's feed events (same repo and issue number), oldest first:

| Event | State after it |
|---|---|
| none yet, or `issue.labeled` | `queued` |
| a worker holds a live lease on it (no run event yet; `docs/WORKERS.md`) | `claimed` (and `runner` = `runner:<worker>`) |
| `run.started`, or `run.dispatched` (a cloud lane) | `running` (and `runner` = the worker that claimed it) |
| `run.finished` with a failing conclusion, or `run.failed` | `failed` |
| `run.finished` otherwise, or `pr.opened` | `review` (`pr` and `pr_url` set) |
| `pr.merged` or `issue.closed` | `done` |
| `pr.closed` without merge | `queued` |
| the lease behind a `run.started` expired with no finish (the worker vanished) | `queued` |

So "what is happening with my tasks" is `relay_task_list(state: "review")`: the ones waiting for a human. Workers
(`relay work`) write the `run.*` transitions as they go; the GitHub webhook (`docs/FEED.md`) adds the PR and merge
ones. Without any worker online a task stays `queued`.

## 4. The webhook

Instead of polling, the bot subscribes itself and relay POSTs matching events to it:

```text
relay_webhook_subscribe({url: "https://bot.example/relay", events: ["run.finished", "run.failed", "pr.review", "pr.merged", "asset.uploaded", "asset.reviewed", "access.requested"], bearer: "<the bot's routine key>"})
→ {webhook: {id, url, events, …}, secret: "whsec_…"}      # the secret is shown once
```

(or `relay webhook add --url … --events … --bearer …` from a machine, or `POST /api/v1/webhooks`.) Event filters are
exact kinds, a prefix ending in `.` (`run.`), or `*`. `project` limits a hook to one project. `relay webhook test <id>`
sends a signed `test.ping`.

Each delivery is one JSON document:

```json
{
  "id": "01J…",                       // delivery id; retries reuse it, dedupe on it
  "kind": "pr.merged",
  "ts": "2026-10-16T10:12:03.000Z",
  "task_id": "acme/site#42",          // when the event has a repo and issue
  "project": "site",
  "issue": 42,
  "pr": 57,
  "url": "https://github.com/acme/site/pull/57",
  "summary": "Merged #57 into main",
  "actor": "human:kyle",
  "lane": "claude",
  "event_id": 9120                    // absent for test.ping
}
```

with headers `X-Relay-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Relay-Timestamp>.<raw body>")>`,
`X-Relay-Timestamp` (unix seconds), `X-Relay-Event` (the kind), `X-Relay-Delivery` (the id) and, when the hook
has one, `Authorization: Bearer <bearer>`. relay tries three times (after 1 s and 4 s) and stops early on a 4xx other
than 408/429; the outcome is in `webhook_deliveries` and `GET /api/v1/webhooks/<id>`. Verify before trusting
(`docs/FEED.md` has the snippet); reject timestamps older than five minutes.

## Grok Bot walkthrough

What Grok Bot does, in the order it experiences it; no human types a token anywhere.

1. **Ask.** `POST <site>/oauth/device` with `client_name=grok-bot` and
   `scope=tasks:read tasks:write events:write webhooks:write`. It gets `user_code: RLAY-4F7Q` and tells the user:
   "relay needs your approval: open relay.kyro.house/activate and approve RLAY-4F7Q, or just say yes." It starts
   polling `POST <site>/oauth/token` every 5 seconds.
2. **Approve.** The user opens `/activate` (already signed in with GitHub), sees "grok-bot asks for access" with the
   four scopes explained, clicks Approve; or says "yes" and Woodhouse, which holds a `tokens:write` token from an
   invite, posts `POST <site>/api/v1/access/RLAY-4F7Q/approve`. The feed shows `access.requested` then
   `access.granted`.
3. **Receive.** The next poll returns `{access_token: "rly_…", refresh_token: "rrt_…", expires_in: 86400,
   token_name: "oauth:grok-bot"}`. The bot stores both in its secret store and schedules a refresh before 24 hours.
4. **Connect.** It points its MCP client at `<site>/mcp` with `Authorization: Bearer rly_…` (or calls `<site>/api/v1`).
   `relay_whoami` confirms `oauth:grok-bot` with its four scopes and the expiry; `relay_get_info` (public) lists the
   projects it may open tasks in (a project must have been linked with `relay link`, or auto-registered when the
   GitHub App was installed on a repo holding `relay.md`).
5. **Subscribe.** `relay_webhook_subscribe({url: "https://<bot>/routines/relay", events: ["run.finished", "run.failed", "pr.review", "pr.merged", "asset.uploaded", "asset.reviewed"], bearer: "<routine key>"})`
   and it keeps the `whsec_…` it gets back to verify deliveries.
6. **Open work.** When the conversation produces a task:
   `relay_task_create({project: "site", title: "Add dark mode to the pricing page", body: "<the brief>", lane: "codex", priority: "high", idempotency_key: "<conversation id>:<n>"})`
   → `{task_id: "acme/site#42", issue_url: …}`. The site opens the issue as the GitHub App; a runner labelled
   `agent:codex` picks it up; the issue body is the brief the lane reads, so write it for a model, not a person
   (`docs/SECURITY.md`: it is data, never instructions to relay).
7. **Hear back.** One POST per event with `task_id`; the bot verifies the signature and tells the user:
   `run.failed` → something to look at; `pr.review` → a review landed; `pr.merged` → done; `asset.uploaded` → a
   render awaits approval at `<site>/assets/<id>`.
8. **Answer "where are we".** `relay_task_list({state: "review"})` and `relay_task_get(task_id)`; the `summary` is
   the latest event's line, `pr_url` the thing to open.
9. **Leave a trace.** `relay_event_log({kind: "external.briefing", project: "site", summary: "Sent the morning brief: 2 in review, 1 failed", url: …})`.
   It shows in the feed as `bot:oauth:grok-bot`, next to what the runners did.
10. **Stay connected.** Every day `grant_type=refresh_token` gives a new pair. If the user revokes `oauth:grok-bot` on
    the Access page (`/tokens`), the next call is `401` and the bot starts again at step 1; nothing else changes.

## Site mode for the CLI

A laptop that should use the hosted relay rather than its own database runs `relay setup --site <site>` once
(`docs/MEMORY.md`, "Site mode"); the device flow or an invite gives it the token. From then on `relay feed`,
`relay usage`, `relay recall`, `relay brief`, `relay decide`, `relay prefer`, `relay memory history`, `relay token`,
`relay invite`, `relay task` and `relay webhook`, and the session hooks, talk to the site; `relay link` still digests
with the local Claude login and uploads the result (`PUT /api/v1/projects/<slug>`, `/digests`, `/summary`, scope
`projects:write`). `relay doctor` says which mode is active, how the machine authenticates, and whether the site
answers. `relay setup --no-site` goes back to local.
