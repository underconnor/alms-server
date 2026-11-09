-- Durable, explicit continuation only. No historical job is marked or rewritten.
CREATE TABLE playback_auth_waits (
  job_id uuid PRIMARY KEY REFERENCES playback_jobs(id) ON DELETE CASCADE,
  blocked_by_job_id uuid NOT NULL REFERENCES playback_jobs(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('school_auth_required','school_session_changed')),
  waiting_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  original_status text NOT NULL CHECK (original_status IN ('queued','scheduled','needs_reauthentication','needs_verification')),
  original_error_code text,
  continued_job_id uuid UNIQUE REFERENCES playback_jobs(id) ON DELETE RESTRICT,
  continued_at timestamptz,
  CHECK ((continued_job_id IS NULL) = (continued_at IS NULL)),
  CHECK (continued_job_id IS NULL OR continued_job_id<>job_id)
);
CREATE INDEX playback_auth_waits_blocked_by_idx ON playback_auth_waits(blocked_by_job_id);
CREATE FUNCTION preserve_playback_auth_wait() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.blocked_by_job_id IS DISTINCT FROM OLD.blocked_by_job_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.waiting_since IS DISTINCT FROM OLD.waiting_since
    OR NEW.original_status IS DISTINCT FROM OLD.original_status OR NEW.original_error_code IS DISTINCT FROM OLD.original_error_code
    OR (OLD.continued_job_id IS NOT NULL AND (NEW.continued_job_id IS DISTINCT FROM OLD.continued_job_id OR NEW.continued_at IS DISTINCT FROM OLD.continued_at)) THEN
    RAISE EXCEPTION 'playback authentication wait evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playback_auth_wait_immutable BEFORE UPDATE ON playback_auth_waits
  FOR EACH ROW EXECUTE FUNCTION preserve_playback_auth_wait();
