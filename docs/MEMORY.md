# Memory

relay's memory is what lets a decision made in a Codex session show up in the next Claude or Grok step without
anyone re-explaining it. It is small on purpose: decisions, preferences, vendor guidance, and a generated rules file.
No transcripts are stored and none are ever replayed into a model.

## What is remembered

### Decisions, with validity

A decision is one sentence of the form "we do X because Y", tied to a project (or global). Each row in `decisions`
has `valid_from` and `valid_to`: a decision is current while `valid_to` is null. When a later decision contradicts
it, the old row gets `valid_to = now()` and `superseded_by = <new id>`; nothing is deleted, so you can always ask
"what did we believe on the 3rd". Recall only returns current decisions unless asked for history.

Sources (`decisions.source`): `claude`, `codex`, `grok` (captured by the session-end hook), `pr` (extracted from a
merged PR's description and review thread), `human` (typed through the CLI or the web app), `nightly` (produced by
consolidation). `source_ref` keeps the session id or PR URL so a decision can be traced.

### Preferences, with scopes

A preference is a key/value such as `test_runner = vitest` or `commit_style = imperative, one topic`. Scopes, from
widest to narrowest: `global`, `project` (`scope_id` = project slug), `lane` (`scope_id` = `claude|codex|grok`),
`model` (`scope_id` = model id). Narrower scopes override wider ones when a brief is assembled, so you can say
"globally, prefer small PRs; in the grok lane, never touch migrations".

### Vendor guidance, behind a gate

For models you prompt rather than code with (image, video, speech), relay ingests the vendor's official docs and
published skills into `guidance` and `skills`, chunked and embedded. The **guidance gate** (`assertOnboarded`) means
a lane cannot use a model until `pnpm relay onboard <provider/model>` has run and the sources are fresher than the
model's `stale_days`. Only domains allowlisted in `packages/core/src/onboard/registry.ts` are accepted; community
prompt guides are excluded unless you allowlist a domain yourself. `onboard.refreshed` events record every ingest.

### Projects and digests

`projects` holds the repo, its stack note and check command, and a 2K-token summary. `file_digests` keeps one
summary per file, keyed by content hash, re-summarized only when the hash changes. Digests make briefs cheap:
a brief names the files that matter instead of pasting them.

## How recall reaches a model

Nothing reads memory inside the model loop. Memory is injected at two edges and captured at a third:

1. **Brief time (runners).** `scripts/runner/run-lane.sh` calls `relay brief <issue>` when the relay CLI is
   installed on the runner and appends its output to the brief under a `## Memory` heading. `relay brief` returns
   the current decisions for the project, the merged preferences for the project and lane, and up to 3K tokens of
   guidance matched to the issue text. Without the CLI the section is skipped and the lane still runs.
2. **Session start (hooks).** `pnpm relay setup` installs a session-start hook into each CLI it finds:
   Claude Code `SessionStart` hook, Codex `notify`/session hook, Grok Build session hook. The hook runs `relay
   recall --cwd .` and prints the same decisions-and-preferences block, which the CLI adds to the system context
   of that session. Injection is capped (default 3K tokens) and the cap is a preference (`recall_tokens`).
3. **Session end (hooks).** The matching session-end hook runs `relay capture`, which asks for the session's
   decisions in one structured call on the same CLI, writes them as `decisions` rows with `source = <cli>`, and
   emits `decision.captured` events. It never stores the transcript.

Cloud agents and the web app reach the same data through the memory MCP server (`packages/mcp`): stdio for local
CLIs, HTTP at `/api/memory` with `RELAY_MEMORY_TOKEN` for anything remote. Tools: `recall`, `decide`, `prefer`,
`guidance`.

## The rules file and the owned section

Each linked repo gets a generated `relay.md`: the current decisions and preferences for that project rendered as
plain rules, plus the one-paragraph description of how relay works in this repo (labels, branches, what the runner
does). `run-lane.sh` puts `relay.md` at the top of every brief.

So that every CLI reads it without being told, `relay link` adds a short owned section to `AGENTS.md` (and
`CLAUDE.md` if present) between two markers:

```markdown
<!-- relay:begin -->
This repository is managed with relay. Read `relay.md` before making changes; it holds the current decisions and
preferences for this project. Issues labelled `agent:claude|codex|grok` are implemented by lanes on self-hosted
runners that open pull requests from `relay/<lane>-<issue>` branches.
<!-- relay:end -->
```

