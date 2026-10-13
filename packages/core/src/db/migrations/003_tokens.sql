-- API bearer tokens for the web app and the HTTP MCP server. Only the SHA-256 of a token is stored; the plaintext is
-- shown once by `relay token create`. Scopes are the names the OpenAPI description publishes (feed:read, memory:read,
-- memory:write, assets:read, assets:write, assets:review).
CREATE TABLE IF NOT EXISTS tokens (
  id text PRIMARY KEY,                       -- ulid
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,           -- sha256 hex of the plaintext token
  scopes text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,                  -- actor, e.g. human:kyle
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tokens_hash_live_idx ON tokens(token_hash) WHERE revoked_at IS NULL;
