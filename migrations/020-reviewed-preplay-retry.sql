-- Empty, operator-reviewed permissions only. No legacy row or runtime proof is backfilled.
ALTER TABLE playback_jobs ADD COLUMN reviewed_preplay_release_id uuid,
  ADD CONSTRAINT playback_preplay_marker_scope UNIQUE(id,reviewed_preplay_release_id),
  ADD CONSTRAINT playback_preplay_request_scope UNIQUE(id,user_id,idempotency_key,request_hash),
  ADD CONSTRAINT playback_preplay_released_shape CHECK (reviewed_preplay_release_id IS NULL OR
    (status='needs_verification' AND execution_outcome IS NOT DISTINCT FROM 'not_started'
      AND error_code IS NOT DISTINCT FROM 'SCHOOL_RESULT_UNKNOWN' AND school_result IS NULL
      AND execution_token_hash IS NULL AND last_execution_token_hash IS NOT NULL
      AND accepted_generation IS NOT NULL AND settled_at IS NULL AND settled_execution_token_hash IS NULL));

CREATE FUNCTION reviewed_preplay_job_fingerprint(playback_jobs) RETURNS text LANGUAGE sql STABLE STRICT SET TimeZone='UTC' AS $$
  SELECT encode(sha256(convert_to((to_jsonb($1)-'reviewed_preplay_release_id')::text,'UTF8')),'hex')
$$;

CREATE TABLE playback_preplay_review_permits (
  id uuid PRIMARY KEY, parent_job_id uuid NOT NULL,
  user_id uuid NOT NULL, course_id text NOT NULL, lecture_id text NOT NULL, accepted_generation uuid NOT NULL,
  original_version timestamptz NOT NULL, original_fingerprint text NOT NULL CHECK(original_fingerprint ~ '^[a-f0-9]{64}$'),
  source_commit text NOT NULL CHECK(source_commit='5a34c091011498757d6ecd2a7da8b5d7761db3a1'),
  source_archive_sha256 text NOT NULL CHECK(source_archive_sha256='66658249a904dde001ab892cac1ba9d3e8c49f60aa2131972ac6cc955d4d9839'),
  source_manifest_sha256 text NOT NULL CHECK(source_manifest_sha256='30f574888fbbf2a97d5be5a102bff1d420ba5dc352bf4531c72bd8826bd3b48e'),
  worker_image_sha256 text NOT NULL CHECK(worker_image_sha256='61a6db4b70a3d36da3d8c0537d59114a8b8195f67baeecd4317b692464b38449'),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
  FOREIGN KEY(parent_job_id,user_id,course_id,lecture_id,accepted_generation)
    REFERENCES playback_jobs(id,user_id,course_id,lecture_id,accepted_generation),
  UNIQUE(id,parent_job_id,user_id,course_id,lecture_id,accepted_generation)
);
CREATE INDEX playback_preplay_permits_parent_idx ON playback_preplay_review_permits(parent_job_id,created_at DESC);

ALTER TABLE playback_job_start_consents ADD CONSTRAINT playback_start_binding_scope
  UNIQUE(job_id,consent_id,course_id,lecture_id);