Rules for the owned section:

- relay rewrites only the text between `<!-- relay:begin -->` and `<!-- relay:end -->`. Everything else in the file
  is yours and is never touched.
- If the markers are missing, `relay link` appends the section at the end of the file and tells you.
- If you delete the markers, relay stops writing to that file; `relay doctor` reports it.
- Regeneration happens after a merge (the post-merge job extracts decisions and re-renders `relay.md`) and on
  `relay link --refresh`. The regenerated files are committed by the job on a `relay/rules-<date>` branch as a PR,
  never pushed to the default branch directly.

## Consolidation

A nightly job (`memory.consolidated` events) merges duplicate decisions, closes the validity of decisions
contradicted by newer ones, and drops preferences whose scope target no longer exists. It runs on the web app's
schedule, not on your machines, and it uses the Gateway only if `AI_GATEWAY_API_KEY` is set; otherwise it does the
exact-match merges only.

## Working with memory by hand

```text
pnpm relay recall --project <slug>            # what a brief would contain right now
pnpm relay decide "<text>" --project <slug>   # add a decision as source=human
pnpm relay prefer <key> <value> --scope lane --id grok
pnpm relay memory history --project <slug>    # decisions including superseded ones
```

Any of these also writes a feed event, so the web app shows who changed memory and when.

## Data model and query modules

### Data model

Schema lives in `packages/core/src/db/migrations/NNN_name.sql`, applied in order by `relay init` and tracked in
`meta.schema_version`. Shipped migrations are never edited; add a new file.

| Table | Holds | Key |
|---|---|---|
| `projects` | a registered repo: path, stack, check command, the ≤2K-token summary every brief starts with | `slug` |
| `file_digests` | per-file summary keyed by content hash; stale while `summary_sha <> sha256` | `(project, path)` |
| `decisions` | durable decisions with a validity window (`valid_to` null = current, `superseded_by` links the replacement), embedding + full-text | `id` |
| `preferences` | key/value settings by scope (`global`, `project`, `lane`, `model`) | `(key, scope, scope_id)` |
| `providers`, `models` | the onboarding registry: allowlisted doc domains, lanes, `onboarded_at`, counts | `slug`, `id` |
| `sources` | every official page or skill archive fetched, with sha256/etag so unchanged pages are skipped | `url` |
| `guidance` | chunked vendor guidance per model with kind, tokens, embedding (1536) and a generated `tsv` | `(model, id)` — one source may guide several models |
| `skills` | provider-published skills installed under `~/.harness/skills` | `(name, model)` |
| `events` | the append-only feed: who did what, with tokens and cost; `dedupe_key` makes webhook writes idempotent | `id` |
| `ledger` (view) | `events WHERE kind = 'step.usage'`; `relay usage` groups it by subscription | — |

Full-text search uses `websearch_to_tsquery('english', …)` against the `tsv` columns; vector search uses the
pgvector cosine operator `<=>` on `embedding`. Embeddings are optional (`AI_GATEWAY_API_KEY`); without them
retrieval falls back to full text.

### Query modules

`packages/core/src/db/` exposes typed functions, one module per area, all taking the `Db` first:

- `projects.ts`: `upsertProject`, `getProject`, `listProjects`, `setProjectSummary`, `upsertFileDigests`, `removeMissingFileDigests`, `listFileDigests`, `setFileSummaries`
- `guidance.ts`: providers, models, sources, guidance chunks (`replaceGuidance`, `pruneGuidance`, `setEmbeddings`, `vectorSearchGuidance`, `textSearchGuidance`), skills
- `memory.ts`: `addDecision`, `supersedeDecision`, `listDecisions`, `searchDecisions`, `upsertPreference`, `listPreferences`
- `events.ts`: `writeEvent`, `listEvents`, `usageSummary`

`repo.ts` re-exports all of them as one namespace (`repo.getModel(h.db, id)`). The `Ledger` class in
`ledger/ledger.ts` is a thin adapter that writes `step.usage` events and holds the Gateway list-price table.

### Configuration

- `DATABASE_URL` (env, optional): use Postgres over TCP instead of the embedded database.
- `AI_GATEWAY_API_KEY` (env, optional): enables embeddings for guidance and decisions.
- `~/.harness/config.json`: `staleDays` and `gateway.embeddingModel`. No secrets are ever written there.

`relay doctor` reports database reachability and schema version alongside the CLI login checks.
