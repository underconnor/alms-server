ALTER TABLE playback_jobs
  ADD COLUMN accepted_generation uuid,
  ADD COLUMN execution_token_hash text CHECK (execution_token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN execution_outcome text CHECK (execution_outcome IN ('not_started','ended','interrupted')),
  ADD CONSTRAINT playback_execution_requires_admission CHECK (execution_token_hash IS NULL OR accepted_generation IS NOT NULL);
ALTER TABLE playback_jobs DROP CONSTRAINT playback_jobs_status_check;
ALTER TABLE playback_jobs ADD CONSTRAINT playback_jobs_status_check CHECK
  (status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','cancelled','reconciling','succeeded','completed','failed','needs_reauthentication','needs_verification'));
-- No legacy generation backfill or lease deletion. The new worker quarantines legacy jobs before dispatch.
