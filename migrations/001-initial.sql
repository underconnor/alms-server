CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  identity_provider text NOT NULL,
  identity_subject text NOT NULL,
  display_name text,
  analytics_id uuid NOT NULL UNIQUE,
  analytics_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(identity_provider, identity_subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  analytics_session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS todos (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 240), completed boolean NOT NULL DEFAULT false,
  due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX todos_owner_idx ON todos(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS playback_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL, lecture_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','cancelled','reconciling','succeeded','failed','needs_reauthentication','needs_verification')),
  scheduled_for timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  school_result jsonb, error_code text,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL,
  heartbeat_at timestamptz,
  UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX playback_active_lecture_idx ON playback_jobs(user_id,lecture_id)
 WHERE status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','reconciling','needs_verification');
CREATE INDEX playback_jobs_owner_idx ON playback_jobs(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS job_outbox (
  job_id uuid PRIMARY KEY REFERENCES playback_jobs(id) ON DELETE CASCADE,
  dispatched_at timestamptz
);
CREATE TABLE IF NOT EXISTS analytics_receipts (
  event_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now()
);
