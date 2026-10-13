-- Asset library: media too large to share inline, versioned, with an approve-or-reject review loop (docs/ASSETS.md).
-- Access control is the app's job (API scopes); the table carries no per-row grants.
CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,                                  -- ulid
  project text REFERENCES projects(slug) ON DELETE SET NULL,
  issue int,
  pr int,
  title text NOT NULL,
  description text,
  kind text NOT NULL,                                   -- image | video | audio | pdf | html | file
  mime text NOT NULL,
  size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,                            -- blob pathname or local relative path
  thumb_key text,
  width int,
  height int,
  duration_ms int,
  version int NOT NULL DEFAULT 1,
  parent_id text REFERENCES assets(id) ON DELETE SET NULL,  -- previous version; survives the parent's expiry
  status text NOT NULL DEFAULT 'pending',               -- pending | approved | rejected | superseded | published
  created_by text NOT NULL,                             -- actor, e.g. bot:grok, runner:mini, human:kyle
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  public_url text,                                      -- set only after an explicit publish
  expires_at timestamptz,                               -- set when rejected or superseded; null = keep
  tags text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS assets_project_status_idx ON assets(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS assets_expires_idx ON assets(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_parent_idx ON assets(parent_id);
