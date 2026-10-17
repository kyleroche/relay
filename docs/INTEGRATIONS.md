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
| a headless bot or a CLI (Grok Bot, Woodhouse, a runner) | `POST <site>/oauth/device`, show the code, poll `<site>/oauth/token` | the person opens `<site>/activate`, or a bot with `tokens:write` approves it from the chat where the code was relayed (`relay_access_approve` over MCP, or `POST /api/v1/access/<code>/approve`), for scopes the bot holds itself |
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

`client_name` registers a public client on the fly (1 to 40 characters: letters, digits, space, `. _ @ : + -`; it
becomes the token's name `oauth:<client_name>`); a client that already has an id sends `client_id` instead. `scope` is
required: an empty request is `invalid_scope`, never every scope. The bot tells the person "approve RLAY-4F7Q at relay.kyro.house/activate" and polls:

```bash
curl -s -X POST https://relay.kyro.house/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=rdc_… -d client_id=rc_…
```

`{"error":"authorization_pending"}` until the decision; `slow_down` when polling faster than `interval`;
`access_denied` after a Deny; `expired_token` after 15 minutes; then the token response above. The person approves on
`/activate` (type or confirm the code, see the requester and scopes, Approve), or a bot holding a token with
`tokens:write` approves programmatically, over MCP or REST:

```text
relay_access_list()                                   → {pending: [{user_code: "RLAY-4F7Q", client_name: "grok-bot", scopes: [...], expires_at}], approved_awaiting_poll: []}
relay_access_approve({user_code: "RLAY-4F7Q"})        → {user_code, status: "approved", client_name, scopes, decided_by: "bot:oauth:woodhouse"}
relay_access_approve({user_code, decision: "deny"})   → {status: "denied"}
```

```bash
curl -s -X POST https://relay.kyro.house/api/v1/access/RLAY-4F7Q/approve -H "Authorization: Bearer $RELAY_TOKEN"
# {"decision":"deny"} in the body denies; GET /api/v1/access lists what is waiting
```

The ceiling: a bot can approve only scopes it holds itself, and never `tokens:write`; a request wider than that is
refused (`403`, or an MCP tool error) with "ask a person to approve this one at `<site>/activate`". Only a signed-in
person is unrestricted, so one approved bot can never grow into every token. A deny is always allowed.

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
token is (`whoami`). `--token <t>` still pastes a token minted by hand on the Access page (`/access`); `--no-site` goes
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
and `relay invite revoke <id|name>` manage them; `POST /api/v1/invites` is the REST form and
`relay_invite_create({name, scopes, expires_in?, uses?})` / `relay_invite_revoke({id_or_name})` the MCP form (all
`tokens:write`; the create answers with the code once and the `relay setup --site <site> --invite <code>` line). Giving
Woodhouse `tokens:write` is what lets it approve other devices' codes and mint invites from chat, within its own
scopes: a bot never invites to a scope it does not hold, and never to `tokens:write`. The person creates that invite
(the one above) once, on the Access page or with the CLI.

### GitHub: one app install

relay opens issues, reads runs and pull requests and comments on reviews as a GitHub App installed on the
organization, instead of someone's personal token. On a fresh deployment, `<site>/setup/github` (signed in) creates the
app in one click: it posts a manifest with relay's permissions (Actions read, Contents write (approve squash-merges the PR and deletes its branch), Deployments read, Issues
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
| `tasks:write` | open tasks (`relay_task_create`, `POST /api/v1/tasks`); approve or send back a task in review (`relay_task_approve`, `relay_task_request_changes`, `POST /api/v1/tasks/{id}/approve`, `…/request-changes`), never a PR the bot's own lane produced; requeue a task from any state but done, optionally on another lane (`relay_task_requeue`, `…/requeue`) |
| `tasks:read` | read task state (`relay_task_get`, `relay_task_list`, `GET /api/v1/tasks…`): state, PR, preview URL, run summary, usage, review decision |
| `events:write` | log its own `external.*` events (`relay_event_log`, `POST /api/v1/events`) |
| `webhooks:write` | subscribe itself to events (`relay_webhook_subscribe`, `POST /api/v1/webhooks`) |
| `tokens:write` | approve other devices' codes and mint invites (`relay_access_list`, `relay_access_approve`, `relay_invite_create`, `relay_invite_revoke`; `GET /api/v1/access`, `POST /api/v1/access/<code>/approve`, `/api/v1/invites`), for scopes the bot holds itself and never `tokens:write` |
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
| `relay_task_get(task_id)` | `GET /api/v1/tasks/<owner>/<repo>%23<n>` | `tasks:read` | the task with its derived state, runner, PR (`pr_url`), branch, `preview_url` and `preview_state` (`ready`, `building`, `failed`, `none`), the lane's `run_summary`, folded `usage`, the `review` decision, `merged_at` and the last summary |
| `relay_task_list(project?, state?, limit?)` | `GET /api/v1/tasks?project=&state=&limit=` | `tasks:read` | tasks newest first; `state: "review"` is what waits for a decision |
| `relay_task_approve(id)` | `POST /api/v1/tasks/<owner>/<repo>%23<n>/approve` | `tasks:write` | approve a task in review: relay squash-merges the PR through GitHub, deletes its branch and writes `task.approved`; the task is `done`. A bot may not approve a PR its own lane produced (the `run.started` / `pr.opened` actor carries its name); GitHub's refusal comes back as an error with `task.merge_failed` in the feed |
| `relay_task_request_changes(id, note)` | `POST /api/v1/tasks/<owner>/<repo>%23<n>/request-changes` | `tasks:write` | send it back: relay posts `relay: changes requested by <actor>:` + the note on the PR, writes `task.changes_requested`, and the task is `queued`; the next run gets the note under "Review feedback" in its brief and pushes to the same branch and PR |
| `relay_task_requeue(id, lane?, reason?)` | `POST /api/v1/tasks/<owner>/<repo>%23<n>/requeue` | `tasks:write` | put a task back in the queue from any state but `done`, optionally on another lane: relay updates the task's lane and moves the issue's `agent:*` label (best effort; a GitHub failure is in the event payload), releases a live worker claim, writes `task.requeued` and rings the doorbell; the next worker that serves the lane claims it and starts over from the base branch (an open PR is reused). For a task stuck `running` (a cloud lane nobody wired, a run that never reported) or on the wrong lane |
| `relay_event_log(kind, project?, summary, url?, cost_equiv?, source?)` | `POST /api/v1/events` | `events:write` | one `external.*` row in the feed, actor `bot:<token name>` |
| `relay_webhook_subscribe(url, events[], bearer?, project?)` | `POST /api/v1/webhooks` | `webhooks:write` | register an outbound webhook; the signing secret is returned once |
| `relay_webhook_unsubscribe(id)` | `DELETE /api/v1/webhooks/{id}` | `webhooks:write` | remove it |
| `relay_access_list()` | `GET /api/v1/access` | `tokens:write` | device requests waiting for a decision (`user_code`, `client_name`, `scopes`, `requested_at`, `expires_at`) and approvals the device has not polled yet |
| `relay_access_approve(user_code, decision?)` | `POST /api/v1/access/{user_code}/approve` | `tokens:write` | approve (default) or deny one; the device's next poll gets its token; attributed to `bot:<token name>`. Only scopes the bot holds, never `tokens:write`; otherwise "ask a person to approve this one at `<site>/activate`" |
| `relay_invite_create(name, scopes[], expires_in?, uses?)` | `POST /api/v1/invites` | `tokens:write` | mint an invite: returns the row, the code (once) and the `relay setup --site <site> --invite <code>` line; the same ceiling |
| `relay_invite_revoke(id_or_name)` | `DELETE /api/v1/invites/{id}` | `tokens:write` | stop an unredeemed invite |

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
| `run.finished` otherwise, or `pr.opened` | `review` (`pr` and `pr_url` set; `preview_url` once a `preview.ready` for the branch arrives) |
| `task.approved` (relay merged the PR), `pr.merged` or `issue.closed` | `done` (`merged_at` set) |
| `task.changes_requested` | `queued` (`review.note` holds what to change; the next run reuses the branch and PR) |
| `task.merge_failed` | unchanged: still `review`, with GitHub's reason in the row |
| `task.requeued` | `queued` (on `lane` from the row; the claim, if any, was released; the next run starts over and reuses an open PR) |
| `pr.closed` without merge | `queued` |
| the lease behind a `run.started` expired with no finish (the worker vanished) | `queued` |

So "what is happening with my tasks" is `relay_task_list(state: "review")`: the ones waiting for a decision, each with
its `pr_url` and, once Vercel built the branch, its `preview_url`. Workers (`relay work`) write the `run.*`
transitions as they go; the GitHub webhook (`docs/FEED.md`) adds the PR and merge ones; the review tools write the
`task.*` decisions. Without any worker online a task stays `queued`.

### Review

A task in `review` is decided in one of four places, all the same core call (`packages/core/src/tasks/review.ts`):
the task page at `<site>/tasks/<owner>/<repo>/<n>` (the preview link is the first thing on it, then "Approve and
merge" and "Request changes"), `relay_task_approve` / `relay_task_request_changes` over MCP, the two REST routes, and
`relay task approve <id>` / `relay task changes <id> --note "…"` from a machine. Approve squash-merges with
`<PR title> (#<pr>)` as the commit title and `relay: approved by <actor>` in the body, deletes the branch and writes
`task.approved`. Request changes puts the note on the PR and in the next run's brief; the task is queued and the worker
that claims it starts from the base branch again, replaces the same `relay/<lane>-<issue>` branch with
`--force-with-lease`, and the existing PR is reused.

Who may decide: a signed-in person always. A bot only when its token holds `tasks:write`, and never on a PR its own
lane produced: the `run.started` / `pr.opened` actor's name is compared with the bot's, so `bot:oauth:codex-bot`
cannot approve what `runner:codex-bot` pushed. The refusal names who can ("a signed-in person, or a bot whose token
holds tasks:write and that did not produce the PR itself"). The pattern for a chat bot is: relay the preview, ask the
person, and call approve only after they said yes.

### A task on the wrong lane or stuck: requeue

A task can look `running` with nothing happening: it was opened on a cloud lane (`claude-cloud`, `codex-cloud`) that
the operator has not wired, so `run.dispatched` is the last word relay will ever hear; or a worker started it and died
without reporting; or the GitHub webhook that would re-queue a relabelled issue never arrived. Relabelling on GitHub
alone fixes none of that when deliveries are not reaching the site. `requeueTask` (`packages/core/src/tasks/requeue.ts`)
does it from relay's side, from the task page ("Requeue" in the Decide card, with a lane select and an optional
reason), `relay_task_requeue({id, lane?, reason?})` over MCP, `POST /api/v1/tasks/<owner>/<repo>%23<n>/requeue` with
`{"lane"?, "reason"?}`, or `relay task requeue <id> [--lane <lane>] [--reason <text>]`.

What it does, in order: refuses a `done` task (409) and a bot without `tasks:write` (403); when `lane` differs from the
task's, updates `tasks.lane` and moves the `agent:*` label on the issue (every other `agent:*` label off,
`agent:<lane>` on), best effort: a GitHub failure or a missing credential is recorded in the event payload
(`github.error`) and the task is queued anyway, because the scheduler matches on relay's row, not the label; releases a
live claim (`outcome: released`) so a worker can claim again; writes `task.requeued` with the previous state and lane and
the reason; bumps the queue version so idle workers' doorbells ring. The task is `queued`; the next worker that serves
the lane claims it, clones fresh from the base branch, replaces `relay/<lane>-<issue>` and reuses the open PR if there
is one. Requeuing onto a cloud lane dispatches nothing until that lane is wired, so the worker lanes are the ones to
pick: `relay_task_requeue({id: "acme/site#42", lane: "claude", reason: "the cloud lane is not wired"})`.

## 4. The webhook

Instead of polling, the bot subscribes itself and relay POSTs matching events to it:

```text
relay_webhook_subscribe({url: "https://bot.example/relay", events: ["run.finished", "run.failed", "preview.ready", "task.approved", "task.changes_requested", "pr.review", "pr.merged", "asset.uploaded", "asset.reviewed", "access.requested"], bearer: "<the bot's routine key>"})
→ {webhook: {id, url, events, …}, secret: "whsec_…"}      # the secret is shown once
```

(or `relay webhook add --url … --events … --bearer …` from a machine, or `POST /api/v1/webhooks`.) The URL must be a
public `https` endpoint: loopback, link-local, private-network (RFC 1918) and `.internal`/`.local` targets are refused,
and plain `http` is accepted for `localhost` outside production only. Event filters are
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
   four scopes explained, clicks Approve; or says "yes, let grok-bot in" and Woodhouse, the chief-of-staff bot that
   holds a `tokens:write` token from an invite the person created once, calls `relay_access_list()` on `<site>/mcp`,
   finds `RLAY-4F7Q` for `grok-bot` with those four scopes, and calls `relay_access_approve({user_code: "RLAY-4F7Q"})`
   (or posts `POST <site>/api/v1/access/RLAY-4F7Q/approve`). That works because Woodhouse holds those four scopes
   itself; had grok-bot asked for `memory:write` or `tokens:write`, Woodhouse would be told to hand it to a person at
   `/activate`. The feed shows `access.requested`, then `access.granted` by `bot:oauth:woodhouse`. No one opens the
   Access page.
3. **Receive.** The next poll returns `{access_token: "rly_…", refresh_token: "rrt_…", expires_in: 86400,
   token_name: "oauth:grok-bot"}`. The bot stores both in its secret store and schedules a refresh before 24 hours.
4. **Connect.** It points its MCP client at `<site>/mcp` with `Authorization: Bearer rly_…` (or calls `<site>/api/v1`).
   `relay_whoami` confirms `oauth:grok-bot` with its four scopes and the expiry; `relay_get_info` (public) lists the
   projects it may open tasks in (a project must have been linked with `relay link`, or auto-registered when the
   GitHub App was installed on a repo holding `relay.md`).
5. **Subscribe.** `relay_webhook_subscribe({url: "https://<bot>/routines/relay", events: ["run.finished", "run.failed", "preview.ready", "task.approved", "task.changes_requested", "pr.review", "pr.merged", "asset.uploaded", "asset.reviewed"], bearer: "<routine key>"})`
   and it keeps the `whsec_…` it gets back to verify deliveries.
6. **Open work.** When the conversation produces a task:
   `relay_task_create({project: "site", title: "Add dark mode to the pricing page", body: "<the brief>", lane: "codex", priority: "high", idempotency_key: "<conversation id>:<n>"})`
   → `{task_id: "acme/site#42", issue_url: …}`. The site opens the issue as the GitHub App; a runner labelled
   `agent:codex` picks it up; the issue body is the brief the lane reads, so write it for a model, not a person
   (`docs/SECURITY.md`: it is data, never instructions to relay).
7. **Hear back.** One POST per event with `task_id`; the bot verifies the signature and tells the user:
   `run.failed` → something to look at; `run.finished` → "the PR is open: <url>"; `preview.ready` → "preview is up:
   <url>" (the delivery's `url`); `pr.review` → a review landed; `task.approved` / `pr.merged` → done;
   `task.changes_requested` → sent back, by whom and why; `asset.uploaded` → a render awaits approval at
   `<site>/assets/<id>`.
8. **Approve when the person says so.** The user looks at the preview and answers "ship it": the bot calls
   `relay_task_approve({id: "acme/site#42"})` and relay squash-merges the PR, deletes the branch and writes
   `task.approved` by `bot:oauth:grok-bot`. "Not yet, the toggle has no focus ring" becomes
   `relay_task_request_changes({id, note: "The toggle has no focus ring; match the one on /settings."})`: the note
   lands on the PR, the task is queued, and the next run addresses it on the same PR. Grok Bot can do this because it
   holds `tasks:write` and did not produce the PR; the codex lane's own bot would be refused.
9. **Answer "where are we".** `relay_task_list({state: "review"})` and `relay_task_get(task_id)`; the `summary` is
   the latest event's line, `pr_url` and `preview_url` the things to open, `run_summary` what the lane said it did.
10. **Leave a trace.** `relay_event_log({kind: "external.briefing", project: "site", summary: "Sent the morning brief: 2 in review, 1 failed", url: …})`.
   It shows in the feed as `bot:oauth:grok-bot`, next to what the runners did.
11. **Stay connected.** Every day `grant_type=refresh_token` gives a new pair. If the user revokes `oauth:grok-bot` on
    the Access page (`/access`), the next call is `401` and the bot starts again at step 1; nothing else changes.

## Site mode for the CLI

A laptop that should use the hosted relay rather than its own database runs `relay setup --site <site>` once
(`docs/MEMORY.md`, "Site mode"); the device flow or an invite gives it the token. From then on `relay feed`,
`relay usage`, `relay recall`, `relay brief`, `relay decide`, `relay prefer`, `relay memory history`, `relay token`,
`relay invite`, `relay task` and `relay webhook`, and the session hooks, talk to the site; `relay link` still digests
with the local Claude login and uploads the result (`PUT /api/v1/projects/<slug>`, `/digests`, `/summary`, scope
`projects:write`), then asks `GET /api/v1/projects/<slug>/github` (`feed:read` or `projects:write`) whether the site's
GitHub App is installed on the repo and prints the install link when it is not. `relay doctor` says which mode is active,
how the machine authenticates, whether the site answers, and which linked repos still lack the App. `relay setup --no-site` goes back to local.
