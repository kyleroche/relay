-- relay memory + event log. Postgres 15+. Works on Neon (prod) and PGlite (local/tests).
-- Vector search needs the pgvector extension; full-text uses built-in tsvector.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A registered repository. slug is the GitHub repo name; repo is "owner/name".
CREATE TABLE IF NOT EXISTS projects (
  slug text PRIMARY KEY,
  repo text,
  path text,
  stack text,
  check_cmd text,
  summary text,
  summary_tokens int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-file digest keyed by content hash; re-summarized only when sha256 changes.
CREATE TABLE IF NOT EXISTS file_digests (
  project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 text NOT NULL,
  size int NOT NULL DEFAULT 0,
  summary text,
  summary_sha text,
  tokens int NOT NULL DEFAULT 0,
  seen_at timestamptz NOT NULL DEFAULT now(),
  summarized_at timestamptz,
  PRIMARY KEY (project, path)
);

-- Durable, cross-tool memory: decisions and preferences.
CREATE TABLE IF NOT EXISTS decisions (
  id bigserial PRIMARY KEY,
  project text REFERENCES projects(slug) ON DELETE CASCADE,
  text text NOT NULL,
  source text,                 -- 'claude' | 'codex' | 'grok' | 'pr' | 'human' | 'nightly'
  source_ref text,             -- session id, PR url, etc.
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,        -- null = current; set when superseded
  superseded_by bigint REFERENCES decisions(id),
  embedding vector(1536),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_project_idx ON decisions(project) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS decisions_tsv_idx ON decisions USING gin(tsv);

CREATE TABLE IF NOT EXISTS preferences (
  key text NOT NULL,
  scope text NOT NULL,         -- 'global' | 'project' | 'lane' | 'model'
  scope_id text NOT NULL DEFAULT '',
  value text NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope, scope_id)
);

-- Official vendor guidance per model (the onboarding gate).
CREATE TABLE IF NOT EXISTS providers (
  slug text PRIMARY KEY,
  name text NOT NULL,
  doc_domains text[] NOT NULL DEFAULT '{}',
  skill_sources text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS models (
  id text PRIMARY KEY,         -- e.g. bytedance/seedance-2.5
  provider text NOT NULL REFERENCES providers(slug),
  lanes text[] NOT NULL DEFAULT '{}',
  onboarded_at timestamptz,
  guidance_count int NOT NULL DEFAULT 0,
  skill_count int NOT NULL DEFAULT 0,
  stale_days int NOT NULL DEFAULT 30,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sources (
  url text PRIMARY KEY,
  provider text NOT NULL,
  title text,
  sha256 text,
  etag text,
  official boolean NOT NULL DEFAULT true,
  fetched_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guidance (
  id text PRIMARY KEY,         -- sha256(source_url#index:head)
  model text NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_url text NOT NULL REFERENCES sources(url) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  kind text NOT NULL,          -- prompting | limits | api | moderation | style | skill
  title text NOT NULL,
  text text NOT NULL,
  tokens int NOT NULL,
  embedding vector(1536),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || text)) STORED,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guidance_model_idx ON guidance(model);
CREATE INDEX IF NOT EXISTS guidance_tsv_idx ON guidance USING gin(tsv);
CREATE TABLE IF NOT EXISTS skills (
  name text NOT NULL,
  model text NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider text NOT NULL,
  install_path text NOT NULL,
  version text NOT NULL,
  sha256 text NOT NULL,
  source_url text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, model)
);

-- The event feed: one append-only log of everything agents and humans did. The ledger is a view over it.
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,          -- issue.opened | run.started | run.finished | step.usage | pr.opened | pr.merged | preview.ready | decision.captured | memory.consolidated | onboard.refreshed | ...
  actor text NOT NULL,         -- 'human:kyle' | 'bot:grok' | 'runner:mini' | 'agent:claude' | ...
  project text,
  repo text,
  issue int,
  pr int,
  lane text,
  model text,
  subscription text,           -- max | codex | grok | gateway | cursor | local
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  cost_equiv numeric(12,6) NOT NULL DEFAULT 0,
  duration_ms int,
  summary text NOT NULL,
  url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE       -- e.g. github delivery id, so webhooks are idempotent
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts DESC);
CREATE INDEX IF NOT EXISTS events_project_ts_idx ON events(project, ts DESC);
CREATE INDEX IF NOT EXISTS events_kind_ts_idx ON events(kind, ts DESC);

CREATE OR REPLACE VIEW ledger AS
  SELECT ts, actor, project, lane, model, subscription, tokens_in, tokens_out, cache_read, cache_write, cost_equiv, duration_ms, url
  FROM events WHERE kind = 'step.usage';
