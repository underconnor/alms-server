-- Additive OAuth state for the first, read-only MCP client. Existing sessions and school data are unchanged.
CREATE TABLE mcp_authorizations (
  id uuid PRIMARY KEY,
  grant_hash text NOT NULL UNIQUE CHECK (grant_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  client_id text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL CHECK (scopes = ARRAY['alms:read']::text[]),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_authorization_owner_idx ON mcp_authorizations(user_id,created_at DESC);
CREATE TABLE mcp_consent_challenges (
  interaction_hash text PRIMARY KEY CHECK (interaction_hash ~ '^[a-f0-9]{64}$'),
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE mcp_oauth_objects (
  model text NOT NULL,
  id_hash text NOT NULL CHECK (id_hash ~ '^[a-f0-9]{64}$'),
  payload_enc text NOT NULL CHECK (octet_length(payload_enc) <= 360000),
  grant_hash text,
  uid_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(model,id_hash)
);
CREATE INDEX mcp_oauth_grant_idx ON mcp_oauth_objects(grant_hash);
CREATE INDEX mcp_oauth_uid_idx ON mcp_oauth_objects(model,uid_hash) WHERE uid_hash IS NOT NULL;
CREATE INDEX mcp_oauth_expiry_idx ON mcp_oauth_objects(expires_at);
