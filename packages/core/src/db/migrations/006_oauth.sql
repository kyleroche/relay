-- OAuth 2.1 authorization server state (docs/SECURITY.md, "Access for agents"): registered clients, one-time
-- authorization codes, device codes, refresh tokens, invites, and operator settings. Access tokens are rows in `tokens`
-- (named `oauth:<client name>`), so every existing scope check keeps working; they gain an expiry and a client here.
-- Every secret-bearing column stores a SHA-256, never the plaintext, except `settings.value`, which is sealed
-- (AES-256-GCM under RELAY_SESSION_SECRET) when `sealed` is true.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS client_id text;

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY,
  client_secret_hash text,                                -- null for public clients (token_endpoint_auth_method = none)
  name text NOT NULL,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  grant_types text[] NOT NULL DEFAULT '{}',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  scopes text[] NOT NULL DEFAULT '{}',                    -- the most the client may ask for; empty = any
  software_id text,
  client_uri text,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  resource text,
  actor text NOT NULL,                                    -- human:<login> who approved on the consent page
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_device_codes (
  device_code_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,                         -- RLAY-4F7Q, what the person types on /activate
  client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending',                 -- pending | approved | denied | redeemed
  actor text,                                             -- who decided
  decided_at timestamptz,
  token_id text,                                          -- tokens.id once redeemed
  interval_seconds int NOT NULL DEFAULT 5,
  last_polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_device_codes_pending_idx ON oauth_device_codes(expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  access_token_id text REFERENCES tokens(id) ON DELETE SET NULL,
  scopes text[] NOT NULL,
  actor text NOT NULL,                                    -- who the grant belongs to (the approver, or invite:<id>)
  expires_at timestamptz NOT NULL,
  rotated_from text,                                      -- the token_hash this one replaced
  used_at timestamptz,                                    -- set when rotated; a second use revokes the lineage
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY,                                    -- ulid
  code_hash text NOT NULL UNIQUE,
  name text NOT NULL,                                     -- who it is for; the token is named oauth:<name>
  scopes text[] NOT NULL,
  uses_left int NOT NULL DEFAULT 1,
  max_uses int NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_redeemed_at timestamptz
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  sealed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
