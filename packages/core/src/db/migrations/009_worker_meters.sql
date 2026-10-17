-- Plan meters a worker reports with its heartbeat (packages/core/src/meters.ts): the 5-hour and 7-day used
-- percentages Claude Code hands its status line, saved by relay's status-line script under ~/.harness/meters and sent
-- along as [{subscription, window, used_percentage, resets_at, captured_at, source}]. Null until a worker on this
-- version heartbeats; the site shows the freshest reading per window across online and idle workers.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS meters jsonb;
