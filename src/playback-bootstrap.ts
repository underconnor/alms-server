import { AppError } from './errors.js';
import { PgPlaybackLeaseRepository } from './manual-video-lease.js';
import { createSchoolVideoSessions } from './school-video-session.js';
import { createSchoolPlayback, type SchoolPlaybackDependencies } from './school-playback.js';
import { createControlledPlaybackRuntime, createControlledPlaybackSource } from './controlled-playback-runtime.js';
import { createPlaybackAdmission, createPlaybackFinalProof, claimMatchesJob, type WorkerClaim } from './playback-authority.js';
import type { PgStore } from './store.js';
import type { SchoolProvider } from './provider.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import { createPlaybackProgressRecorder } from './playback-progress.js';

export function createWorkerClaimValidator(store: Pick<PgStore, 'getWorkerJob'> & Partial<Pick<PgStore,'validatePlaybackStartConsent'>>, mode: 'execution' | 'final', key?:Buffer) {
  return async (claim: WorkerClaim, signal: AbortSignal): Promise<void> => {
    const current = await boundedWorkerOperation(bounded => store.getWorkerJob(claim, { signal: bounded, timeoutMs: 5000 }), { signal, timeoutMs: 5000 });
    signal.throwIfAborted();
    const allowed = mode === 'execution' ? ['running'] : ['running', 'reconciling', 'cancel_requested'];
    if (!current || !claimMatchesJob(claim, current) || !allowed.includes(current.status))
      throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '작업 실행 권한이 변경됐습니다.');
    if(mode==='execution'&&key&&store.validatePlaybackStartConsent)await store.validatePlaybackStartConsent(claim,key,{signal,timeoutMs:5000});
  };
}
/** Trusted process wiring. Browser session authorization is supplied only by the API admission route. */
export function withSchoolPlayback(provider: SchoolProvider, store: PgStore, key: Buffer,
  invalidate: (owner: string, courseId: string, activityId: string) => Promise<void>,
  reportFailure?: SchoolPlaybackDependencies<unknown, unknown, unknown>['reportFailure'],
  reportAcknowledged?: SchoolPlaybackDependencies<unknown, unknown, unknown>['reportAcknowledged']): SchoolProvider {
  const runtime = createControlledPlaybackRuntime();
  const progress = createPlaybackProgressRecorder(store);
  const playback = createSchoolPlayback({
    school: createSchoolVideoSessions(store, key, invalidate, undefined, { allowReadystreamWorker: true }),
    leases: new PgPlaybackLeaseRepository(store.pool),
    validateClaim: createWorkerClaimValidator(store, 'execution',key),
    validateFinalClaim: createWorkerClaimValidator(store, 'final'),
    createAdmission: createPlaybackAdmission,
    createFinalProof: createPlaybackFinalProof,
    runtime: { createSource: createControlledPlaybackSource, play: runtime.play, dispose: runtime.dispose },
    reservePlaybackStart:(claim,signal)=>store.reservePlaybackStart(claim,key,{signal,timeoutMs:5000}),
    observePlaybackStartTransportAck:(claim,id,signal)=>store.recordPlaybackStartTransportAck(claim,id,{signal,timeoutMs:5000}),
    finishPlaybackStart:(claim,id,outcome,signal)=>store.finishPlaybackStart(claim,id,outcome,key,{signal,timeoutMs:5000}),
    reportFailure,
    reportAcknowledged,
    observeProgress: (claim, observation) => progress.observe(claim, observation),
    progressReportAcknowledged: (claim, event) => progress.acknowledge(claim, event),
    flushProgress: claim => progress.flushAndStop(claim),
  });
  return { ...provider, ...playback, capabilities: { ...provider.capabilities, playback: true, pauseResume: false } };
}
