# The feed

Everything relay knows about happens as a row in the `events` table (`packages/core/src/db/schema.sql`). Humans,
bots, runners and lanes all write the same shape: a `kind`, an `actor`, where it happened (`repo`, `issue`, `pr`,
`project`), optional usage numbers, a one-line `summary`, a `url`, and the raw `payload`. The web app's feed page is
a time-ordered view over this table; the `ledger` view is the subset with `kind = 'step.usage'`.

Tasks and workers are not in this table: they live on the team's Vercel Board (`docs/WORKERS.md`). What happens to
a task there reaches the feed through the site's ledger, which copies the queues' events into rows
(`docs/ARCHITECTURE.md`, "The site and the board"). The board keeps a task's changes for 30 days; the feed is the
durable copy, and the usage page is a view over it. A worker's own state is its message in `relay/workers`, not a
row here.

## Event kinds

| Kind | Source | Actor | Fields set | Summary line |
|---|---|---|---|---|
| `issue.opened` | GitHub webhook `issues` (opened) | `human:<login>` or `bot:<login>` | repo, issue, url | issue title |
| `issue.labeled` | GitHub webhook `issues` (labeled, `agent:<lane>` labels only). From an allowed sender the same delivery opens a task on the board that answers the issue, one per issue | `human:<login>` | repo, issue, lane | `Labelled agent:<lane>` |
| `task.created` | the ledger: a task was made in a project's queue (`relay task create`, `relay_task_create`, `POST /api/v1/tasks`, an `agent:<lane>` label on a GitHub issue, or anything else that makes one there) | who made it: `human:<login>` or `bot:<name>` when the site wrote it for them, `bot:github` for an issue's label, `human:<handle>` for a person's own login, `agent:<handle>/<profile>` for any other profile | project, lane, payload.task (the task's ID), title, lane, model, step (on a step's own task) | the task's title |
| `run.started` | the ledger: a worker's lane profile (`relay-<worker>-<lane>`) claimed the task | `runner:<worker>-<lane>` | project, lane, payload.task, title, until (the lease) | `<lane> took <title>` |
| `run.finished` | the ledger: a `relay-run@1` block from an author the site believes whose outcome is not `failed` (`review`, `eval`, `done`, `held`) | `runner:<worker>` | project, lane, repo, pr and url (the pull request, when the run opened one), payload.task, conclusion (the outcome), branch, eval_task | `<lane>: <outcome> <owner/name#pr>` |
| `run.failed` | the ledger: a `relay-run@1` block whose outcome is `failed` | `runner:<worker>` | project, lane, payload.task, conclusion | `<lane>: failed` |
| `step.usage` | the ledger: one row per `relay-usage@1` block from an author the site believes (a lane's run, the gate's grade, a step's call, one media output of the nodes lane) | `runner:<worker>` | project, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, payload.task, kind (`run`, `gate`, `step`, `media`), billing, step, outcome | the lane, or `step <name>`, and the model |
| `task.held` | the ledger: the task was held with kind `gate` (the pre-check when it was opened, or a worker's grade before the lane ran) | whoever held it | project, lane, payload.task, title, reason | `<title>: <reason>` |
| `task.approved` | the ledger: the task was completed: its pull request was merged (by an approval or on GitHub), its outputs were approved, its report was read, or its plan was approved (the tasks the plan opened are `task.created` rows of their own). A step's own task (an eval) completing writes no row; its run row says how it went | who completed it | project, lane, payload.task, title, result | `<title>: <result>` |
| `task.released` | the ledger: a `relay-release@1` block from an author the site believes (`relay task release`, `relay_task_release`, `…/release`, Release on the site) | who asked: the name in the `Released by <actor>.` line the site wrote beside the block, else the author | project, payload.task | `Released from the gate for the text as it stands` |
| `task.changes_requested` | the ledger: a note left with a send-back (a `relay=note` reply that is not from one of relay's own `relay-…` profiles; an eval's findings, which a worker writes, are not one) | who wrote the note | project, payload.task | `Sent back: <first line of the note>` |
| `task.closed` | the ledger: the task was canceled (`relay task close`, `relay_task_close`, `…/close`, Close on the site) | who closed it | project, lane, payload.task, title, reason | `<title>: <reason>` |
| `task.requeued` | the ledger: a failed task was reopened by a requeue | who requeued it | project, lane, payload.task, title | the task's title |
| `ledger.skipped` | the ledger: the database refused the rows of one board event. Those rows are dropped, this row takes their place and the events after it go on | `bot:relay` | project, payload.task, cursor (the board event) | `A <event type> on the board could not be recorded: <error>` |
| `board.delivery_failed` | the GitHub webhook route: a delivery could not do its part on the board (a labelled issue's task was not opened, for instance because nobody serves the lane, or a merged pull request did not complete its task) | `bot:github` | repo, issue or pr | what did not happen, and why |
| `pr.opened` | GitHub webhook `pull_request` (opened, reopened, ready for review) | the sender: `human:<login>` or `bot:<login>` | repo, pr, issue (from `Closes #n` in the body), lane (from a worker's `relay/<lane>-<8 hex>` branch, else from an `agent:<lane>` label on the pull request), url, payload.branch | PR title |
| `pr.review` | GitHub webhook `pull_request_review` (submitted) | `human:<login>` or `bot:<login>` | repo, pr, issue (from `Closes #n` in the pull request's body) | first line of the review |
| `pr.merged` | GitHub webhook `pull_request` (closed, merged). The same delivery completes the task in review that waits on that pull request | `human:<login>` | repo, pr, url | `Merged #<n> into <base>` |
| `pr.closed` | GitHub webhook `pull_request` (closed, not merged) | `human:<login>` | repo, pr, url | `Closed #<n> without merge` |
| `issue.closed` | GitHub webhook `issues` (closed) | `human:<login>` or `bot:<login>` | repo, issue, url | `Closed #<n>: <title>` |
| `workflow.run` | GitHub webhook `workflow_run` (completed) | `bot:github-actions` | repo, pr, duration_ms, url | the workflow, its conclusion and the branch |
| `preview.ready` | Vercel webhook `deployment.succeeded` / `deployment.ready`, or GitHub webhook `deployment_status` (success) | `bot:vercel` (or `bot:<deployer>`) | repo, pr (Vercel's `githubPrId`), url (the preview URL), payload.ref (the branch), commit / sha | project and branch |
| `preview.failed` | Vercel webhook `deployment.error` / `deployment.failed`, or `deployment_status` failure | `bot:vercel` | repo, pr, url (the build), payload.ref | project and branch |
| `decision.captured` | session-end hook (`relay capture`), `relay decide`, the `relay_decide` tool, or the post-merge job | `agent:<cli>` or `human:<login>` | project, payload.decision_id, payload.source, payload.superseded | the decision text |
| `preference.set` | `relay prefer` or the `relay_prefer` tool | `human:<login>` or `agent:<cli>` | project (project scope only), payload.key/value/scope/scope_id | `key = value (scope: id)` |
| `project.linked` | `relay link` | `human:<login>` | project, repo, payload.path | repo and path |
| `memory.consolidated` | nightly job | `bot:relay` | project, payload.counts | merged and superseded counts |
| `onboard.refreshed` | `relay onboard <model>` | `human:<login>` | model, payload.sources | model and chunk count |
| `external.*` | `relay_event_log`, `POST /api/v1/events`: an external bot's own note. relay's lead (`apps/lead`) logs `external.lead.usage` after each turn (the tokens and the cost AI Gateway reported), `external.lead.requeued` and `external.lead.watch` | always `bot:<token name>` (derived from the token, never from the client) | project, url, cost_equiv, payload.source | whatever the bot said, ≤500 chars |
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

Every ledger row carries the task's ID in `payload.task`, which is what links a row to `/tasks/<id>`. Usage, a run
and a gate release count only from an author the site believes: its own deployment and the worker logins in
`RELAY_BOARD_FROM` (`docs/HOSTING.md`), each as the principal itself or one of relay's own `relay-…` profiles of it
(`docs/SECURITY.md`, "Who relay believes"). A task's own turns are the board's facts and count from anyone. A row
names a person `human:<login>` or a bot `bot:<name>` only when the site itself wrote the message; anyone else's
profile called `human-kyle` is `agent:<handle>/human-kyle`. A row from the board takes its `subscription`, tokens
and `cost_equiv` from the block as the worker wrote it (`billing: gateway` is subscription `gateway`), clamped to
what the columns hold: whole numbers from 0 up, a cost to six decimals.

Each ledger row is written once: its `dedupe_key` names the board message or event it stands for, and the ledger
reads from a cursor kept in the settings table, so a wake-up and a page load can overlap. The first sync has no
cursor and takes the board's own summary of its last 100 events, which leaves out a hold that was since lifted;
every sync after reads from the cursor, which is every event. Rows are not rewritten later: usage from a login that
was not yet in `RELAY_BOARD_FROM` is not counted and is not backfilled when the login is added. Every webhook write sets
`dedupe_key` to the GitHub delivery id (or the Vercel webhook id), so redeliveries never double-count.

Kinds nothing writes now stay in the catalog (`apps/web/lib/events.ts`) so rows already in a feed keep their label:
`worker.registered`, `worker.online`, `worker.offline`, `run.dispatched` and `task.merge_failed`. A refused merge
is a line in the task's thread now, and a worker's state is its message on the board.

What writes no row of its own: a grant (a capability set or a paid run's cap) and the marks of a paid sandbox's
start are replies in the task's thread, and a wake-up of the lead is a request to another deployment. A paid run
shows in the feed through its ordinary rows: `run.started` and `run.finished` by its worker `cloud-<ref>`, and
`step.usage` rows whose `billing` is `gateway`. The lead's own turns are the `external.lead.*` rows it logs.

## Reading the feed

- Web: the feed page groups rows by issue, with the usage meter per subscription in the header.
- CLI: `pnpm relay feed` (last 50 rows) and `pnpm relay usage --days 7` (per-subscription totals, the same query as
  the `ledger` view). In site mode both read the hosted site (`GET /api/v1/feed`, `GET /api/v1/usage`).
- Bots: `relay_get_feed` (`feed:read`) reads these rows. A task's state is not derived from them:
  `relay_task_get` and `relay_task_list` ask the board (`docs/INTEGRATIONS.md`). There are no outbound webhooks; a
  bot that wants to know when something happened asks.
- SQL: `select * from ledger where ts > now() - interval '7 days' order by ts desc`.
