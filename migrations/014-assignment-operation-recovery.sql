-- Legacy rows deliberately keep NULL execution evidence. Receipt absence is not backfilled as proof.
ALTER TABLE assignment_operations
  ADD COLUMN execution_protocol smallint CHECK(execution_protocol IS NULL OR execution_protocol=1),
  ADD COLUMN final_write_started_at timestamptz,
  ADD COLUMN execution_finished_at timestamptz,
  ADD COLUMN failure_diagnostic jsonb,
  ADD COLUMN school_observation jsonb,
  ADD COLUMN observation_generation uuid,
  ADD COLUMN recovery_kind text CHECK(recovery_kind IS NULL OR recovery_kind IN ('upload_failed_before_submit','school_submission_present')),
  ADD COLUMN recovery_released_at timestamptz,
  ADD CONSTRAINT assignment_recovery_release_pair CHECK((recovery_kind IS NULL)=(recovery_released_at IS NULL));
DROP INDEX assignment_one_active_operation;
CREATE UNIQUE INDEX assignment_one_active_operation ON assignment_operations(user_id,course_id,assignment_id)
  WHERE state IN ('preparing','sending','needs_confirmation') AND recovery_released_at IS NULL;
