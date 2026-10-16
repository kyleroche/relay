-- Outbound webhooks (docs/FEED.md "Outbound webhooks"): after an event is written, matching hooks receive a signed
-- POST. The secret and bearer are stored as given because the dispatcher needs them to sign and authenticate; the
-- API never returns them after creation. One delivery row per (webhook, event) records the attempts.
CREATE TABLE IF NOT EXISTS webhooks (
  id text PRIMARY KEY,                                   -- ulid
  project text REFERENCES projects(slug) ON DELETE CASCADE,   -- null = every project
  url text NOT NULL,
  secret text NOT NULL,                                  -- HMAC key for X-Relay-Signature
  bearer text,                                           -- sent as Authorization: Bearer when set
  events text[] NOT NULL DEFAULT '{}',                   -- kinds, prefixes ending in '.', or '*'
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_active_idx ON webhooks(active) WHERE active;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id text PRIMARY KEY,                                   -- ulid; also the X-Relay-Delivery header
  webhook_id text NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id bigint,                                       -- events.id; null for test.ping
  kind text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',                -- pending | delivered | failed
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook_idx ON webhook_deliveries(webhook_id, created_at DESC);
