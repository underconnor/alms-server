CREATE TABLE IF NOT EXISTS login_attempts (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempt_expiry_idx ON login_attempts(expires_at);
CREATE TABLE IF NOT EXISTS school_sessions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,provider)
);
