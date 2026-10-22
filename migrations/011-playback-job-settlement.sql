-- No legacy attempt/proof/settlement backfill. Expiry and stale recovery are not termination.
ALTER TABLE playback_jobs ADD COLUMN last_execution_token_hash text CHECK (last_execution_token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN settled_execution_token_hash text CHECK (settled_execution_token_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT playback_settlement_terminal CHECK (
    (settled_at IS NULL AND settled_execution_token_hash IS NULL) OR
    (settled_at IS NOT NULL AND status='needs_verification' AND execution_outcome IS NOT DISTINCT FROM 'interrupted'
      AND execution_token_hash IS NULL AND last_execution_token_hash IS NOT NULL AND settled_execution_token_hash IS NOT NULL
      AND settled_execution_token_hash=last_execution_token_hash)),
  ADD CONSTRAINT playback_job_termination_scope UNIQUE(id,user_id,course_id,lecture_id,accepted_generation);

CREATE TABLE playback_execution_terminations (
  job_id uuid NOT NULL REFERENCES playback_jobs(id) ON DELETE RESTRICT,
  execution_token_hash text NOT NULL CHECK (execution_token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  course_id text NOT NULL, lecture_id text NOT NULL, accepted_generation uuid NOT NULL,
  terminated_at timestamptz NOT NULL,
  PRIMARY KEY(job_id,execution_token_hash),
  FOREIGN KEY(job_id,user_id,course_id,lecture_id,accepted_generation)
    REFERENCES playback_jobs(id,user_id,course_id,lecture_id,accepted_generation)
);

CREATE TABLE playback_job_settlements (
  job_id uuid PRIMARY KEY REFERENCES playback_jobs(id) ON DELETE RESTRICT,
  execution_token_hash text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  current_generation uuid NOT NULL,
  school_result jsonb NOT NULL,
  UNIQUE(job_id,execution_token_hash,settled_at),
  FOREIGN KEY(job_id,execution_token_hash)
    REFERENCES playback_execution_terminations(job_id,execution_token_hash) ON DELETE RESTRICT
);
ALTER TABLE playback_jobs ADD CONSTRAINT playback_settlement_proof_fk
  FOREIGN KEY(id,settled_execution_token_hash)
    REFERENCES playback_execution_terminations(job_id,execution_token_hash),
  ADD CONSTRAINT playback_settlement_record_fk
    FOREIGN KEY(id,settled_execution_token_hash,settled_at) REFERENCES playback_job_settlements(job_id,execution_token_hash,settled_at);

CREATE FUNCTION preserve_playback_recovery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'playback recovery evidence is immutable'; END $$;
CREATE TRIGGER playback_termination_immutable BEFORE UPDATE OR DELETE ON playback_execution_terminations
  FOR EACH ROW EXECUTE FUNCTION preserve_playback_recovery_evidence();
CREATE TRIGGER playback_settlement_immutable BEFORE UPDATE OR DELETE ON playback_job_settlements
  FOR EACH ROW EXECUTE FUNCTION preserve_playback_recovery_evidence();
CREATE TRIGGER playback_settled_marker_immutable BEFORE UPDATE ON playback_jobs
  FOR EACH ROW WHEN (OLD.settled_at IS NOT NULL AND
    (NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.settled_execution_token_hash IS DISTINCT FROM OLD.settled_execution_token_hash))
  EXECUTE FUNCTION preserve_playback_recovery_evidence();

DROP INDEX playback_active_lecture_idx;
CREATE UNIQUE INDEX playback_active_lecture_idx ON playback_jobs(user_id,course_id,lecture_id)
  WHERE status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','reconciling')
    OR (status='needs_verification' AND settled_at IS NULL);
