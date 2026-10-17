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
merged PR's description and review thread), `human` (typed through the CLI, the MCP tools or the web app), `nightly`
(produced by consolidation). `source_ref` keeps the session id or PR URL so a decision can be traced.

### Preferences, with scopes

A preference is a key/value such as `test_runner = vitest` or `commit_style = imperative, one topic`. Scopes, from
widest to narrowest: `global`, `project` (`scope_id` = project slug), `lane` (`scope_id` = `claude|codex|grok`),
`model` (`scope_id` = model id). Narrower scopes override wider ones when a brief is assembled
(`mergedPreferences` in `packages/core/src/brief/`), so you can say "globally, prefer small PRs; in the grok lane,
never touch migrations". Lane preferences are merged only when the caller names a lane (hooks pass the CLI they run
in; `relay brief --lane`).

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

## The brief compiler

`compileBrief(db, {project, issue?, intent, model?, lane?, maxTokens})` in `packages/core/src/brief/index.ts` is the
one place an envelope is assembled. It returns `{text, sections: [{name, tokens}], tokens, omitted}` and holds a hard
cap:

| Section | Content | Atomicity |
|---|---|---|
| `review` | the notes reviewers left with "Request changes" on this issue's PR (`task.changes_requested` rows; only when `issue.number` is given) | whole or omitted |
| `summary` | the project's ≤2K-token summary | whole or omitted |
| `preferences` | merged preferences for the project (and lane / model when given), rendered as hard rules | whole or omitted |
| `decisions` | current decisions matching the issue text and intent (`searchDecisions`, vector when `AI_GATEWAY_API_KEY` is set, else full text), topped up with the most recent and a few global ones | whole items until the budget; omitted when none fits |
| `guidance` | vendor guidance for `model` matching the query (`vectorSearchGuidance` or `textSearchGuidance`) | whole chunks until the budget; omitted when none fits |

Sections are allocated in the order review, preferences, decisions, summary, guidance (the reviewer's notes are why a
re-run exists, then binding and cheap first, the big summary after, guidance last) and rendered in the order review,
summary, preferences, decisions, guidance so every brief reads the same way. Nothing is ever cut mid-sentence; a section that does not fit is reported in `omitted`. Tokens
are the ≈4-chars/token estimate from `approxTokens`; the ledger records real counts.

## How recall reaches a model

Nothing reads memory inside the model loop. Memory is injected at two edges and captured at a third:

1. **Brief time (runners).** `scripts/runner/run-lane.sh` calls `relay brief <issue>` when the relay CLI is
   installed on the runner and appends its output to the brief under a `## Memory` heading. `relay brief` fetches
   the issue through `gh` when it can, compiles the envelope under a 3K-token cap (`--max-tokens`), and prints it.
   Without the CLI the section is skipped and the lane still runs.
2. **Session start and every prompt (hooks).** `pnpm relay setup` installs hooks into each CLI it finds:

   | CLI | File | Events installed | Injects |
   |---|---|---|---|
   | Claude Code | `~/.claude/settings.json` (hooks), `~/.claude.json` (user-scope `mcpServers.relay`) | `SessionStart`, `UserPromptSubmit`, `SessionEnd` | brief ≤2.5K tokens; recall ≤1K tokens; capture |
   | Codex | `~/.codex/config.toml`, one block between `# relay:begin` and `# relay:end`: `[mcp_servers.relay]`, `[[hooks.SessionStart]]`, `[[hooks.SessionEnd]]` | `SessionStart`, `SessionEnd` (Codex has no `UserPromptSubmit`; the `relay_recall` tool covers it) | brief ≤2.5K tokens; capture |
   | Grok Build | `~/.grok/hooks/relay.json` (relay owns the whole file), `~/.grok/settings.json` (`mcpServers.relay`) | `SessionStart`, `UserPromptSubmit`, `Stop` | brief ≤2.5K tokens; recall ≤1K tokens; capture |

   The hooks are `packages/cli/hooks/{session-start,user-prompt,session-end}.mjs --cli <name>`: dependency-free Node
   scripts that read the hook payload on stdin, look for `.relay/rules.json` above the cwd (so an unlinked repo gets
   nothing and costs nothing), and call the relay CLI through the repo's own `tsx`. `session-start` keeps the brief
   per project and lane for ten minutes under `~/.harness/cache/brief/` and answers from the cache without starting
   the CLI (≈30 ms); a cold start is ≈0.5 s. `user-prompt` skips prompts shorter than 20 characters and slash
   commands. `relay decide` and `relay prefer` drop the project's cache so a new decision reaches the next session.
   The budgets are fixed in the scripts (2.5K / 1K), not preferences.
