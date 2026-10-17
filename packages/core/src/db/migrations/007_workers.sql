-- Workers and claims (docs/WORKERS.md): relay schedules its own tasks. A worker is a machine that ran
-- `relay work`; it registers by name, heartbeats, and claims the oldest queued task whose lane it serves. A claim
-- is a lease: it expires unless the heartbeat renews it, and an expired lease puts the task back in the queue.
-- Task state stays derived (packages/core/src/db/tasks.ts); claims only add the `claimed` step before run.started.
CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,                                   -- ulid
  name text NOT NULL UNIQUE,                             -- `runner:<name>` is the actor on its run.* events
  host text NOT NULL DEFAULT '',
  lanes text[] NOT NULL DEFAULT '{}',                    -- claude | codex | grok, from the machine's logins
  labels text[] NOT NULL DEFAULT '{}',                   -- extra capabilities (gpu, xcode, ...) a task may require
  version text NOT NULL DEFAULT '',                      -- relay CLI version the worker runs
  last_seen timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'online',                 -- what the worker last said: online | offline
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claims (
  id text PRIMARY KEY,                                   -- ulid
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  lease_until timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  outcome text                                           -- finished | failed | released | expired
);
-- one live claim per task; a second worker's insert fails instead of racing
CREATE UNIQUE INDEX IF NOT EXISTS claims_live_task_idx ON claims(task_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS claims_worker_idx ON claims(worker_id, claimed_at DESC);

-- The lane a task was opened with, so the scheduler can match it without folding the feed first.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lane text;
