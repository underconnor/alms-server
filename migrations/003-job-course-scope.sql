DROP INDEX playback_active_lecture_idx;
CREATE UNIQUE INDEX playback_active_lecture_idx ON playback_jobs(user_id,course_id,lecture_id)
 WHERE status IN ('queued','scheduled','running','pause_requested','paused','cancel_requested','reconciling','needs_verification');