3. **Session end (hooks).** `session-end` starts `relay capture --transcript <path>` detached, so the session never
   waits on a model call, and logs to `~/.harness/cache/capture.log`. Capture parses the transcript (Claude Code and
   Grok JSONL, Codex rollouts, or plain text), splits it into ≈2.5K-token segments on turn boundaries, gates each
   segment with a cheap rule (decision-flavoured language) or with the command in `capture.gateCommand` of
   `~/.harness/config.json` / `RELAY_CAPTURE_GATE` (Jev plugs in here: the segment arrives on stdin, exit 0 plus
   anything but `no` passes), and asks the Sonnet lane (`runClaude` with `tools: []`, structured output) for the
   durable decisions in the segments that passed, with the project's current decisions in the prompt so it can
   return `supersedes_id`. New rows get `source = <cli>` and `source_ref = <session id>`; each one emits a
   `decision.captured` event and the Sonnet call is a `step.usage` row. A byte offset per transcript in
   `~/.harness/cache/capture-state.json` makes per-turn `Stop` hooks and re-runs incremental. The transcript is never
   stored and never sent whole.

Cloud agents and the web app reach the same data through the memory MCP server (`packages/mcp`): the `relay-mcp`
stdio binary for local CLIs (`dist/relay-mcp.js` in the published `@kyleroche/relay`; `packages/mcp/bin/relay-mcp.mjs`
run through the repo's `tsx` in a checkout; either way with the node that ran `relay setup`), and `createMcpHandler(db, {token, publicRead?})` for a Next.js route at `/api/memory`
(Streamable HTTP, stateless; `RELAY_MEMORY_TOKEN` as the bearer enables `relay_decide` and `relay_prefer`, reads
are open only when `publicRead` is set). Tools: `relay_recall(query, project?)`, `relay_decide(text, project,
source?, supersedes_id?)`, `relay_prefer(key, value, scope, scope_id?, reason?)`, `relay_guidance(model, query)`,
`relay_brief(project, intent)`, `relay_feed(project?, limit?)`, `relay_project(slug)`. Every result is text capped at
3K tokens.

## The rules file and the owned section

`relay link` is the one per-repo step and runs the whole pipeline, printing a line per stage:

1. owned sections in `AGENTS.md`/`CLAUDE.md` (below), so a created `AGENTS.md` is hashed in the same run;
2. register the project and hash every text file (`scanFiles`; `relay.md` itself is skipped);
3. digest the files whose hash changed (`digestProject`: Sonnet lane, no tools, 8 files per call, at most
   `--max-files` = 400 per run); an entry under 10 words is dropped and re-requested once with a stricter prompt;
4. write the project summary (`summarizeProject`) when it is missing, when files were digested, or on `--refresh`.
   The summary comes back through `--json-schema` as `{summary}`, must be 150-700 words and carry the headings
   Purpose, Stack and layout, Commands, Conventions and Gotchas; a rejected answer is re-requested once, a second
   rejection fails the stage (the old summary is kept) and link exits non-zero;
5. render `relay.md` from the real summary (rewritten whenever its content changed);
6. caller workflows and GitHub labels (`--no-workflows`, `--no-labels`);
7. in site mode, the upload of the project, its digests and the summary, then the `events` stage: is the site's
   GitHub App installed on this repo (`GET /api/v1/projects/{slug}/github`)? `ok` with the installation id, or `warn`
   with the install link (and a closing `left:` line naming it as the one thing left to do); without a site the line
   says GitHub events are not ingested locally. Advice only, never a failure; `--no-events` skips it;
8. one cost line read back from the ledger: calls, tokens in/out, cost equivalent.

`--no-digest` skips steps 3 and 4. A second run with nothing changed makes zero model calls. The utility calls run
`claude -p` with no tools, no skills, no instruction files or auto-memory, in a scratch directory
(`lanes/claude.ts`), so the model only sees the prompt. `RELAY_FAKE_LANES=1` makes the lane return canned JSON
for tests.

Each linked repo gets a generated `relay.md` (`renderRulesFile`, ≤2K tokens): a header that says how relay works in
this repo (labels, `relay/<lane>-<issue>` branches, cross-model review) and tells the model to use the memory
tools, the hard rules from preferences, the top current decisions, and as many whole paragraphs of the project
summary as still fit. `run-lane.sh` puts `relay.md` at the top of every brief.

So that every CLI reads it without being told, `relay link` adds a short owned section to `AGENTS.md` (and
`CLAUDE.md` when it exists and is more than an `@AGENTS.md` include) between two markers:

```markdown
<!-- relay:begin -->
This repository is managed with relay (project `demo`). Read `relay.md` before making changes; it holds the current
decisions and preferences for this project.
Issues labelled `agent:claude`, `agent:codex` or `agent:grok` are implemented by lanes on self-hosted runners that
open pull requests from `relay/<lane>-<issue>` branches.
Memory tools (MCP server `relay`): `relay_recall`, `relay_decide`, `relay_prefer`, `relay_guidance`, `relay_brief`,
`relay_feed`, `relay_project`. Call `relay_recall` before choosing an approach and `relay_decide` when you settle one.
<!-- relay:end -->
```

Rules for the owned section (`packages/core/src/rules/owned-section.ts`):

- relay rewrites only the text between `<!-- relay:begin -->` and `<!-- relay:end -->`. Everything else in the file
  is yours and is never touched.
- If `AGENTS.md` is missing it is created; if the markers are missing, the section is appended at the end.
- `.relay/rules.json` in the repo records the project slug, the repo, and a hash of what relay last wrote per file.
  If the text inside the markers no longer matches that hash (you edited it), or markers exist that relay never
  wrote, `relay link` refuses to overwrite and says so; `relay link --force` takes the section over.
- If you delete the markers, relay stops writing to that file (`checkOwnedSection` reports it).
- `relay link` re-renders `relay.md` whenever memory changed; `--refresh` also rewrites the project summary and the
  caller workflows. The post-merge job that extracts decisions and opens a `relay/rules-<date>` PR is not built yet;
  until it is, run `relay link` after memory changes.
- `relay brief` budgets the project summary first, so a linked project's brief always carries it when one exists;
  when the project has no summary it says so and points at `relay link --refresh`. In `--hook` mode errors are never
  printed; they go to `~/.harness/cache/hooks.log`.

## Consolidation

A nightly job (`memory.consolidated` events) merges duplicate decisions, closes the validity of decisions
contradicted by newer ones, and drops preferences whose scope target no longer exists. It runs on the web app's
schedule, not on your machines, and it uses the Gateway only if `AI_GATEWAY_API_KEY` is set; otherwise it does the
exact-match merges only. (Not built yet; capture already dedupes exact matches and records supersessions.)

## Site mode

A machine does not have to hold the database. `relay setup --site https://relay.example.com` stores the site URL in
`~/.harness/config.json` (`site`) and the credential in `~/.harness/credentials.json` (mode 0600; `RELAY_SITE` and
`RELAY_TOKEN` override both). Without `--token` it runs the device flow: it prints a code like `RLAY-4F7Q`, you approve
it at `<site>/activate` (or a bot approves it over the API), and the CLI stores the 24-hour access token with its
90-day refresh token and renews it before it lapses. `--invite <code>` redeems an invite from `relay invite create`
with no approval; `--token <t>` pastes a token from `/tokens`. `relay setup` checks the site answers and accepts the
credential before saving (`--yes` saves anyway). `docs/INTEGRATIONS.md` has the flows.

With a site configured, `openHarness()` hands every command a `RelayClient` over HTTPS (`packages/core/src/client/`,
`httpClient`) instead of one over the database (`localClient`): `relay feed`, `relay usage`, `relay recall`,
`relay brief`, `relay decide`, `relay prefer`, `relay memory history`, `relay token`, `relay invite`, `relay task`,
`relay webhook` and the session hooks (which call these commands) talk to `/api/v1` and the memory tools on `/mcp`. `relay link` still
hashes and digests files on the machine, with its own Claude login, and uploads the project, digests, summary and the
`step.usage` rows the calls produced (`PUT /api/v1/projects/<slug>`, `/digests`, `/summary`; scope `projects:write`).
`relay doctor` reports `mode`, `auth` (how the machine got its token, its name and expiry), `site` and `whoami`.
Without a site nothing changes: the CLI opens PGlite or `DATABASE_URL`.

Not available in site mode (they need the database on the machine): `relay capture` (the session-end hook exits
quietly; use `relay decide`), `relay decide --global`, `relay sql`, `relay init`, `relay onboard`, `relay models`,
`relay project *`, `relay asset *`, and the stdio MCP server, which always serves the local database. They fail with
one line saying so. `relay setup --no-site` returns to local mode.

## Working with memory by hand

```text
pnpm relay setup [--yes] [--only claude|codex|grok] [--remove]   # hooks + MCP server per CLI; prints the plan, writes with --yes
pnpm relay setup --site <url> [--invite <code> | --token <t>] | --no-site   # site mode: device flow (approve the code at /activate), invite, or a pasted token
pnpm relay invite create --for <name> --scopes a,b [--expires 24h] [--uses 1]   # one-time code another machine redeems with --invite
pnpm relay link [--repo owner/name] [--refresh] [--force] [--no-digest] [--max-files 400] [--no-events]   # the per-repo step: digests, summary, relay.md, owned sections, workflows, labels, GitHub App check
pnpm relay brief <issue-number | intent words> [--max-tokens 3000] [--model <id>] [--lane <name>]
pnpm relay recall [text] [--project <slug>]                      # what a brief would contain right now
pnpm relay decide "<text>" [--project <slug> | --global] [--supersedes <id>]
pnpm relay prefer <key> <value> --scope lane --id grok
pnpm relay capture --transcript <path> [--source claude|codex|grok] [--dry-run] [--all]
pnpm relay memory history [--project <slug>] [--current]         # decisions including superseded ones
pnpm relay task create --title <t> --lane claude|codex|grok [--priority <p>] [--key <k>]   # open a task (GitHub issue with the lane label)
pnpm relay task get <owner/repo#n> | relay task ls [--state review]                        # derived state from the feed
pnpm relay webhook add --url <url> --events pr.merged,run.failed [--bearer <k>] | ls | rm <id> | test <id>
```

`relay decide` writes a `decision.captured` event, `relay prefer` a `preference.set` event, `relay link` a
`project.linked` event, so the web app shows who changed memory and when. Commands resolve the project from the cwd:
`--project` wins, then `.relay/rules.json`, then the origin remote's repo name. `RELAY_HOME` relocates `~/.harness`
(database, cache, config); `RELAY_USER_HOME` relocates where `relay setup` looks for `~/.claude`, `~/.codex` and
`~/.grok` (tests use both).

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
| `tokens` | bearer tokens for the site: name, scopes, SHA-256 of the plaintext, revocation | `id` |
| `tasks` | a GitHub issue relay opened or tracks as a task; state is derived from `events` (`docs/INTEGRATIONS.md`) | `id` = `owner/repo#n` |
| `webhooks`, `webhook_deliveries` | outbound hooks (url, events, project, secret, bearer) and one row per delivery attempt set (`docs/FEED.md`) | `id` |
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
- `tokens.ts`: `createToken`, `findToken`, `listTokens`, `revokeToken`, `TOKEN_SCOPES`
- `tasks.ts`: `createTask`, `getTask`, `listTasks`, `taskState` / `deriveTaskStatus`, `listTaskViews`
- `webhooks.ts`: `createWebhook`, `listWebhooks`, `matchingWebhooks`, `deleteWebhook`, the delivery log

`repo.ts` re-exports all of them as one namespace (`repo.getModel(h.db, id)`). The `Ledger` class in
`ledger/ledger.ts` is a thin adapter that writes `step.usage` events and holds the Gateway list-price table.

Above the query layer: `brief/` (`compileBrief`, `renderRulesFile`, `mergedPreferences`), `rules/owned-section.ts`,
`hooks/` (per-CLI installers, `planSetup`/`applyPlan`, the brief cache), `memory/capture.ts` (`captureDecisions`,
`parseTranscript`, the gates), `tasks/create.ts` (`openTask`), `github/client.ts` (issues over an env token or `gh`),
`webhooks/dispatch.ts` (signing, delivery, fan-out), `client/` (`RelayClient`: `localClient`, `httpClient`, site config).

### Configuration

- `DATABASE_URL` (env, optional): use Postgres over TCP instead of the embedded database.
- `AI_GATEWAY_API_KEY` (env, optional): enables embeddings for guidance and decisions.
- `RELAY_REPO`, `RELAY_REF` (env, optional) or `relay.repo` / `relay.ref` in `~/.harness/config.json`: what
  `relay link` substitutes for `__RELAY_REPO__` / `__RELAY_REF__` in the caller workflows (default `<owner>/relay@main`).
- `RELAY_CAPTURE_GATE` (env, optional) or `capture.gateCommand` in `~/.harness/config.json`: the segment gate command.
- `RELAY_SITE`, `RELAY_TOKEN` (env, optional) or `site` in `~/.harness/config.json` plus `token` in
  `~/.harness/credentials.json` (0600): site mode, written by `relay setup --site`.
- `~/.harness/config.json`: `staleDays`, `gateway.embeddingModel`, `site`. No secrets are ever written there; the
  site token lives in `credentials.json` next to it.

`relay doctor` reports database reachability and schema version alongside the CLI login checks.
