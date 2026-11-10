-- Scheduling metadata only. Do not backfill or rewrite historical playback rows.
CREATE TABLE playback_queue_metadata (
  job_id uuid PRIMARY KEY REFERENCES playback_jobs(id) ON DELETE CASCADE,
  duration_seconds double precision CHECK(duration_seconds > 0 AND duration_seconds <= 14400),
  dispatch_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX playback_queue_ready_order_idx ON playback_jobs(created_at,id)
  WHERE status IN ('queued','scheduled') AND accepted_generation IS NOT NULL;
