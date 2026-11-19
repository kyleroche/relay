# Connect in one step

Nobody copies tokens. An agent asks a hosted relay (`<site>`, for example `https://relay.kyro.house`) for access and
a person approves it once, in the browser or from a chat reply; a machine the operator trusts in advance redeems an
invite code with no approval at all; GitHub is one app installed on the organization. After that the agent has the
task tools (or their REST twins): it opens tasks, asks how they stand, and decides on them when a person says so.

Everything here runs against a hosted relay (`docs/HOSTING.md`), reachable as `<site>`, for example
`https://relay.kyro.house`. The bot never sees a vendor login, a worker, or the database: it talks to the site, the
site works on the team's Vercel Board, where the tasks live and the workers claim them (`docs/ARCHITECTURE.md`, "The
site and the board"), and merges on GitHub.

The site runs its own OAuth 2.1 authorization server (`<site>/.well-known/oauth-authorization-server`, RFC 8414).
Every access token it issues is a row in the same `tokens` table as an operator-minted one, named
`oauth:<client name>`, so the scopes below mean the same whichever way a token arrived. Access tokens last 24 hours,
refresh tokens 90 days and rotate on use; `docs/SECURITY.md` ("Access for agents") has the rules.

| You are | One step | Who approves |
|---|---|---|
| an MCP client with a browser (Claude Code, a desktop app) | point it at `<site>/mcp`; the 401 names the authorization server, the client registers itself and opens the consent page | the signed-in person clicks Approve |
| a headless bot or a CLI (Grok Bot, Concierge, a runner) | `POST <site>/oauth/device`, show the code, poll `<site>/oauth/token` | the person opens `<site>/activate`, or a bot with `tokens:write` approves it from the chat where the code was relayed (`relay_access_approve` over MCP, or `POST /api/v1/access/<code>/approve`), for scopes the bot holds itself |
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
  -d client_name=grok-bot -d "scope=tasks:read tasks:write events:write"
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
relay_access_approve({user_code: "RLAY-4F7Q"})        → {user_code, status: "approved", client_name, scopes, decided_by: "bot:oauth:concierge"}
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
approve path in its payload, and `relay_access_list()` returns what is waiting, so Concierge can say "grok-bot
wants access (tasks, events): approve RLAY-4F7Q?" over iMessage and approve it when the reply is yes. The decision
writes `access.granted` or `access.denied`.

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
pnpm relay invite create --for concierge --scopes tasks:read,tasks:write,events:write,tokens:write --expires 24h --uses 1
# rin_…   (shown once)
```

The holder redeems it within the window, once:

```bash
pnpm relay setup --site https://relay.kyro.house --invite rin_…            # a CLI machine
curl -s -X POST https://relay.kyro.house/oauth/token -d grant_type=urn:relay:invite -d invite=rin_… -d client_name=concierge@laptop   # anything else
```

and receives a token named `oauth:concierge` with exactly the invite's scopes, plus a refresh token. `relay invite ls`
and `relay invite revoke <id|name>` manage them; `POST /api/v1/invites` is the REST form and
`relay_invite_create({name, scopes, expires_in?, uses?})` / `relay_invite_revoke({id_or_name})` the MCP form (all
`tokens:write`; the create answers with the code once and the `relay setup --site <site> --invite <code>` line). Giving
Concierge `tokens:write` is what lets it approve other devices' codes and mint invites from chat, within its own
scopes: a bot never invites to a scope it does not hold, and never to `tokens:write`. The person creates that invite
(the one above) once, on the Access page or with the CLI.

### GitHub: one app install

relay merges approved pull requests, comments on them, and receives a repository's issues, labels and pull requests
as a GitHub App installed on the organization, instead of someone's personal token. On a fresh deployment, `<site>/setup/github` (signed in) creates the
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
| `tasks:write` | open tasks (`relay_task_create`, `POST /api/v1/tasks`); approve or send back a task in review (`relay_task_approve`, `relay_task_request_changes`, `POST /api/v1/tasks/{id}/approve`, `…/request-changes`), never approving a task the bot opened itself; requeue a failed, held or blocked task, optionally on another lane or model (`relay_task_requeue`, `…/requeue`); close one (`relay_task_close`, `…/close`) |
| `tasks:read` | read tasks (`relay_task_get`, `relay_task_list`, `GET /api/v1/tasks…`): state, lane, model, pull request, hold and reason, claim, last result, usage, notes |
| `events:write` | log its own `external.*` events (`relay_event_log`, `POST /api/v1/events`) |
| `tokens:write` | approve other devices' codes and mint invites (`relay_access_list`, `relay_access_approve`, `relay_invite_create`, `relay_invite_revoke`; `GET /api/v1/access`, `POST /api/v1/access/<code>/approve`, `/api/v1/invites`), for scopes the bot holds itself and never `tokens:write`; release a task the injection gate held (`relay_task_release`, `POST /api/v1/tasks/{id}/release`), never one whose text the bot wrote any part of (the task, or a note in its thread) |
| `feed:read` | optional: read the whole feed and the projects |
| `memory:read` | optional: `relay_recall`, `relay_brief`, decisions history |

Every write the bot makes is attributed to it. On the board its words and decisions go out as a profile named for
it under the site's deployment (`bot-grok-bot` for the token `oauth:grok-bot`: `bot:oauth:<name>` and `bot:<name>`
are the same bot), and the feed rows copied from the board name it `bot:grok-bot`; rows the site writes directly
(`relay_event_log`) name it by its token, `bot:oauth:grok-bot`. The bot cannot choose another actor: the server
derives it from the token, and the only event kinds it may write itself start with `external.`. Nothing in the
bot's words is data to relay: a block in a task's text or a note is plain text to every worker and to the feed
(`docs/SECURITY.md`, "Who relay believes"), and a task whose text carries one is refused. Revoking the token (the
Access page, `relay token revoke oauth:grok-bot`, `POST /oauth/revoke`) stops it at once. `relay_whoami` (public) or
`GET /api/v1/whoami` tells a bot what it is: name, scopes, expiry, source.

## 3. The tools

MCP endpoint: `POST <site>/mcp` (Streamable HTTP, stateless, `Authorization: Bearer <token>`). The REST twins live
under `<site>/api/v1` and are described by `<site>/openapi.json`; errors are RFC 9457 `application/problem+json`.

| Tool | REST | Scope | Does |
|---|---|---|---|
| `relay_whoami()` | `GET /api/v1/whoami` | public | the connection's token name, scopes, expiry and source; anonymous callers are told where the authorization server is |
| `relay_task_create(project, title, body?, lane?, model?, needs?, base?, idempotency_key?)` | `POST /api/v1/tasks` (`lane` required) | `tasks:write` | opens a task: a thread in the project's queue on the board, labelled with its lane (and model), in the repository the project is registered with. A lane that is neither built in nor listed by an online worker is refused, naming the lanes that have one. Returns `task_id` and the task's state |
| `relay_task_get(task_id)` | `GET /api/v1/tasks/{id}` | `tasks:read` | the task with its state, lane, model, pull request (`pr_url`), hold and its reason, who holds the claim, result or reason, the usage rows relay's own authors wrote in its thread, and the latest notes there |
| `relay_task_list(project?, state?, limit?)` | `GET /api/v1/tasks?project=&state=&lane=&limit=` | `tasks:read` | tasks oldest first, the order a queue is worked in. Default `state: "open"`: everything not done or closed, failed included. `state: "review"` is what waits for a decision |
| `relay_task_approve(id)` | `POST /api/v1/tasks/{id}/approve` | `tasks:write` | approve a task in review: relay squash-merges its pull request through GitHub, deletes the branch and completes the task; a task whose deliverable is its attached outputs is completed with no merge. Only the pull request the runner's hold names is merged, and only when its branch is the task's own. GitHub's refusal comes back as an error and the task stays in review. A bot never approves a task it opened (403). The deployment must be able to settle the task on the board, which is checked before anything merges (403 without the `--site-project` grant). A task whose own pull request is already merged is finished from any open state, and an approval that finds the task already completed by GitHub's delivery is a success |
| `relay_task_request_changes(id, note)` | `POST /api/v1/tasks/{id}/request-changes` | `tasks:write` | send it back: the note goes in the task's thread and as a comment on the pull request, and the task is `queued`; the next run reads the thread and pushes to the same branch and pull request |
| `relay_task_requeue(id, lane?, model?)` | `POST /api/v1/tasks/{id}/requeue` (`"model": null` goes back to the lane's default) | `tasks:write` | put a failed, held or blocked task back in the queue, optionally on another lane or model; the next run starts over from the base branch. A running task is refused with who holds it |
| `relay_task_close(id, reason?)` | `POST /api/v1/tasks/{id}/close` | `tasks:write` | close a task without a merge from any state but `done` or `closed`: canceled on the board with the reason, which also stops a run in progress; its open pull request and branch and the issue it answers are closed on GitHub, best effort |
| `relay_task_release(id)` | `POST /api/v1/tasks/{id}/release` | `tokens:write` | release a task the injection gate `held` (`docs/SECURITY.md`, "The gate") for the text as it stands: the task is `queued` and that text is not graded again; anything added later is. For text a person has read and judged safe; a bot never releases a task whose text it wrote any part of, the task itself or a note in its thread (403). 409 when the task is not held |
| `relay_event_log(kind, project?, summary, url?, cost_equiv?, source?)` | `POST /api/v1/events` | `events:write` | one `external.*` row in the feed, actor `bot:<token name>` |
| `relay_access_list()` | `GET /api/v1/access` | `tokens:write` | device requests waiting for a decision (`user_code`, `client_name`, `scopes`, `requested_at`, `expires_at`) and approvals the device has not polled yet |
| `relay_access_approve(user_code, decision?)` | `POST /api/v1/access/{user_code}/approve` | `tokens:write` | approve (default) or deny one; the device's next poll gets its token; attributed to `bot:<token name>`. Only scopes the bot holds, never `tokens:write`; otherwise "ask a person to approve this one at `<site>/activate`" |
| `relay_invite_create(name, scopes[], expires_in?, uses?)` | `POST /api/v1/invites` | `tokens:write` | mint an invite: returns the row, the code (once) and the `relay setup --site <site> --invite <code>` line; the same ceiling |
| `relay_invite_revoke(id_or_name)` | `DELETE /api/v1/invites/{id}` | `tokens:write` | stop an unredeemed invite |

A task's ID is the ID the board gave its thread; in a URL it is one encoded path segment. Only a thread in a
project's queue is a task: any other thread's ID answers "No task" (404). `lane` is `claude`,
`codex`, `grok` or `nodes` (the lanes `relay work` serves), `any` (whichever code lane is free), or a lane another
worker lists; the MCP tool defaults to `claude`. `needs` is a list of task IDs that must complete first.
`base` must be a branch name and `model` a model id. A task the site opens has its brief (`brief.md`) in the thread
before any worker can claim it. `idempotency_key` makes a retried create safe, and is looked up before the lane is
checked: the same key from the same caller returns the task the first call
made and opens nothing (the REST route answers 200 with `"created": false` instead of 201).

The site needs a GitHub credential only to merge, comment and close: the GitHub App, or `GITHUB_TOKEN` when no app is
configured. Opening and reading tasks needs none.

### Task state

The board keeps a task's state; relay shows one word for it. Nothing is cached: every read asks the board.

| State | Means |
|---|---|
| `waiting` | a task it needs has not completed; it joins the queue by itself when that one does |
| `queued` | ready for a worker that serves its lane: new, sent back with a note, or requeued |
| `running` | a worker holds it and the lane is working in a fresh clone; `claim` says who and until when |
| `review` | the pull request (`pr_url`) or the outputs are there and wait for a decision |
| `held` | the injection gate flagged the text; `hold.reason` says what it saw. No worker runs it until a release |
| `blocked` | held for another reason: an eval step is looking at the work, or the board holds a task whose text someone else edited |
| `done` | merged, by an approval or on GitHub, or its outputs were approved; `result` says which |
| `failed` | a worker gave up; `reason` says why. A requeue retries it |
| `closed` | called off without a merge |

So "what is happening with my tasks" is `relay_task_list(state: "review")`: the ones waiting for a decision, each with
its `pr_url`. `relay_task_list(state: "held")` is what the injection gate stopped: tell the person what the hold's
reason says and let them decide; a chat bot that relays it ("task held: <reason>") and calls `relay_task_release`
only after a person said so is the intended shape. A task no worker picks up stays `queued`.

**There is no webhook to subscribe to.** A bot that wants to know when a task finished asks: `relay_task_get` for
one task, `relay_task_list` for the ones in a state. The feed has the same turns as rows (`task.created`,
`run.started`, `run.finished`, `run.failed`, `task.held`, `task.approved`, `task.closed`; `docs/FEED.md`) for a bot
that holds `feed:read`.

### Review

A task in `review` is decided in one of four places, all the same core function
(`approveTask` / `requestChanges` in `packages/core/src/board/tasks.ts`): the task page at `<site>/tasks/<id>`,
`relay_task_approve` / `relay_task_request_changes` over MCP, the two REST routes, and `relay task approve <id>` /
`relay task changes <id> --note "…"` on a machine. Approve squash-merges with `<PR title> (#<pr>)` as the commit title
and `relay: approved by <actor>` in the body, deletes the branch and completes the task. Request changes puts the note
in the task's thread and on the pull request; the task is queued and the worker that claims it starts from the base
branch again, replaces the same `relay/<lane>-<ref>` branch with `--force-with-lease`, and the existing pull request
is reused. A pull request merged on GitHub itself completes the task too.

Who may decide: a signed-in person always; a bot when its token holds `tasks:write`, with one rule: a bot never
approves a task it opened, since it would be deciding on its own work. It may send its own task back, requeue it or
close it. The rule is applied in one place for the API, the pages and the MCP server
(`packages/core/src/board/desk.ts`) and is judged from who the board says wrote the task. What an approval can merge
is fixed by the board, not by the caller: the pull request the worker's hold names, and only when its head is the
branch relay pushed for that task. The pattern for a chat bot that opened the task is: relay the pull request and
ask the person to approve it on the task's page, or have a second bot the person trusts approve on their word.

### A task on the wrong lane, failed or held: requeue

`relay_task_requeue({id, lane?, model?})`, `POST /api/v1/tasks/{id}/requeue` with `{"lane"?, "model"?}`, "Requeue" on
the task page, or `relay task requeue <id> [--lane <lane>] [--model <id>]` (`requeueTask`). A failed task is
reopened, a held or blocked one has its hold lifted, a queued one is only relabelled. A `done` or `closed` task is
refused (409): open a new one. A `running` task is refused with who holds it and until when; it returns to the
queue by itself when that worker stops renewing its claim, and `relay_task_close` is how a run is stopped. The next
worker that serves the lane claims it, clones fresh from the base branch, replaces the task's branch and reuses the
open pull request if there is one.

## Grok Bot walkthrough

What Grok Bot does, in the order it experiences it; no human types a token anywhere.

1. **Ask.** `POST <site>/oauth/device` with `client_name=grok-bot` and `scope=tasks:read tasks:write events:write`.
   It gets `user_code: RLAY-4F7Q` and tells the user: "relay needs your approval: open relay.kyro.house/activate and
   approve RLAY-4F7Q, or just say yes." It starts polling `POST <site>/oauth/token` every 5 seconds.
2. **Approve.** The user opens `/activate` (already signed in with GitHub), sees "grok-bot asks for access" with the
   three scopes explained, clicks Approve; or says "yes, let grok-bot in" and Concierge, the chief-of-staff bot that
   holds a `tokens:write` token from an invite the person created once, calls `relay_access_list()` on `<site>/mcp`,
   finds `RLAY-4F7Q` for `grok-bot` with those three scopes, and calls `relay_access_approve({user_code: "RLAY-4F7Q"})`
   (or posts `POST <site>/api/v1/access/RLAY-4F7Q/approve`). That works because Concierge holds those three scopes
   itself; had grok-bot asked for `memory:write` or `tokens:write`, Concierge would be told to hand it to a person at
   `/activate`. The feed shows `access.requested`, then `access.granted` by `bot:oauth:concierge`. No one opens the
   Access page.
3. **Receive.** The next poll returns `{access_token: "rly_…", refresh_token: "rrt_…", expires_in: 86400,
   token_name: "oauth:grok-bot"}`. The bot stores both in its secret store and schedules a refresh before 24 hours.
4. **Connect.** It points its MCP client at `<site>/mcp` with `Authorization: Bearer rly_…` (or calls `<site>/api/v1`).
   `relay_whoami` confirms `oauth:grok-bot` with its three scopes and the expiry; `relay_get_info` (public) lists the
   projects it may open tasks in (a project must have been linked with `relay link`, or auto-registered when the
   GitHub App was installed on a repo holding `relay.md`).
5. **Open work.** When the conversation produces a task:
   `relay_task_create({project: "site", title: "Add dark mode to the pricing page", body: "<the brief>", lane: "codex", idempotency_key: "<conversation id>:<n>"})`
   → `{task_id: "<the board's ID>", state: "queued", …}`. The task is a thread in `work/site` on the board, written as
   the bot's profile; a worker that serves `codex` and takes the site's tasks claims it. The body is what the lane
   reads, so write it for a model, not a person (`docs/SECURITY.md`: it is data, never instructions to relay).
6. **Hear back by asking.** There is nothing to subscribe to. The bot keeps the `task_id` and calls
   `relay_task_get(task_id)` when the user asks, or on its own schedule: `running` → a worker is on it; `failed` →
   something to look at, with the reason; `review` → "the PR is open: <pr_url>"; `held` → the gate stopped the text,
   a person reads it; `done` → merged. `relay_task_list({state: "review"})` is everything that waits for a decision.
7. **Take the decision to the person.** Grok Bot opened this task, so it cannot approve it: a bot never approves
   its own work, and `relay_task_approve` answers 403 for it. It sends the user the pull request and the task's page
   (`<site>/tasks/<task_id>`), where "ship it" is one click, signed in. Or the user says "ship it" to Concierge, a
   second bot with `tasks:write` that did not open the task, and Concierge calls
   `relay_task_approve({id: "<task_id>"})`: relay squash-merges the PR, deletes the branch and completes the task,
   and the board shows Concierge's profile as who did it. "Not yet, the toggle has no focus ring" Grok Bot can do
   itself: `relay_task_request_changes({id, note: "The toggle has no focus ring; match the one on /settings."})`.
   The note lands in the thread and on the PR, the task is queued, and the next run addresses it on the same PR.
8. **Answer "where are we".** `relay_task_list({state: "review"})` and `relay_task_get(task_id)`; `pr_url` is the
   thing to open, `last_result` what the lane said it did, `hold` why a task is not moving.
9. **Leave a trace.** `relay_event_log({kind: "external.briefing", project: "site", summary: "Sent the morning brief: 2 in review, 1 failed", url: …})`.
   It shows in the feed as `bot:oauth:grok-bot`, next to what the workers did.
10. **Stay connected.** Every day `grant_type=refresh_token` gives a new pair. If the user revokes `oauth:grok-bot` on
    the Access page (`/access`), the next call is `401` and the bot starts again at step 1; nothing else changes.

## Running a production

The same bot, a short instead of a site (`docs/PRODUCTIONS.md` has the model). It needs `projects:write` on top of the
three scopes above if it opens productions itself.

1. **Open the production.** `PUT /api/v1/projects/blackgate {"repo": "acme/productions"}` (or the operator runs `relay project add blackgate --repo acme/productions`). Every production shares the tracker repo, which holds the workflow files.
2. **Seed its memory.** `relay_decide({project: "blackgate", text: "Night exteriors are wet asphalt, sodium light, no lens flares"})`, `relay_prefer({scope: "project", scope_id: "blackgate", key: "style", value: "35mm, shallow focus, muted palette"})`. `relay_guidance({model: "bytedance/seedance-2.5", query: "camera motion"})` is the vendor's own advice when the bot writes a prompt.
3. **Open the character pass.** `relay_task_create({project: "blackgate", lane: "nodes", title: "Reza: character reference", body: "<intent>\n\n```relay-nodes\nworkflow: blackgate/workflows/character-ref.py\ninputs:\n  Start Flow:\n    prompt: \"…\"\noutputs: [End Flow]\nstage: character\n```"})`. The body is data; the manifest is what the worker runs. It stays `queued` until a worker that serves `nodes` is online.
4. **Hear back by asking.** `relay_task_get(task_id)`: `review` → the outputs are attached to the task's thread and its page `<site>/tasks/<id>` lists them (they cannot be downloaded from the site yet, only from the board); `failed` → the reason says whether it was the manifest, the engine or a missing key; `held` → the gate stopped the text, a person reads it.
5. **Decide on the person's word.** "Approve" is the person's on the task's page, or a second bot's that did not open the task (`relay_task_approve({id})`): the task is completed, with no merge. The bot that opened the task is refused. "Too dark, lose the flare" → `relay_task_request_changes({id, note: "Too dark; lose the lens flare, keep the sodium light"})`: the task is queued and the next run reads the note in the thread and attaches the next version.
6. **Open the shots once the character is approved.** One `relay_task_create` per shot with `stage: shot`; `needs: [<the character task's ID>]` makes a shot wait until that task is done.
7. **Answer "where are we".** `relay_task_list({project: "blackgate", state: "review"})` is what waits; the board at `/?project=blackgate` for the person.

## Site mode for the CLI

A laptop that should use the hosted relay rather than its own database runs `relay setup --site <site>` once
(`docs/MEMORY.md`, "Site mode"); the device flow or an invite gives it the token. From then on `relay feed`,
`relay usage`, `relay recall`, `relay brief`, `relay decide`, `relay prefer`, `relay memory history`, `relay token`
and `relay invite`, and the session hooks, talk to the site. `relay task`, `relay steps run` and `relay work` do not:
they work on the board with the machine's own `vercel login`, in either mode (`docs/WORKERS.md`). `relay link` still digests
with the local Claude login and uploads the result (`PUT /api/v1/projects/<slug>`, `/digests`, `/summary`, scope
`projects:write`), then asks `GET /api/v1/projects/<slug>/github` (`feed:read` or `projects:write`) whether the site's
GitHub App is installed on the repo and prints the install link when it is not. `relay doctor` says which mode is active,
how the machine authenticates, whether the site answers, and which linked repos still lack the App. `relay setup --no-site` goes back to local.
