import { createPlaybackTerminationProof, type PlaybackTerminationProof } from './playback-termination.js';
import { inspect } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import { createVideoStreamer, type VideoRequest, type VideoResponse } from './video-stream.js';
import type { SchoolResult } from './domain.js';
import type { PreparedPlayback } from './provider.js';
import type { PlaybackLeaseRepository, PlaybackLeaseScope } from './manual-video-lease.js';
import type { ManualVideoObservation } from './manual-video-types.js';
import type { PreparedSchoolVideo, SchoolVideoSessions } from './school-video-session.js';
import { rememberVideoReportDiagnostic, rememberVideoReportPreparation, rememberVideoReportOutcomeFailure, workerVideoReportDiagnostic } from './video-report-diagnostics.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const claimSchema = z.object({ jobId: id, userId: id, courseId: id, lectureId: id,
  acceptedGeneration: z.uuid(), executionTokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Structurally identical to A's private WorkerClaim; never accepted from HTTP or queue payloads. */
export type SchoolPlaybackClaim = Readonly<z.infer<typeof claimSchema>>;
type SessionProof = { generation: string; encryptedSession: string };
type Target = { courseId: string; lectureId: string };
export interface SchoolPlaybackInput {
  expectedDurationSeconds: number;
  validate(signal: AbortSignal): Promise<void>;
  stream(request: VideoRequest): Promise<VideoResponse>;
  observe(value: ManualVideoObservation): void;
  report(event: 'playing' | 'update' | 'ended', signal: AbortSignal): Promise<void>;
}
export interface SchoolPlaybackRuntime<Source> {
  createSource(input: SchoolPlaybackInput): Source;
  play(source: Source, signal: AbortSignal): Promise<{ ended: true; browserClosed: true; processExited: true }>;
  dispose(source: Source): Promise<void>;
}
export interface SchoolPlaybackDependencies<Source, Admission, FinalProof> {
  school: SchoolVideoSessions;
  leases: PlaybackLeaseRepository;
  runtime: SchoolPlaybackRuntime<Source>;
  /** Worker-only DB claim check. It must not require a browser session. */
  validateClaim(claim: SchoolPlaybackClaim, signal: AbortSignal): Promise<void>;
  /** Final read/proof only, after confirmed runtime cleanup; may permit cancellation reconciliation. */
  validateFinalClaim(claim: SchoolPlaybackClaim, signal: AbortSignal): Promise<void>;
  createAdmission(scope: { userId: string } & Target, value: SessionProof): Admission;
  createFinalProof(claim: SchoolPlaybackClaim, value: SessionProof): FinalProof;
  stream?: ReturnType<typeof createVideoStreamer>;
  reportFailure?(diagnostic: ReturnType<typeof workerVideoReportDiagnostic>): void;
}
const changed = () => new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이나 작업 상태가 바뀌었습니다. 다시 확인해 주세요.');
const busy = () => new AppError(409, 'PLAYBACK_BUSY', '다른 영상이 실행 중입니다. 기존 재생이 종료된 뒤 다시 시도해 주세요.');
const unknown = (source?: unknown) => {
  const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', '학교 진도 보고 결과를 확인하지 못했습니다.');
  if (source !== undefined) rememberVideoReportDiagnostic(error, source);
  return error;
};
const normalize = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (error) {
    if (['authentication_required', 'identity_mismatch', 'SCHOOL_SESSION_CHANGED'].includes(String((error as { code?: unknown })?.code)))
      throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해 주세요.');
    throw error;
  }
};
const cleanup = () => new AppError(503, 'PLAYBACK_CLEANUP_FAILED', '영상 실행의 종료를 확인하지 못했습니다.');

