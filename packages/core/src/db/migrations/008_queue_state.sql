-- The doorbell (docs/WORKERS.md, "The loop"): one row whose version moves every time the queue may have changed
-- (a task opened, a lease released or expired). An idle worker reads it instead of running a claim, and claims only
-- when the version moved or something is queued, so an empty queue costs the site one cheap query per tick.
CREATE TABLE IF NOT EXISTS queue_state (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),  -- exactly one row
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO queue_state (one, version) VALUES (true, 0) ON CONFLICT DO NOTHING;

-- The poll interval a worker last reported with its heartbeat (ms), so the workers page and `relay work status`
-- can show how often an idle worker checks in. Null until a worker on this version heartbeats.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS poll_ms integer;
