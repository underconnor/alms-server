-- Additive client binding. Existing cookie sessions and login attempts remain valid.
ALTER TABLE sessions ADD COLUMN client_id text;
ALTER TABLE login_attempts ADD COLUMN client_context jsonb;
CREATE TABLE frontend_auth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  session_token_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  encrypted_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX frontend_auth_code_expiry_idx ON frontend_auth_codes(expires_at);