/** School integration only. Runtime/proof factories are supplied by the trusted worker bootstrap. */
export function createSchoolPlayback<Source, Admission, FinalProof>(dependencies: SchoolPlaybackDependencies<Source, Admission, FinalProof>) {
  const { school, leases, runtime } = dependencies, stream = dependencies.stream ?? createVideoStreamer();
  type State = { claim: SchoolPlaybackClaim; driver: PreparedSchoolVideo; lease: PlaybackLeaseScope; source: Source;
    lifetime: AbortController; played: boolean; disposed: boolean; cleanupConfirmed: boolean; uncertain: boolean; reporting: boolean;
    callbacks: Set<Promise<unknown>>; runtimePending: boolean; runtimeStopped: boolean; closeSucceeded: boolean; termination?: PlaybackTerminationProof;
    disposePromise?: Promise<void>; reportPending?: Promise<void>; failure?: unknown; reportFailure?: unknown; ended: boolean; endedReport: boolean };
  const states = new WeakMap<PreparedPlayback, State>();
  const read = (prepared: PreparedPlayback) => { const state = states.get(prepared); if (!state) throw changed(); return state; };
  const claimCurrent = (claim: SchoolPlaybackClaim, signal: AbortSignal, phase: 'execution' | 'final' = 'execution') => boundedWorkerOperation(async bounded => {
    await (phase === 'execution' ? dependencies.validateClaim : dependencies.validateFinalClaim)(claim, bounded); bounded.throwIfAborted();
  }, { signal, timeoutMs: 5_000 });
  const authority = async (state: State, signal: AbortSignal, phase: 'execution' | 'final' = 'execution') => {
    if (phase === 'final' && !state.cleanupConfirmed) throw changed();
    const validate = () => claimCurrent(state.claim, signal, phase);
    const value = await state.driver.authority(validate, signal);
    if (value.generation !== state.claim.acceptedGeneration) throw changed();
    return value;
  };
  const guard = async (state: State, signal: AbortSignal) => {
    try {
      signal.throwIfAborted(); if (state.disposed || state.lifetime.signal.aborted) throw changed();
      await authority(state, signal);
      if (!await boundedWorkerOperation(bounded => leases.renew(state.lease, bounded), { signal, timeoutMs: 5_000 })) throw changed();
      await claimCurrent(state.claim, signal); signal.throwIfAborted();
      if (state.disposed || state.lifetime.signal.aborted) throw changed();
    } catch (error) { state.failure ??= error; throw error; }
  };
  const dispose = (state: State): Promise<void> => state.disposePromise ??= (async () => {
    state.disposed = true; state.uncertain ||= state.reporting; state.lifetime.abort();
    let closeFailed = false;
    try { state.driver.close(); state.closeSucceeded = true; } catch { state.uncertain = true; closeFailed = true; }
    // Runtime cleanup and report settlement run concurrently. B has a 7s hard cleanup
    // budget; this adapter stays below the runner's 10s limit including lease release.
    const settledReport = state.reportPending
      ? boundedWorkerOperation(() => state.reportPending!, { timeoutMs: 1_000 }).catch(() => { state.uncertain = true; })
      : Promise.resolve();
    try { await Promise.all([boundedWorkerOperation(() => runtime.dispose(state.source), { timeoutMs: 7_500 }), settledReport]); }
    catch { state.uncertain = true; throw cleanup(); }
    if (closeFailed) throw cleanup();
    state.runtimeStopped = true;
    // Retaining an uncertain report lease does not prevent a read-only final result check.
    if (!state.uncertain) await boundedWorkerOperation(signal => leases.release(state.lease, signal), { timeoutMs: 2_000 });
    state.cleanupConfirmed = true;
  })();
  const adapter = {
    async authorizePlayback(context: { userId: string }, target: Target, options: { signal: AbortSignal; validate: () => Promise<void> }): Promise<Admission> {
      return boundedWorkerOperation(async signal => {
        const driver = await school.prepare({ owner: context.userId, courseId: target.courseId, moduleItemId: target.lectureId }, options.validate, signal);
        try {
          signal.throwIfAborted();
          await driver.prepareMedia(options.validate, signal);
          const proof = await driver.authority(options.validate, signal); signal.throwIfAborted();
          return dependencies.createAdmission({ userId: context.userId, ...target }, proof);
        } finally { driver.close(); }
      }, { signal: options.signal, timeoutMs: 90_000 });
    },
    async preparePlayback(context: { userId: string; claim: SchoolPlaybackClaim }, target: Target, signal: AbortSignal): Promise<PreparedPlayback> {
      const claim = Object.freeze(claimSchema.parse(context.claim));
      if (claim.userId !== context.userId || claim.courseId !== target.courseId || claim.lectureId !== target.lectureId) throw changed();
      let driver: PreparedSchoolVideo | undefined, lease: PlaybackLeaseScope | undefined, acquired = false, state: State | undefined;
      try {
        return await boundedWorkerOperation(async bounded => {
          const validate = () => claimCurrent(claim, bounded);
          await validate();
          driver = await school.prepare({ owner: claim.userId, courseId: claim.courseId, moduleItemId: claim.lectureId }, validate, bounded, claim.acceptedGeneration);
          if (bounded.aborted) { driver.close(); bounded.throwIfAborted(); }
          if (driver.generation !== claim.acceptedGeneration) throw changed();
          const media = await driver.prepareMedia(validate, bounded);
          const proof = await driver.authority(validate, bounded);
          lease = { owner: claim.userId, generation: claim.acceptedGeneration, courseId: claim.courseId, moduleItemId: claim.lectureId,
            tokenHash: claim.executionTokenHash, kind: 'worker' };
          acquired = await boundedWorkerOperation(current => leases.acquire(lease!, { encryptedSession: proof.encryptedSession }, current), { signal: bounded, timeoutMs: 5_000 });
          if (!acquired) throw busy();
          const lifetime = new AbortController();
          const source = runtime.createSource({ expectedDurationSeconds: driver.durationSeconds,
            validate: current => guard(state!, current),
            stream: request => {
              const current = AbortSignal.any([request.signal, lifetime.signal]);
              return stream(claim.userId, async () => ({ ...media, validate: () => guard(state!, current) }),
                { ...request, signal: current, validate: async () => { await request.validate(); await guard(state!, current); } });
            },
            observe: observation => { if (!state || state.disposed || lifetime.signal.aborted) throw changed(); driver!.observe(observation); },
            report: (event, reportSignal) => {
              if (!state || state.disposed || state.reporting || lifetime.signal.aborted) return Promise.reject(changed());
              const owned = state; owned.reporting = true; let enteredSchoolReport = false;
              const pending = boundedWorkerOperation(current => {
                const callback = (async () => {
                const validate = () => guard(owned, current); await validate();
                enteredSchoolReport = true;
                const result = await owned.driver.report(event, validate, current);
                if (result.transport !== 'acknowledged') {
                  owned.uncertain = true; const error = unknown();
                  rememberVideoReportPreparation(error, 'post_report', true); rememberVideoReportOutcomeFailure(error, result, 'transport_unknown'); throw error;
                }
                await validate();
                if (event === 'ended') {
                  if (result.state !== 'closed') { const error = unknown(); rememberVideoReportPreparation(error, 'post_report', true); rememberVideoReportOutcomeFailure(error, result, 'terminal_controller_open'); throw error; }
                  owned.endedReport = true;
                } else if (result.state !== 'ready') {
                  const error = unknown(); rememberVideoReportPreparation(error, 'post_report', true); rememberVideoReportOutcomeFailure(error, result, 'nonterminal_controller_closed'); throw error;
                }
                })();
                owned.callbacks.add(callback);
                void callback.then(() => owned.callbacks.delete(callback), () => owned.callbacks.delete(callback));
                return callback;
              }, { signal: AbortSignal.any([reportSignal, lifetime.signal]), timeoutMs: 90_000 }).catch(error => {
                // Before this boundary no school report was attempted. Once entered, do not
                // infer non-delivery from authentication, cancellation or response loss.
                owned.uncertain ||= enteredSchoolReport; owned.failure ??= error; owned.reportFailure ??= error;
                // Observability cannot alter authority, cleanup, uncertainty or retry behavior.
                try { dependencies.reportFailure?.(workerVideoReportDiagnostic(error, event)); } catch {}
                throw owned.uncertain ? unknown(error) : error;
              }).finally(() => { owned.reporting = false; });
              owned.reportPending = pending; return pending;
            },
          });
          state = { claim, driver, lease, source, lifetime, played: false, disposed: false, cleanupConfirmed: false, uncertain: false, reporting: false, ended: false, endedReport: false, callbacks: new Set(), runtimePending: false, runtimeStopped: false, closeSucceeded: false };
          await guard(state, bounded); bounded.throwIfAborted();
          const owned = state;
          const prepared = Object.freeze({ alreadyRecognized: false, handle: Object.freeze({
            toJSON: () => ({ kind: 'private-school-playback' }), [inspect.custom]: () => 'SchoolPlayback { private }' }), dispose: () => dispose(owned),
            terminationProof: () => {
              if (!owned.disposed || !owned.lifetime.signal.aborted || !owned.closeSucceeded || !owned.runtimeStopped
                || owned.runtimePending || owned.callbacks.size > 0) return null;
              return owned.termination ??= createPlaybackTerminationProof(owned.claim, { runtimeStopped: true, dispatchFenced: true, callbacksDrained: true });
            } });
          states.set(prepared, owned); return prepared;
        }, { signal, timeoutMs: 90_000 });
      } catch (error) {
        if (state) await dispose(state).catch(() => {});
        else {
          let confirmed = true; try { driver?.close(); } catch { confirmed = false; }
          if (confirmed && acquired && lease) await boundedWorkerOperation(current => leases.release(lease!, current), { timeoutMs: 2_000 }).catch(() => {});
        }
        throw error;
      }
    },
    async play(prepared: PreparedPlayback, signal: AbortSignal): Promise<void> {
      const state = read(prepared);
      if (state.played || state.disposed) throw changed(); state.played = true;
      try {
        await guard(state, signal);
        state.runtimePending = true;
        const result = await runtime.play(state.source, AbortSignal.any([signal, state.lifetime.signal])).finally(() => { state.runtimePending = false; });
        signal.throwIfAborted();
        if (result.ended !== true || result.browserClosed !== true || result.processExited !== true || !state.endedReport) throw cleanup();
        await guard(state, signal); state.ended = true;
        // The runner transitions to reconciling after play resolves. Close execution first,
        // so no final-only authority can ever authorize another observation or report.
        await dispose(state); signal.throwIfAborted();
      } catch (error) { await dispose(state).catch(() => {}); throw state.uncertain ? unknown(state.reportFailure ?? state.failure ?? error) : state.failure ?? error; }
    },
    async playbackLearningStatus(prepared: PreparedPlayback, signal: AbortSignal): Promise<SchoolResult> {
      const state = read(prepared);
      if (!state.cleanupConfirmed) throw changed();
      return boundedWorkerOperation(async current => {
        const validate = () => claimCurrent(state.claim, current, 'final');
        await authority(state, current, 'final');
        const result = await state.driver.readFresh(validate, current);
        await authority(state, current, 'final'); return result;
      }, { signal, timeoutMs: 90_000 });
    },
    async validatePlayback(prepared: PreparedPlayback, signal: AbortSignal): Promise<FinalProof> {
      const state = read(prepared);
      return dependencies.createFinalProof(state.claim, await authority(state, signal, state.cleanupConfirmed ? 'final' : 'execution'));
    },
  };
  return {
    authorizePlayback: (...args: Parameters<typeof adapter.authorizePlayback>) => normalize(() => adapter.authorizePlayback(...args)),
    preparePlayback: (...args: Parameters<typeof adapter.preparePlayback>) => normalize(() => adapter.preparePlayback(...args)),
    play: (...args: Parameters<typeof adapter.play>) => normalize(() => adapter.play(...args)),
    playbackLearningStatus: (...args: Parameters<typeof adapter.playbackLearningStatus>) => normalize(() => adapter.playbackLearningStatus(...args)),
    validatePlayback: (...args: Parameters<typeof adapter.validatePlayback>) => normalize(() => adapter.validatePlayback(...args)),
  };
}
