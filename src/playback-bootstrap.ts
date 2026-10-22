import { AppError } from './errors.js';
import { PgPlaybackLeaseRepository } from './manual-video-lease.js';
import { createSchoolVideoSessions } from './school-video-session.js';
import { createSchoolPlayback, type SchoolPlaybackDependencies } from './school-playback.js';
import { createControlledPlaybackRuntime, createControlledPlaybackSource } from './controlled-playback-runtime.js';
import { createPlaybackAdmission, createPlaybackFinalProof, claimMatchesJob, type WorkerClaim } from './playback-authority.js';
import type { PgStore } from './store.js';
import type { SchoolProvider } from './provider.js';
import { boundedWorkerOperation } from './worker-bounds.js';

export function createWorkerClaimValidator(store: Pick<PgStore, 'getWorkerJob'>, mode: 'execution' | 'final') {
  return async (claim: WorkerClaim, signal: AbortSignal): Promise<void> => {
    const current = await boundedWorkerOperation(bounded => store.getWorkerJob(claim, { signal: bounded, timeoutMs: 5000 }), { signal, timeoutMs: 5000 });
    signal.throwIfAborted();
    const allowed = mode === 'execution' ? ['running'] : ['running', 'reconciling', 'cancel_requested'];
    if (!current || !claimMatchesJob(claim, current) || !allowed.includes(current.status))
      throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '작업 실행 권한이 변경됐습니다.');
  };
}
/** Trusted process wiring. Browser session authorization is supplied only by the API admission route. */
export function withSchoolPlayback(provider: SchoolProvider, store: PgStore, key: Buffer,
  invalidate: (owner: string, courseId: string, activityId: string) => Promise<void>,
  reportFailure?: SchoolPlaybackDependencies<unknown, unknown, unknown>['reportFailure']): SchoolProvider {
  const runtime = createControlledPlaybackRuntime();
  const playback = createSchoolPlayback({
    school: createSchoolVideoSessions(store, key, invalidate),
    leases: new PgPlaybackLeaseRepository(store.pool),
    validateClaim: createWorkerClaimValidator(store, 'execution'),
    validateFinalClaim: createWorkerClaimValidator(store, 'final'),
    createAdmission: createPlaybackAdmission,
    createFinalProof: createPlaybackFinalProof,
    runtime: { createSource: createControlledPlaybackSource, play: runtime.play, dispose: runtime.dispose },
    reportFailure,
  });
  return { ...provider, ...playback, capabilities: { ...provider.capabilities, playback: true, pauseResume: false } };
}