CREATE TABLE playback_preplay_releases (
  id uuid PRIMARY KEY, parent_job_id uuid NOT NULL UNIQUE, child_job_id uuid NOT NULL UNIQUE,
  permit_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL, course_id text NOT NULL, lecture_id text NOT NULL,
  previous_generation uuid NOT NULL, current_generation uuid NOT NULL, client_id text,
  start_consent_id uuid NOT NULL, request_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(parent_job_id<>child_job_id AND previous_generation<>current_generation),
  UNIQUE(parent_job_id,id), UNIQUE(user_id,request_key),
  FOREIGN KEY(permit_id,parent_job_id,user_id,course_id,lecture_id,previous_generation)
    REFERENCES playback_preplay_review_permits(id,parent_job_id,user_id,course_id,lecture_id,accepted_generation),
  FOREIGN KEY(parent_job_id,id) REFERENCES playback_jobs(id,reviewed_preplay_release_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(child_job_id,user_id,course_id,lecture_id,current_generation)
    REFERENCES playback_jobs(id,user_id,course_id,lecture_id,accepted_generation) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(child_job_id,user_id,request_key,request_hash)
    REFERENCES playback_jobs(id,user_id,idempotency_key,request_hash) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(child_job_id,start_consent_id,course_id,lecture_id)
    REFERENCES playback_job_start_consents(job_id,consent_id,course_id,lecture_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE playback_jobs ADD CONSTRAINT playback_preplay_release_fk
  FOREIGN KEY(id,reviewed_preplay_release_id) REFERENCES playback_preplay_releases(parent_job_id,id);

CREATE FUNCTION validate_reviewed_preplay_parent(parent playback_jobs) RETURNS boolean LANGUAGE sql STABLE SET TimeZone='UTC' AS $$
  SELECT parent.status='needs_verification' AND parent.execution_outcome IS NOT DISTINCT FROM 'not_started'
    AND parent.error_code IS NOT DISTINCT FROM 'SCHOOL_RESULT_UNKNOWN' AND parent.school_result IS NULL
    AND parent.execution_token_hash IS NULL AND parent.last_execution_token_hash IS NOT NULL
    AND parent.accepted_generation IS NOT NULL AND parent.settled_at IS NULL AND parent.settled_execution_token_hash IS NULL
    AND parent.reviewed_preplay_release_id IS NULL
    AND parent.created_at>='2026-11-06T15:15:05.866875Z'::timestamptz
    AND parent.updated_at<'2026-11-09T02:58:38.558621Z'::timestamptz
    AND NOT EXISTS(SELECT 1 FROM playback_auth_waits WHERE job_id=parent.id)
    AND NOT EXISTS(SELECT 1 FROM playback_job_progress WHERE job_id=parent.id)
    AND NOT EXISTS(SELECT 1 FROM playback_job_start_consents WHERE job_id=parent.id)
    AND NOT EXISTS(SELECT 1 FROM playback_start_attempts WHERE job_id=parent.id)
    AND NOT EXISTS(SELECT 1 FROM playback_execution_terminations WHERE job_id=parent.id)
    AND NOT EXISTS(SELECT 1 FROM playback_job_settlements WHERE job_id=parent.id)
$$;
CREATE FUNCTION validate_preplay_review_permit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent playback_jobs;
BEGIN
  SELECT * INTO parent FROM playback_jobs WHERE id=NEW.parent_job_id FOR SHARE;
  IF NOT FOUND OR validate_reviewed_preplay_parent(parent) IS DISTINCT FROM true
    OR parent.updated_at IS DISTINCT FROM NEW.original_version
    OR reviewed_preplay_job_fingerprint(parent) IS DISTINCT FROM NEW.original_fingerprint THEN
    RAISE EXCEPTION 'reviewed preplay parent changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playback_preplay_permit_validate BEFORE INSERT ON playback_preplay_review_permits
  FOR EACH ROW EXECUTE FUNCTION validate_preplay_review_permit();
CREATE FUNCTION validate_preplay_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent playback_jobs; permit playback_preplay_review_permits;
BEGIN
  SELECT * INTO parent FROM playback_jobs WHERE id=NEW.parent_job_id FOR SHARE;
  SELECT * INTO permit FROM playback_preplay_review_permits WHERE id=NEW.permit_id FOR SHARE;
  IF permit.id IS NULL OR permit.expires_at<=clock_timestamp()
    OR validate_reviewed_preplay_parent(parent) IS DISTINCT FROM true
    OR parent.updated_at IS DISTINCT FROM permit.original_version
    OR reviewed_preplay_job_fingerprint(parent) IS DISTINCT FROM permit.original_fingerprint THEN
    RAISE EXCEPTION 'reviewed preplay permission changed' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM playback_start_consents c WHERE c.id=NEW.start_consent_id
    AND c.user_id=NEW.user_id AND c.client_id IS NOT DISTINCT FROM NEW.client_id
    AND c.generation=NEW.current_generation AND c.course_id=NEW.course_id AND NEW.lecture_id=ANY(c.lecture_ids)
    AND c.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id)) THEN
    RAISE EXCEPTION 'reviewed preplay consent is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playback_preplay_release_validate BEFORE INSERT ON playback_preplay_releases
  FOR EACH ROW EXECUTE FUNCTION validate_preplay_release();
CREATE TRIGGER playback_preplay_permit_immutable BEFORE UPDATE OR DELETE ON playback_preplay_review_permits
  FOR EACH ROW EXECUTE FUNCTION preserve_playback_recovery_evidence();
CREATE TRIGGER playback_preplay_release_immutable BEFORE UPDATE OR DELETE ON playback_preplay_releases
  FOR EACH ROW EXECUTE FUNCTION preserve_playback_recovery_evidence();
CREATE FUNCTION preserve_preplay_released_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reviewed_preplay_release_id IS NOT NULL OR
    (to_jsonb(NEW)-'reviewed_preplay_release_id') IS DISTINCT FROM (to_jsonb(OLD)-'reviewed_preplay_release_id') THEN
    RAISE EXCEPTION 'reviewed preplay history is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playback_preplay_parent_immutable BEFORE UPDATE ON playback_jobs
  FOR EACH ROW WHEN (OLD.reviewed_preplay_release_id IS NOT NULL OR NEW.reviewed_preplay_release_id IS NOT NULL)
  EXECUTE FUNCTION preserve_preplay_released_parent();

DROP INDEX playback_active_lecture_idx;
CREATE UNIQUE INDEX playback_active_lecture_idx ON playback_jobs(user_id,course_id,lecture_id)
  WHERE status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','reconciling')
    OR (status='needs_verification' AND settled_at IS NULL AND reviewed_preplay_release_id IS NULL);
