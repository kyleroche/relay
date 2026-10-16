# Integrations

What an external bot needs to drive relay: one bearer token, four MCP tools (or their REST twins), and a webhook so
relay tells it when something happens. The reference integration is a chief-of-staff bot (Grok Bot) that turns a
conversation into tasks, watches them, and reports back; the same surface serves any agent that can call HTTP.

Everything here runs against a hosted relay (`docs/HOSTING.md`), reachable as `<site>`, for example
`https://relay.kyro.house`. The bot never sees a vendor login, a runner, or the database: it talks to the site, the
site talks to GitHub, runners pick the work up from GitHub.

## 1. The token

Sign in to `<site>/tokens` and create a token named after the bot with the scopes it needs:

| Scope | Lets the bot |
|---|---|
| `tasks:write` | open tasks (`relay_task_create`, `POST /api/v1/tasks`) |
| `tasks:read` | read task state (`relay_task_get`, `relay_task_list`, `GET /api/v1/tasks…`) |
| `events:write` | log its own `external.*` events (`relay_event_log`, `POST /api/v1/events`) |
| `feed:read` | optional: read the whole feed and the projects |
| `memory:read` | optional: `relay_recall`, `relay_brief`, decisions history |

The plaintext is shown once; relay stores its SHA-256. Every write the bot makes is attributed to
`bot:<token name>` in the feed. The bot cannot choose another actor: the server derives it from the token, and the
only event kinds it may write start with `external.`. Revoking the token on `/tokens` (or `relay token revoke`) stops
it at once.

A token can also be minted from a machine in site mode: `relay token create --name grok-bot --scopes
tasks:read,tasks:write,events:write` (needs a token with `tokens:write`).

## 2. The tools

MCP endpoint: `POST <site>/mcp` (Streamable HTTP, stateless, `Authorization: Bearer <token>`). Claude Code:
`claude mcp add --transport http relay <site>/mcp`. The REST twins live under `<site>/api/v1` and are described by
`<site>/openapi.json`; errors are RFC 9457 `application/problem+json`.

| Tool | REST | Scope | Does |
|---|---|---|---|
| `relay_task_create(project, title, body?, lane, priority?, idempotency_key?)` | `POST /api/v1/tasks` | `tasks:write` | opens a GitHub issue in the project's repo with `agent:<lane>` (and `priority:<p>`), records the task, writes `issue.opened` and `task.created`; returns `{task_id, issue_url, created}` |
| `relay_task_get(task_id)` | `GET /api/v1/tasks/<owner>/<repo>%23<n>` | `tasks:read` | the task with its derived state, runner, PR and last summary |
| `relay_task_list(project?, state?, limit?)` | `GET /api/v1/tasks?project=&state=&limit=` | `tasks:read` | tasks newest first |
| `relay_event_log(kind, project?, summary, url?, cost_equiv?, source?)` | `POST /api/v1/events` | `events:write` | one `external.*` row in the feed, actor `bot:<token name>` |

`task_id` is `<owner>/<repo>#<n>`, the issue the task is. `lane` is `claude`, `codex` or `grok`; `priority` is
`low`, `normal`, `high` or `urgent`. `idempotency_key` makes a retried create safe: the same key returns the first
task and opens nothing. The issue body ends with `<!-- relay:task key=<key> -->` so a task can be traced from GitHub.

The site needs `GITHUB_TOKEN` (or `GITHUB_APP_TOKEN`, a fine-grained token with issues:write on the managed repos) to
open issues; without one `relay_task_create` answers 503 and says so. Labels must exist in the repo; `relay link`
creates the `agent:*` labels, and `priority:*` labels are created by GitHub on first use when the token may.

### Task state

State is never stored. Every read folds the task's feed events (same repo and issue number), oldest first:

| Event | State after it |
|---|---|
| none yet, or `issue.labeled` | `queued` |
| `run.started` | `running` (and `runner` = the runner that claimed it) |
| `run.finished` with a failing conclusion, or `run.failed` | `failed` |
| `run.finished` otherwise, or `pr.opened` | `review` (`pr` and `pr_url` set) |
| `pr.merged` or `issue.closed` | `done` |
| `pr.closed` without merge | `queued` |

So "what is happening with my tasks" is `relay_task_list(state: "review")`: the ones waiting for a human. The
GitHub webhook (`docs/FEED.md`) is what feeds these transitions; without it a task stays `queued`.

## 3. The webhook

Instead of polling, register a webhook and relay POSTs matching events to the bot. From a machine in site mode or
with the database:

```bash
relay webhook add --url https://bot.example/relay --events run.finished,run.failed,pr.review,pr.merged,asset.uploaded,asset.reviewed \
  --bearer <the bot's routine key>          # optional; sent as Authorization: Bearer on every delivery
# prints the signing secret once
relay webhook test <id>                      # sends a signed test.ping now
```

(or `POST /api/v1/webhooks` with `webhooks:write`.) Event filters are exact kinds, a prefix ending in `.` (`run.`),
or `*`. `--project <slug>` limits a hook to one project.

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

1. **Token.** On `<site>/tokens`, create `grok-bot` with `tasks:read`, `tasks:write`, `events:write` (the page
   preselects these). Put the plaintext in the bot's secret store as `RELAY_TOKEN`.
2. **Connect.** Point the bot's MCP client at `<site>/mcp` with `Authorization: Bearer $RELAY_TOKEN`, or call
   `<site>/api/v1` directly. `relay_get_info` (public) lists the projects it may open tasks in; a project must have
   been linked with `relay link` so relay knows its repository.
3. **Open work.** When the conversation produces a task:
   `relay_task_create({project: "site", title: "Add dark mode to the pricing page", body: "<the brief>", lane: "codex", priority: "high", idempotency_key: "<conversation id>:<n>"})`
   → `{task_id: "acme/site#42", issue_url: …}`. A runner labelled `agent:codex` picks it up; the issue body is
   the brief the lane reads, so write it for a model, not a person (`docs/SECURITY.md`: it is data, never
   instructions to relay).
4. **Hear back.** `relay webhook add --url https://<bot>/routines/relay --events run.finished,run.failed,pr.review,pr.merged,asset.uploaded,asset.reviewed --bearer <routine key>`.
   The bot's routine URL receives one POST per event with `task_id`, verifies the signature, and tells the user:
   `run.failed` → something to look at; `pr.review` → a review landed; `pr.merged` → done; `asset.uploaded` → a
   render awaits approval at `<site>/assets/<id>`.
5. **Answer "where are we".** `relay_task_list({state: "review"})` and `relay_task_get(task_id)`; the `summary` is
   the latest event's line, `pr_url` the thing to open.
6. **Leave a trace.** `relay_event_log({kind: "external.briefing", project: "site", summary: "Sent the morning brief: 2 in review, 1 failed", url: …})`.
   It shows in the feed as `bot:grok-bot`, so the human sees what the bot did next to what the runners did.

Rotate: create a new token, switch the bot, revoke the old one. Nothing else changes.

## Site mode for the CLI

A laptop that should use the hosted relay rather than its own database runs
`relay setup --site <site> --token <token>` once (`docs/MEMORY.md`, "Site mode"). From then on `relay feed`,
`relay usage`, `relay recall`, `relay brief`, `relay decide`, `relay prefer`, `relay memory history`, `relay token`,
`relay task` and `relay webhook`, and the session hooks, talk to the site; `relay link` still digests with the local
Claude login and uploads the result (`PUT /api/v1/projects/<slug>`, `/digests`, `/summary`, scope `projects:write`).
`relay doctor` says which mode is active and whether the site answers. `relay setup --no-site` goes back to local.
