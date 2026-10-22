CREATE TABLE playback_execution_leases (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  course_id text NOT NULL CHECK (course_id ~ '^[1-9][0-9]{0,15}$'),
  module_item_id text NOT NULL CHECK (module_item_id ~ '^[1-9][0-9]{0,15}$'),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_kind text NOT NULL CHECK (owner_kind IN ('manual','worker')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX playback_execution_leases_expiry_idx ON playback_execution_leases(expires_at);
