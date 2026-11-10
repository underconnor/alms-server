import { publicJob, type Job, type JobStatus } from './domain.js';
import { validPlaybackObservation } from './playback-progress.js';

export const playbackQueueLimit = 200;
export const activePlaybackQueueStatuses = ['running', 'reconciling', 'cancel_requested', 'pause_requested'] as const;
export const pendingPlaybackQueueStatuses = ['queued', 'scheduled', 'paused'] as const;
export type PlaybackQueueWorkerState = 'ready' | 'unavailable' | 'disabled';
export type PlaybackQueueWaitReason = 'authentication_wait' | 'scheduled' | 'paused' |
  'start_permission_expired' | 'worker_unavailable' | 'waiting';
export type PlaybackQueueEstimateReason = 'estimated' | 'not_waiting' | 'not_due' | 'authentication_wait' |
  'permission_unavailable' | 'worker_unavailable' | 'legacy_delivery' | 'execution_blocked' | 'stale_progress' |
  'unknown_duration' | 'unknown_queue_state' | 'permission_expires_before_start';
export interface PlaybackQueueForecast {
  activeCount: number; activeStatus: JobStatus | null; activeObservation: unknown; blockingLease: boolean;
  entries: Record<string, { position: number; priorDuration: number; unknownPrior: boolean; legacy: boolean;
    permissionInvalid: boolean; priorPermissionInvalid: boolean; minimumPriorExpiry: string | null }>;
}
export interface PlaybackQueueSnapshot {
  jobs: Job[];
  counts: { active: number; waiting: number; total: number };
  serverTime: string;
  complete: boolean;
  hasMore: boolean;
  limit: number;
  /** Internal aggregates only. Never return other owners' jobs or media observations. */
  forecast?: PlaybackQueueForecast;
}

export function playbackQueueEstimate(job: Job, snapshot: PlaybackQueueSnapshot, worker: PlaybackQueueWorkerState) {
  const absent = (estimateReason: PlaybackQueueEstimateReason, position: number | null = null) =>
    ({ position, estimatedStartAt: null as string | null, estimateReason });
  const wait = playbackQueueWaitReason(job, snapshot.serverTime, worker);
  if (wait === null || wait === 'paused') return absent('not_waiting');
  if (wait === 'authentication_wait') return absent('authentication_wait');
  if (wait === 'start_permission_expired') return absent('permission_unavailable');
  if (wait === 'scheduled') return absent('not_due');
  if (worker !== 'ready') return absent('worker_unavailable');
  const forecast = snapshot.forecast, entry = forecast?.entries[job.id];
  if (!forecast || !entry || !Number.isSafeInteger(entry.position) || entry.position < 1) return absent('unknown_queue_state');
  if (entry.legacy) return absent('legacy_delivery');
  if (entry.permissionInvalid || entry.priorPermissionInvalid) return absent('permission_unavailable');
  if (forecast.blockingLease || forecast.activeCount > 1) return absent('execution_blocked');
  const position = entry.position, now = Date.parse(snapshot.serverTime);
  let remaining = 0;
  if (forecast.activeCount === 1) {
    if (forecast.activeStatus !== 'running') return absent('execution_blocked', position);
    const observation = forecast.activeObservation;
    if (!validPlaybackObservation(observation) || now - Date.parse(observation.observedAt) >= 15000
      || Date.parse(observation.observedAt) - now > 1000 || observation.paused || observation.ended)
      return absent('stale_progress', position);
    // Last real media sample only. Do not extrapolate the position with elapsed wall time.
    remaining = Math.max(0, observation.durationSeconds - observation.positionSeconds);
  }
  if (entry.unknownPrior || !Number.isFinite(entry.priorDuration) || entry.priorDuration < 0) return absent('unknown_duration', position);
  const estimated = now + (remaining + entry.priorDuration) * 1000;
  if (!Number.isFinite(estimated) || Math.abs(estimated) > 8.64e15) return absent('unknown_queue_state', position);
  if (job.startConsent && Date.parse(job.startConsent.expiresAt) <= estimated
    || entry.minimumPriorExpiry && Date.parse(entry.minimumPriorExpiry) <= estimated)
    return absent('permission_expires_before_start', position);
  return { position, estimatedStartAt: new Date(estimated).toISOString(), estimateReason: 'estimated' as const };
}
const active = new Set<JobStatus>(activePlaybackQueueStatuses);

/** Display hints from a stored snapshot, never execution authority or a scheduler prediction. */
export function playbackQueueWaitReason(job: Job, serverTime: string, worker: PlaybackQueueWorkerState): PlaybackQueueWaitReason | null {
  if (active.has(job.status)) return null;
  if (job.authWait && job.authWait.continuedAsJobId === null) return 'authentication_wait';
  if (job.status === 'paused') return 'paused';
  const now = Date.parse(serverTime);
  if (job.startConsent?.attempt === 'not_attempted' && Date.parse(job.startConsent.expiresAt) <= now) return 'start_permission_expired';
  if (Date.parse(job.scheduledFor) > now) return 'scheduled';
  if (worker !== 'ready') return 'worker_unavailable';
  return 'waiting';
}

export function publicPlaybackQueue(snapshot: PlaybackQueueSnapshot, worker: PlaybackQueueWorkerState) {
  return {
    items: snapshot.jobs.map(job => ({ job: publicJob(job), notBefore: job.scheduledFor,
      waitReason: playbackQueueWaitReason(job, snapshot.serverTime, worker), ...playbackQueueEstimate(job, snapshot, worker) })),
    counts: { ...snapshot.counts }, complete: snapshot.complete, hasMore: snapshot.hasMore,
    limit: snapshot.limit, serverTime: snapshot.serverTime, worker: { state: worker },
  };
}
