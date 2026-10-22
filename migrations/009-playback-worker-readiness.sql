-- Private, short-lived process readiness. No user or school authentication data.
CREATE TABLE playback_worker_readiness (
  instance_id uuid PRIMARY KEY,
  backend_commit text NOT NULL CHECK (backend_commit ~ '^[0-9a-f]{40}$'),
  sdk_sha256 text NOT NULL CHECK (sdk_sha256 ~ '^[0-9a-f]{64}$'),
  ready_until timestamptz NOT NULL
);
CREATE INDEX playback_worker_ready_release ON playback_worker_readiness (backend_commit, sdk_sha256, ready_until);
