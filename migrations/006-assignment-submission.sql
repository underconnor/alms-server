CREATE TABLE assignment_uploads (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL, assignment_id text NOT NULL, generation uuid NOT NULL,
  metadata_enc text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 20971520),
  state text NOT NULL CHECK(state IN ('reserved','uploading','ready','consumed')),
  received_bytes integer NOT NULL DEFAULT 0 CHECK(received_bytes>=0),
  chunk_count integer NOT NULL DEFAULT 0, sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX assignment_upload_owner ON assignment_uploads(user_id, expires_at);
CREATE TABLE assignment_upload_chunks (
  upload_id uuid NOT NULL REFERENCES assignment_uploads(id) ON DELETE CASCADE,
  sequence integer NOT NULL, encrypted_data text NOT NULL, PRIMARY KEY(upload_id,sequence)
);
CREATE TABLE assignment_operations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL, assignment_id text NOT NULL, generation uuid NOT NULL,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL, input_enc text,
  submission_type text NOT NULL CHECK(submission_type IN ('online_upload','online_text_entry','online_url')),
  state text NOT NULL CHECK(state IN ('preparing','sending','confirmed','rejected','needs_confirmation')),
  private_receipt_enc text, public_receipt jsonb, error_code text,
  worker_token uuid, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX assignment_operation_owner ON assignment_operations(user_id,course_id,assignment_id,created_at DESC);
CREATE UNIQUE INDEX assignment_one_active_operation ON assignment_operations(user_id,course_id,assignment_id)
  WHERE state IN ('preparing','sending','needs_confirmation');
