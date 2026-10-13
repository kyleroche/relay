# Memory

relay's memory is one Postgres database. Locally it is an embedded PGlite (WASM Postgres with pgvector) at
`~/.harness/relay.pglite`; in production it is Neon, selected by setting `DATABASE_URL`. The same SQL runs on
both; `packages/core/src/db/client.ts` hides the two drivers behind one `Db` interface with `$1..$n` placeholders.

## Data model

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

## Query modules

`packages/core/src/db/` exposes typed functions, one module per area, all taking the `Db` first:

- `projects.ts`: `upsertProject`, `getProject`, `listProjects`, `setProjectSummary`, `upsertFileDigests`, `removeMissingFileDigests`, `listFileDigests`, `setFileSummaries`
- `guidance.ts`: providers, models, sources, guidance chunks (`replaceGuidance`, `pruneGuidance`, `setEmbeddings`, `vectorSearchGuidance`, `textSearchGuidance`), skills
- `memory.ts`: `addDecision`, `supersedeDecision`, `listDecisions`, `searchDecisions`, `upsertPreference`, `listPreferences`
- `events.ts`: `writeEvent`, `listEvents`, `usageSummary`

`repo.ts` re-exports all of them as one namespace (`repo.getModel(h.db, id)`). The `Ledger` class in
`ledger/ledger.ts` is a thin adapter that writes `step.usage` events and holds the Gateway list-price table.

## Configuration

- `DATABASE_URL` (env, optional): use Postgres over TCP instead of the embedded database.
- `AI_GATEWAY_API_KEY` (env, optional): enables embeddings for guidance and decisions.
- `~/.harness/config.json`: `staleDays` and `gateway.embeddingModel`. No secrets are ever written there.

`relay doctor` reports database reachability and schema version alongside the CLI login checks.
