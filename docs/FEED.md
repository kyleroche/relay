# The feed

Everything relay knows about happens as a row in the `events` table (`packages/core/src/db/schema.sql`). Humans,
bots, runners and lanes all write the same shape: a `kind`, an `actor`, where it happened (`repo`, `issue`, `pr`,
`project`), optional usage numbers, a one-line `summary`, a `url`, and the raw `payload`. The web app's feed page is
a time-ordered view over this table; the `ledger` view is the subset with `kind = 'step.usage'`.

## Event kinds

| Kind | Source | Actor | Fields set | Summary line |
|---|---|---|---|---|
| `issue.opened` | GitHub webhook `issues` (opened) | `human:<login>` or `bot:<login>` | repo, issue, url | issue title |
| `issue.labeled` | GitHub webhook `issues` (labeled, `agent:*` labels only) | `human:<login>` | repo, issue, lane | `agent:<lane>` |
| `worker.registered` | `POST /api/v1/workers` the first time a machine runs `relay work` (docs/WORKERS.md) | `runner:<worker name>` | payload.worker (id), host, lanes, labels, version | name and lanes |
| `worker.online` | `POST /api/v1/workers` when a worker comes back after an offline report | `runner:<worker name>` | payload.worker, host, lanes, labels, version | name and lanes |
| `worker.offline` | `POST /api/v1/workers/{id}/heartbeat` with `status: offline` (a clean shutdown) | `runner:<worker name>` | payload.worker, host | name |
| `run.started` | `POST /api/v1/work/{task}/start` from a worker holding the lease (or GitHub webhook `workflow_job` in_progress on an optional Actions runner) | `runner:<worker name>` | repo, issue, lane, url (issue), payload.worker, branch, labels, claim | lane and worker |
| `run.finished` | `POST /api/v1/work/{task}/release` with `outcome: finished` (or `workflow_job` completed) | `runner:<worker name>` | repo, issue, pr, lane, url (the PR), duration_ms, payload.conclusion, payload.claim | the lane's first summary line |
| `run.failed` | `POST /api/v1/work/{task}/release` with `outcome: failed` (the CLI failed, timed out, or changed nothing) | `runner:<worker name>` | repo, issue, lane, duration_ms, payload.error, payload.claim | the error |
| `run.dispatched` | the site, when a task is opened with a cloud lane (`claude-cloud`, `codex-cloud`): after the mention comment is posted | `bot:<token name>` or `human:<login>` (whoever opened the task) | project, repo, issue, lane (the vendor), url (the comment), payload.lane, mention, comment_id, brief_tokens, routine | `Dispatched #<n> to the <lane> lane (@<vendor>)` |
| `step.usage` | `POST /api/v1/work/{task}/release` carrying `usage` (one row per worker run); also GitHub webhook `issue_comment` on a PR, parsed from a usage comment (below) that does not say `"source": "relay-work"` | `agent:<lane>` | repo, issue, pr, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, url, payload.tool, worker, claim | model and tokens |
| `pr.opened` | GitHub webhook `pull_request` (opened) from a `relay/` branch, or from a cloud lane's `claude/` or `codex/` branch (below) | `agent:<lane>` (lane from branch name) | repo, issue (from branch or `Closes #n`), pr, lane, url, payload.cloud for cloud lanes | PR title |
| `pr.reviewed` | GitHub webhook `issue_comment` carrying a review from a lane, or `pull_request_review` | `agent:<lane>` or `human:<login>` | repo, pr, lane | first line of the review |
| `pr.merged` | GitHub webhook `pull_request` (closed, merged) | `human:<login>` | repo, issue, pr, url | PR title |
| `preview.ready` | Vercel webhook `deployment.succeeded` / `deployment.ready`, or GitHub webhook `deployment_status` (success) | `bot:vercel` (or `bot:<deployer>`) | repo, issue (when the branch is `relay/<lane>-<issue>`), pr (Vercel's `githubPrId`), url (the preview URL), payload.ref (the branch), commit / sha. A task's view matches these rows by issue, PR or ref (`preview_url`, `preview_state`) | project and branch |
| `preview.failed` | Vercel webhook `deployment.error` / `deployment.failed`, or `deployment_status` failure | `bot:vercel` | repo, issue, pr, url (the build), payload.ref | project and branch |
| `task.approved` | "Approve and merge" on the task page, `relay_task_approve`, `POST /api/v1/tasks/{id}/approve`, `relay task approve` (`approveTask` in `packages/core/src/tasks/review.ts`) after GitHub merged | `human:<login>` or `bot:<token name>` | project, repo, issue, pr, lane, url (the PR), payload.merged (true), merge_sha, method (`squash`), branch, branch_deleted, pr_title | `Approved and merged #<pr> (<sha>)` |
| `task.changes_requested` | "Request changes" on the task page, `relay_task_request_changes`, `POST /api/v1/tasks/{id}/request-changes`, `relay task changes`, after the note was posted on the PR | `human:<login>` or `bot:<token name>` | project, repo, issue, pr, lane, url (the PR comment), payload.note, comment_id, comment_url, branch. The task is `queued`; the next run's brief carries the note | `Changes requested on #<pr>: <first line>` |
| `task.merge_failed` | an approval whose merge GitHub refused (conflicts, required checks, permissions) | who approved | project, repo, issue, pr, lane, url (the PR), payload.error (GitHub's message), status, method, head_sha. The task stays in `review` | `Merge of #<pr> refused: <message>` |
| `task.requeued` | "Requeue" on the task page, `relay_task_requeue`, `POST /api/v1/tasks/{id}/requeue`, `relay task requeue` (`requeueTask` in `packages/core/src/tasks/requeue.ts`), from any state but `done` | `human:<login>` or `bot:<token name>` | project, repo, issue, pr (when it has one), lane (the lane it is queued on), url (the PR or the issue), payload.previous_state, previous_lane, lane, reason, github (`{relabelled, removed, added}` or `{relabelled: false, error}`: the `agent:*` label move is best effort), claim_released (the worker whose lease was released), branch. The task is `queued` and the doorbell rings | `Requeued #<n> on the <lane> lane (was <old lane>), was <state>: <reason>` |
| `decision.captured` | session-end hook (`relay capture`), `relay decide`, the `relay_decide` tool, or the post-merge job | `agent:<cli>` or `human:<login>` | project, payload.decision_id, payload.source, payload.superseded | the decision text |
| `preference.set` | `relay prefer` or the `relay_prefer` tool | `human:<login>` or `agent:<cli>` | project (project scope only), payload.key/value/scope/scope_id | `key = value (scope: id)` |
| `project.linked` | `relay link` | `human:<login>` | project, repo, payload.path | repo and path |
| `memory.consolidated` | nightly job | `bot:relay` | project, payload.counts | merged and superseded counts |
| `onboard.refreshed` | `relay onboard <model>` | `human:<login>` | model, payload.sources | model and chunk count |
| `runner.offline` | GitHub webhook `workflow_job` (queued) with no matching runner for longer than a threshold, or a failed keep-alive | `bot:relay` | lane, payload.runner | which label has nobody serving it |
| `task.created` | `relay_task_create`, `POST /api/v1/tasks`, `relay task create` (alongside an `issue.opened` row for the same issue) | `bot:<token name>` or `human:<login>` | project, repo, issue, lane, url, payload.task_id/priority/idempotency_key | `<task id>: <title>` |
| `external.run.dispatched` | `relay-cloud.yml` after it posted the `@codex` / `@claude` comment for an `agent:*-cloud` label (through `POST /api/v1/events`, so it carries the `external.` prefix like every token-written kind) | `bot:<token name>` (the `RELAY_TOKEN` the repo holds) | project, url (the comment), payload.lane (`claude-cloud` or `codex-cloud`), payload.repo, payload.issue, payload.comment_url, payload.mention, payload.brief_tokens, payload.source = `relay-cloud` | `Dispatched #<n> to the <lane> lane (@<vendor>)` |
| `external.*` | `relay_event_log`, `POST /api/v1/events`: an external bot's own note | always `bot:<token name>` (derived from the token, never from the client) | project, url, cost_equiv, payload.source | whatever the bot said, ≤500 chars |
| `access.requested` | `POST /oauth/device`: a CLI or bot asked for a token | `bot:<client name>` | payload.user_code, client_name, scopes, verification_uri_complete, approve_api, expires_at | "<client> asks for access (<scopes>): approve RLAY-XXXX at <site>/activate" |
| `access.granted` | consent on `/oauth/authorize`, approval on `/activate` or `POST /api/v1/access/<code>/approve`, a code or device exchange, an invite redeemed | `human:<login>` (who approved) or the invite's creator | payload.via, user_code, client_id, token_id, scopes | who approved what, or which client received a token |
| `access.denied` | Deny on `/activate` or `{"decision":"deny"}` over the API | `human:<login>` | payload.user_code, client_name, scopes | who denied which code |
| `access.revoked` | `POST /oauth/revoke`, or a reused refresh token cutting its lineage | the grant's actor | payload.token_id, client_id, reason, revoked_tokens | what was revoked and why |
| `access.invite_created` | `relay invite create`, `POST /api/v1/invites`, New invite on the Access page | `human:<login>` or `bot:<token name>` | payload.invite_id, name, scopes, uses, expires_at | who created an invite for whom (never the code) |
| `access.invite_revoked` | `relay invite revoke`, `DELETE /api/v1/invites/{id}`, Revoke on the Access page | who revoked it | payload.invite_id, name, uses_left | which invite stopped |
| `access.client_removed` | Remove under Clients on the Access page (`removeClient`; refused while anything live depends on the client) | `human:<login>` | payload.client_id, client_name, origin | who removed which client |
| `access.purged` | the daily `/api/cron/access-expire` sweep (`purgeAccess`), only when something was removed | `bot:relay` | payload.device_codes, auth_codes, refresh_tokens, clients (names) | the counts |
| `project.github_connected` | GitHub App `installation` (created) or `installation_repositories` (added) | `human:<installer>` | repo, project (when known), url, payload.installation_id, registered | installed on which repo; "registered project" when `relay.md` was present |
| `project.github_disconnected` | GitHub App `installation` (deleted, suspend) or `installation_repositories` (removed) | `human:<login>` | repo, project, payload.installation_id | removed from which repo |

`subscription` is derived from the lane: `claude -> max`, `codex -> codex`, `grok -> grok`, overflow lanes `->
gateway`. `cost_equiv` is computed at ingest from the Gateway list-price table in `packages/core/src/ledger`, so the
runner never has to know prices.

Every webhook write sets `dedupe_key` to the GitHub delivery id (or the Vercel webhook id), and `step.usage` rows add
the comment id, so redeliveries never double-count.

## Cloud lanes in the feed

A cloud lane (`docs/RUNNERS.md`, "Cloud lanes") leaves three kinds of trace, none of them a usage line:

1. `issue.labeled` is **not** written for `agent:claude-cloud` / `agent:codex-cloud`: the normalizer only treats
   `agent:claude|codex|grok` as lane labels. The dispatch row below is the record that the label was acted on.
2. `external.run.dispatched` from `relay-cloud.yml` once the mention comment is posted (table above). Its `url` is
   the comment, so the feed links to the exact place the vendor's agent was addressed.
3. `pr.opened` (then `pr.merged` / `pr.closed`) when the vendor's PR arrives through the GitHub webhook. The
   normalizer (`cloudLaneOf` in `apps/web/lib/webhooks/github.ts`) attributes a pull request to a cloud lane when:
   - the head branch starts with `claude/` → `lane = claude`, `payload.cloud = "claude-cloud"`. Claude Code cloud
     sessions, Routines and claude-code-action all push `claude/`-prefixed branches; sessions and routines push
     under the user's own GitHub login, the action under `claude[bot]`;
   - the head branch starts with `codex/` → `lane = codex`, `payload.cloud = "codex-cloud"`. Codex cloud names its
     branches `codex/<description>`;
   - otherwise the PR author (or the delivery's sender) is `claude[bot]` or `chatgpt-codex-connector[bot]`.

   For these rows the `actor` is `agent:<lane>` even when GitHub reports the user's own login as the author, and
   `payload.author` keeps that login. The `lane` column stays the vendor lane (`claude`, `codex`) so the usage
   meters and the reviewer map keep working; `payload.cloud` is what tells a cloud PR from a runner PR. `issue` comes
   from `Closes #n` in the body (the dispatch comment asks the agent to write it); a cloud PR without it has
   `issue = null`. Runner branches keep their own rule: `relay/<lane>-<issue>` sets both `lane` and `issue`.

Because the vendor's sandbox never posts the usage block, the `ledger` view has no `step.usage` row for a cloud lane.
Spend for those runs is on the vendor's usage page; the dispatch row carries `payload.brief_tokens` for the part relay
contributed.

## The usage comment

A worker (`relay work`, `packages/core/src/work/job.ts`) and the optional `scripts/runner/run-lane.sh` post exactly
one comment per run on the PR. It ends with a marker and a fenced JSON block:

````markdown
## Summary from the claude lane

...the lane's own final message...

<!-- relay:usage -->
```json
{"relay":"step.usage","lane":"claude","mode":"code","tool":"claude","model":"claude-opus-5","issue":42,"tokens_in":18234,"tokens_out":2210,"cache_read":91200,"cache_write":4100,"duration_ms":412000,"source":"relay-work","claim":"01J..."}
```
````

A worker's block carries `"source": "relay-work"`: the worker already reported the same numbers through
`POST /api/v1/work/{task}/release`, which wrote the `step.usage` row, so the webhook keeps the comment for humans and
writes no second row. Blocks without that field (an Actions runner's) are ingested as below.

How the GitHub webhook handler parses it, on `issue_comment` (created or edited) where the issue is a pull request:

1. Require the comment to contain `<!-- relay:usage -->`; otherwise ignore the comment for usage purposes.
2. Take the first fenced block after the marker whose info string is `json`, trim it, and `JSON.parse` it. The
   block is a single line, but a multi-line object is accepted.
3. Require `relay === "step.usage"`; otherwise ignore.
4. Required fields: `lane` (`claude|codex|grok|gateway`), `tokens_in`, `tokens_out`, `cache_read`, `cache_write`,
   `duration_ms` (all non-negative integers), `model` (string, may be `"default"` when the CLI did not report one).
   Optional: `mode` (`code|review`, default `code`), `tool` (`claude|fx|codex|grok`), `issue` (integer). Anything
   else is kept in `payload` but not interpreted.
5. Write one `events` row: `kind = 'step.usage'`, `actor = 'agent:<lane>'`, `repo`, `pr` and `url` from the
   comment, `issue` from the field or from the PR's `relay/<lane>-<issue>` branch name, `lane`, `model`,
   `subscription` derived from the lane, usage columns copied, `cost_equiv` computed, `summary` =
   `"<model>: <tokens_in>+<cache_read> in, <tokens_out> out"`, `dedupe_key = 'gh-comment:<comment id>'`.
6. In review mode (`"mode":"review"`), also write a `pr.reviewed` row with the text above the marker as the summary.

Only comments by logins in the repo's `RELAY_ALLOWED_SENDERS` variable (which includes the runner's gh account) are
trusted for usage; the handler reads that variable through the GitHub API (with `GITHUB_TOKEN`) once per hour and
caches it, or takes the comma-separated `RELAY_ALLOWED_SENDERS` environment variable when set. With neither
configured every sender is trusted for usage; the opposite holds for an `agent:<lane>` label that would open a task
for a worker (`issue.labeled`): only an allowlisted sender may, and with no allowlist nobody may
(`senderMayOpenTasks`). A usage block posted by anyone else is recorded as `payload.untrusted = true`
with its usage columns zeroed (the reported numbers stay in `payload.reported`), so the `ledger` view, which is a
plain `kind = 'step.usage'` filter, never counts it.

The parser lives in `apps/web/lib/webhooks/usage.ts`; the handler for every GitHub delivery is
`githubEvents` in `apps/web/lib/webhooks/github.ts`, which returns zero, one or two rows per delivery.

## Outbound webhooks

Any row written through the web app (the GitHub and Vercel ingest, the API event writers, the MCP tools) or the stdio
MCP server is offered to the registered webhooks (`webhooks` table, migration 005). A hook names a URL, the event kinds
it wants (exact kinds, a prefix ending in `.`, or `*`), optionally one project, a signing secret and an optional bearer.
Register one with `relay webhook add --url <url> --events run.finished,run.failed,preview.ready,task.approved,task.changes_requested,pr.merged,asset.uploaded,asset.reviewed [--project <slug>] [--bearer <key>] [--secret <s>]`
(the secret is generated and shown once when omitted), list with `relay webhook ls`, remove with `relay webhook rm
<id>`, and send a signed `test.ping` with `relay webhook test <id>`; the same four operations live under
`/api/v1/webhooks` (scope `webhooks:write`). Kinds supported out of the box: `run.finished`, `run.failed`, `pr.review`,
`pr.merged`, `preview.ready`, `preview.failed`, `task.approved`, `task.changes_requested`, `task.merge_failed`,
`task.requeued`, `asset.uploaded`, `asset.reviewed`; any kind in the table above works too. A chat bot that wants to say "preview is
up: <url>" subscribes to `preview.ready` (the delivery's `url` is the preview and `task_id` the task) and to
`task.approved` / `task.changes_requested` to report decisions, whoever made them.

Each delivery is one `POST` with a JSON body:

```json
{"id": "<delivery id>", "kind": "pr.merged", "ts": "2026-10-16T10:12:03.000Z", "task_id": "acme/site#42", "project": "site",
 "issue": 42, "pr": 57, "url": "https://github.com/acme/site/pull/57", "summary": "Merged #57 into main", "actor": "human:kyle",
 "lane": "claude", "event_id": 9120}
```

`task_id`, `issue`, `pr`, `url`, `lane` and `event_id` are present when the event has them (`test.ping` has none).
Headers:

| Header | Value |
|---|---|
| `X-Relay-Signature` | `sha256=<hex HMAC-SHA256(secret, "<X-Relay-Timestamp>.<raw request body>")>` |
| `X-Relay-Timestamp` | unix seconds when the attempt was made (each retry re-signs with a fresh timestamp) |
| `X-Relay-Event` | the event kind |
| `X-Relay-Delivery` | the delivery id, same across retries of one event, also the `id` in the body |
| `Authorization` | `Bearer <bearer>` when the hook was created with one |
| `Content-Type` | `application/json` |

Delivery is three attempts (after 1 s and 4 s); a 4xx other than 408 or 429 stops early; a 2xx is success. Every
attempt set is one `webhook_deliveries` row (`status`, `attempts`, `last_error`, `delivered_at`), shown by
`GET /api/v1/webhooks/<id>`. The web app runs the fan-out with `after()` so the request that wrote the event never
waits on a receiver; the dispatcher is `packages/core/src/webhooks/dispatch.ts`.

Verify before trusting (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyRelay(req, rawBody, secret, toleranceSeconds = 300) {
  const ts = req.headers["x-relay-timestamp"];
  const sig = req.headers["x-relay-signature"];
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSeconds) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
```

Use the raw request body, not a re-serialised object, and dedupe on `X-Relay-Delivery`.
`verifyWebhookSignature` in `@relay/core` is the same check for TypeScript receivers.

## Reading the feed

- Web: the feed page groups rows by issue, with the usage meter per subscription in the header.
- CLI: `pnpm relay feed` (last 50 rows) and `pnpm relay usage --days 7` (per-subscription totals, the same query as
  the `ledger` view). In site mode both read the hosted site (`GET /api/v1/feed`, `GET /api/v1/usage`).
- Bots: `relay_task_list` / `relay_task_get` fold a task's rows into one state (`docs/INTEGRATIONS.md`).
- SQL: `select * from ledger where ts > now() - interval '7 days' order by ts desc`.
