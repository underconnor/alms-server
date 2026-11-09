-- Exact explicit permissions only. No historical job is granted consent.
CREATE TABLE playback_start_consents (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), client_id text, generation uuid NOT NULL, course_id text NOT NULL,
 lecture_ids text[] NOT NULL CHECK (cardinality(lecture_ids) BETWEEN 1 AND 100), idempotency_key uuid NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '24 hours'), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE playback_start_consent_revocations (
 consent_id uuid PRIMARY KEY REFERENCES playback_start_consents(id), revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE playback_job_start_consents (
 job_id uuid PRIMARY KEY REFERENCES playback_jobs(id), consent_id uuid NOT NULL REFERENCES playback_start_consents(id),
 course_id text NOT NULL, lecture_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(consent_id,course_id,lecture_id)
);
CREATE TABLE playback_start_attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL UNIQUE REFERENCES playback_job_start_consents(job_id), user_id uuid NOT NULL REFERENCES users(id),
 generation uuid NOT NULL, course_id text NOT NULL, lecture_id text NOT NULL,
 execution_token_hash text NOT NULL CHECK (execution_token_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','acknowledged','unknown')),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz, transport_ack_received_at timestamptz, CHECK ((state='reserved')=(finished_at IS NULL))
);
CREATE FUNCTION preserve_playback_start_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'playback start consent evidence is immutable'; END $$;
CREATE TRIGGER playback_start_consent_immutable BEFORE UPDATE OR DELETE ON playback_start_consents FOR EACH ROW EXECUTE FUNCTION preserve_playback_start_consent();
CREATE TRIGGER playback_start_revocation_immutable BEFORE UPDATE OR DELETE ON playback_start_consent_revocations FOR EACH ROW EXECUTE FUNCTION preserve_playback_start_consent();
CREATE TRIGGER playback_start_binding_immutable BEFORE UPDATE OR DELETE ON playback_job_start_consents FOR EACH ROW EXECUTE FUNCTION preserve_playback_start_consent();
CREATE FUNCTION preserve_playback_start_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.transport_ack_received_at IS NULL AND NEW.transport_ack_received_at IS NOT NULL
  AND (to_jsonb(NEW)-'transport_ack_received_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'transport_ack_received_at') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' OR OLD.state<>'reserved' OR NEW.state NOT IN ('acknowledged','unknown') OR NEW.finished_at IS NULL
  OR (to_jsonb(NEW)-'state'-'finished_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'finished_at') THEN
  RAISE EXCEPTION 'playback start attempt evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER playback_start_attempt_immutable BEFORE UPDATE OR DELETE ON playback_start_attempts FOR EACH ROW EXECUTE FUNCTION preserve_playback_start_attempt();
