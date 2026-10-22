export type JobStatus = 'queued' | 'scheduled' | 'running' | 'pause_requested' | 'paused' |
  'cancel_requested' | 'cancelled' | 'reconciling' | 'succeeded' | 'completed' | 'failed' |
  'needs_reauthentication' | 'needs_verification';

export interface SchoolResult {
  observedAt: string;
  progressPercent: number | null;
  attendance: 'present' | 'absent' | 'late' | 'pending' | 'not_applicable' | 'unknown';
  recognized: boolean | null;
  // Read-only school observations. Completion/progress do not establish attendance recognition.
  evidence?: import('./learning-status.js').LearningEvidence;
}
export interface Job {
  id: string; userId: string; courseId: string; lectureId: string; status: JobStatus;
  scheduledFor: string; createdAt: string; updatedAt: string;
  schoolResult: SchoolResult | null; errorCode: string | null;
  idempotencyKey: string; requestHash: string;
  // Internal execution authority; never included in publicJob.
  acceptedGeneration: string | null; executionTokenHash: string | null;
  executionOutcome: ExecutionOutcome | null;
  // Additive recovery metadata. It never replaces the original execution/school history.
  lastExecutionTokenHash?: string | null;
  settledAt?: string | null;
  settlement?: JobSettlement | null;
  recovery?: JobRecovery;
}
export type JobRecoveryReason = 'eligible' | 'already_settled' | 'not_interrupted' | 'termination_unconfirmed' | 'execution_active' | 'lease_active';
export interface JobRecovery { eligible: boolean; reason: JobRecoveryReason; version: string }
export interface JobSettlement { settledAt: string; schoolResult: SchoolResult }
export type ExecutionOutcome = 'not_started' | 'ended' | 'interrupted';
export interface Todo {
  id: string; title: string; completed: boolean; dueAt: string | null;
  createdAt: string; updatedAt: string;
}
// Personal study planning only. This does not establish school completion,
// attendance, submission, or eligibility for playback.
export interface PersonalCompletion {
  courseId: string; activityId: string; completed: boolean; updatedAt: string;
}
export interface User { id: string; displayName: string | null; analyticsId: string; analyticsEnabled: boolean }
export interface Session {
  tokenHash: string; csrfToken: string; analyticsSessionId: string;
  expiresAt: string; user: User;
  clientId?: string | null;
}

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'cancelled'], scheduled: ['running', 'cancelled'],
  running: ['cancel_requested', 'pause_requested', 'reconciling', 'failed', 'needs_reauthentication', 'needs_verification'],
  pause_requested: ['paused', 'cancel_requested', 'needs_verification'],
  paused: ['queued', 'cancelled'],
  cancel_requested: ['cancelled', 'needs_verification'],
  reconciling: ['succeeded', 'completed', 'cancel_requested', 'failed', 'needs_reauthentication', 'needs_verification'],
  succeeded: [], completed: [], failed: [], cancelled: [], needs_reauthentication: [], needs_verification: [],
};
export function canTransition(from: JobStatus, to: JobStatus): boolean { return transitions[from].includes(to); }
export function resultStatus(result: SchoolResult | null, outcome: ExecutionOutcome | null): JobStatus {
  if (!result) return 'needs_verification';
  if (result.recognized === true && (outcome === 'ended' || outcome === 'not_started')) return 'succeeded';
  return outcome === 'ended' ? 'completed' : 'needs_verification';
}
export function publicJob(job: Job) {
  return { id: job.id, courseId: job.courseId, lectureId: job.lectureId, status: job.status,
    scheduledFor: job.scheduledFor, createdAt: job.createdAt, updatedAt: job.updatedAt,
    schoolResult: job.schoolResult, errorCode: job.errorCode, executionOutcome: job.executionOutcome ?? null,
    ...(job.recovery ? { settledAt: job.settledAt ?? null, settlement: job.settlement ?? null, recovery: job.recovery } : {}) };
}
