-- Additive display observations. No existing jobs or school results are rewritten.
CREATE TABLE playback_job_progress (
  job_id uuid PRIMARY KEY REFERENCES playback_jobs(id) ON DELETE CASCADE,
  execution_token_hash text NOT NULL CHECK (execution_token_hash ~ '^[a-f0-9]{64}$'),
  observation jsonb,
  report_ack jsonb,
  CHECK (observation IS NOT NULL OR report_ack IS NOT NULL),
  CHECK (observation IS NULL OR jsonb_typeof(observation)='object'),
  CHECK (report_ack IS NULL OR jsonb_typeof(report_ack)='object')
);
