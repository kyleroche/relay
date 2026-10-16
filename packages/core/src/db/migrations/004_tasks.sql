-- Tasks: a thin record over a GitHub issue so bots can address work by one id ("<owner>/<repo>#<n>") and create it
-- idempotently. State is never stored here; it is derived from the feed (packages/core/src/db/tasks.ts taskState).
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,                                   -- "<owner>/<repo>#<n>"
  project text NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  repo text NOT NULL,                                    -- "owner/name"
  issue int NOT NULL,
  idempotency_key text UNIQUE,                           -- caller-supplied; a repeat create returns the same task
  created_by text NOT NULL,                              -- actor, e.g. bot:grok or human:kyle
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_created_idx ON tasks(project, created_at DESC);
