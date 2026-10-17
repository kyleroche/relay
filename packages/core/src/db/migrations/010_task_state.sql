-- Materialized task state (docs/ARCHITECTURE.md, "A task's life"). The feed stays the source of truth: these columns
-- are a cache of the fold in packages/core/src/db/tasks.ts (deriveTaskStatus) and tasks/station.ts (deriveStation),
-- written by refreshTaskState (db/task-state.ts) after every write that can change a task (an event with the task's
-- repo and issue, a claim taken, released or expired, a task created). The flow map and the tasks list read them in
-- one query instead of folding every task's history on every poll. NULL state means "not computed yet": readers fold
-- the row and fill it in (backfillTaskState runs once when this migration lands).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title text;                      -- the issue title, from the creator or the feed
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS state text;                      -- queued | claimed | running | review | done | failed
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS station text;                    -- Queue | Claimed | Running | PR | Preview | Review | Merged | Failed
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS since timestamptz;               -- when the task entered `station`
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_url text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preview_state text;              -- ready | building | failed | none
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preview_url text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS runner text;                     -- runner:<name> of the worker on it
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error text;                 -- the latest run.failed (or failing run.finished) line
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost double precision;           -- folded cost_equiv of the task's step.usage rows
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS state_updated_at timestamptz;    -- when the cache was last written
CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_station_idx ON tasks(station);
