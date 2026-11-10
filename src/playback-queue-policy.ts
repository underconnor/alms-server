import { randomUUID } from 'node:crypto';
import type { WorkerQuery } from './worker-bounds.js';

/** Every production queue delivery/dispatch uses this fence before owner/row locks. */
export const playbackQueueLock = "SELECT pg_advisory_xact_lock(hashtextextended('alms-playback-global-queue-v1',0))";

/** A transport may be deferred/recovered only before any execution evidence exists. */
export const untouchedPlaybackQueueJob = `job.status IN ('queued','scheduled')
  AND job.accepted_generation IS NOT NULL AND job.execution_token_hash IS NULL
  AND job.last_execution_token_hash IS NULL AND job.heartbeat_at IS NULL
  AND job.execution_outcome IS NULL AND job.school_result IS NULL AND job.settled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM playback_job_progress observed WHERE observed.job_id=job.id)
  AND NOT EXISTS(SELECT 1 FROM playback_start_attempts attempted WHERE attempted.job_id=job.id)
  AND NOT EXISTS(SELECT 1 FROM playback_execution_terminations ended WHERE ended.job_id=job.id)
  AND NOT EXISTS(SELECT 1 FROM playback_job_settlements settled WHERE settled.job_id=job.id)`;

export const readyPlaybackQueueJob = `${untouchedPlaybackQueueJob}
  AND job.scheduled_for<=statement_timestamp()
  AND NOT EXISTS(SELECT 1 FROM playback_auth_waits waiting WHERE waiting.job_id=job.id AND waiting.continued_job_id IS NULL)`;

export const playbackQueueHead = `SELECT job.id,job.user_id FROM playback_jobs job
  WHERE ${readyPlaybackQueueJob} ORDER BY job.created_at ASC,job.id ASC LIMIT 1`;

export const playbackQueueBusy = `SELECT EXISTS(SELECT 1 FROM playback_jobs
  WHERE execution_token_hash IS NOT NULL OR status IN ('running','reconciling','cancel_requested','pause_requested'))
  OR EXISTS(SELECT 1 FROM playback_execution_leases WHERE expires_at>clock_timestamp()) AS busy`;

/** Caller holds scheduler then owner lock. Never recycle an execution or a newer delivery. */
export async function deferUntouchedPlaybackDelivery(query: WorkerQuery, jobId: string, deliveryId: string): Promise<boolean> {
  const job = await query(`SELECT job.id FROM playback_jobs job WHERE job.id=$1 AND ${untouchedPlaybackQueueJob} FOR UPDATE`, [jobId]);
  if (!job.rowCount) return false;
  const { rows: [metadata] } = await query('SELECT dispatch_id FROM playback_queue_metadata WHERE job_id=$1 FOR UPDATE', [jobId]);
  if (metadata ? metadata.dispatch_id !== deliveryId : jobId !== deliveryId) return false;
  await query(`INSERT INTO playback_queue_metadata(job_id,dispatch_id) VALUES($1,$2)
    ON CONFLICT(job_id) DO UPDATE SET dispatch_id=EXCLUDED.dispatch_id`, [jobId, randomUUID()]);
  await query('UPDATE job_outbox SET dispatched_at=NULL WHERE job_id=$1', [jobId]);
  return true;
}
