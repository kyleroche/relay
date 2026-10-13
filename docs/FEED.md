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
| `run.started` | GitHub webhook `workflow_job` (in_progress) on a `relay run` job | `runner:<runner name>` | repo, issue, lane, url (job url) | lane and runner |
| `run.finished` | GitHub webhook `workflow_job` (completed) | `runner:<runner name>` | repo, issue, lane, duration_ms, payload.conclusion | success, failure, cancelled, or "no changes" |
| `step.usage` | GitHub webhook `issue_comment` on a PR, parsed from the runner's usage comment (below) | `agent:<lane>` | repo, issue, pr, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, url | model and tokens |
| `pr.opened` | GitHub webhook `pull_request` (opened) from a `relay/` branch | `agent:<lane>` (lane from branch name) | repo, issue (from branch), pr, lane, url | PR title |
| `pr.reviewed` | GitHub webhook `issue_comment` carrying a review from a lane, or `pull_request_review` | `agent:<lane>` or `human:<login>` | repo, pr, lane | first line of the review |
| `pr.merged` | GitHub webhook `pull_request` (closed, merged) | `human:<login>` | repo, issue, pr, url | PR title |
| `preview.ready` | Vercel webhook `deployment.succeeded` for a `relay/` branch | `bot:vercel` | repo, pr, url (preview URL) | project and branch |
| `preview.failed` | Vercel webhook `deployment.error` | `bot:vercel` | repo, pr, url | project and branch |
| `decision.captured` | session-end hook or post-merge job (`packages/core/memory`) | `agent:<cli>` or `human:<login>` | project, payload.decision_id | the decision text |
| `memory.consolidated` | nightly job | `bot:relay` | project, payload.counts | merged and superseded counts |
| `onboard.refreshed` | `relay onboard <model>` | `human:<login>` | model, payload.sources | model and chunk count |
| `runner.offline` | GitHub webhook `workflow_job` (queued) with no matching runner for longer than a threshold, or a failed keep-alive | `bot:relay` | lane, payload.runner | which label has nobody serving it |

`subscription` is derived from the lane: `claude -> max`, `codex -> codex`, `grok -> grok`, overflow lanes `->
gateway`. `cost_equiv` is computed at ingest from the Gateway list-price table in `packages/core/src/ledger`, so the
runner never has to know prices.

Every webhook write sets `dedupe_key` to the GitHub delivery id (or the Vercel webhook id), and `step.usage` rows add
the comment id, so redeliveries never double-count.

## The usage comment

`scripts/runner/run-lane.sh` posts exactly one comment per run on the PR. It ends with a marker and a fenced JSON
block:

````markdown
## Summary from the claude lane

...the lane's own final message...

<!-- relay:usage -->
```json
{"relay":"step.usage","lane":"claude","mode":"code","tool":"claude","model":"claude-opus-5","issue":42,"tokens_in":18234,"tokens_out":2210,"cache_read":91200,"cache_write":4100,"duration_ms":412000}
```
````

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
trusted for usage; the handler reads that variable through the GitHub API once per hour and caches it. A usage
block posted by anyone else is recorded as `payload.untrusted = true` and excluded from the ledger.

## Reading the feed

- Web: the feed page groups rows by issue, with the usage meter per subscription in the header.
- CLI: `pnpm relay feed` (last 50 rows) and `pnpm relay usage --days 7` (per-subscription totals, the same query as
  the `ledger` view).
- SQL: `select * from ledger where ts > now() - interval '7 days' order by ts desc`.
