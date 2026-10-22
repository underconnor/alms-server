import type { Store } from './store.js';
import { claimMatchesJob, jobClaim, inspectPlaybackFinalProof } from './playback-authority.js';
import { AppError } from './errors.js';
import { resultStatus, type Job, type ExecutionOutcome, type SchoolResult } from './domain.js';
import { playbackContext, type PreparedPlayback, type SchoolProvider } from './provider.js';
import { boundedWorkerOperation, type WorkerOperation } from './worker-bounds.js';
import type { PlaybackTerminationProof } from './playback-termination.js';

const claimedHandles = new WeakSet<object>();
export const workerJobLimits = { operationMs: 5000, preparationMs: 90_000, resultMs: 90_000, cleanupMs: 10_000, finalizationMs: 10_000 };
type Limits = typeof workerJobLimits;

export async function executeJob(id: string, store: Store, provider: SchoolProvider, shutdown?: AbortSignal, pollMs = 1000, overrides: Partial<Limits> = {}) {
  const limits = { ...workerJobLimits, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('INVALID_WORKER_LIMIT');
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (reason: string) => { interrupted = true; controller.abort(reason); };
  const stop = () => interrupt('shutdown');
  shutdown?.addEventListener('abort', stop, { once: true });
  if (shutdown?.aborted) stop();
  const db = <T>(run: (operation: WorkerOperation) => Promise<T>, signal = controller.signal) =>
    boundedWorkerOperation(inner => run({ signal: inner, timeoutMs: limits.operationMs }), { signal, timeoutMs: limits.operationMs });
  let job: Job | null = null;
  try { job = await db(operation => store.claimJob(id, operation)); }
  catch { shutdown?.removeEventListener('abort', stop); return; }
  if (!job) { shutdown?.removeEventListener('abort', stop); return; }
  const claimed = job;
  const claim = jobClaim(claimed);
  let outcome: ExecutionOutcome | null = null;
  const { context, target } = playbackContext(claimed);
  let prepared: PreparedPlayback | undefined;
  let phase: 'running' | 'reconciling' = 'running';
  let transitioning = false;
  let failure: unknown;
  let result: SchoolResult | null = null;
  let cleanupFailed = false;
  let terminationProof: PlaybackTerminationProof | undefined;
  let reportUnconfirmed = false;
  let polling: Promise<void> | undefined;
  let inFlight: Promise<unknown> | undefined;
  let disposing: Promise<void> | undefined;
  const dispose = () => {
    if (!prepared) return Promise.resolve();
    return disposing ??= prepared.dispose();
  };
  const owns = (current: Job) => claimMatchesJob(claim, current);
  const inspect = async () => {
    const startedPhase = phase, startedTransition = transitioning;
    const current = await db(operation => store.getWorkerJob(claim, operation));
    controller.signal.throwIfAborted();
    if (current && owns(current) && current.status === 'cancel_requested') { interrupt('cancel'); return; }
    const active = current && (current.status === phase
      || (startedPhase !== phase && current.status === startedPhase)
      || ((startedTransition || transitioning) && ['running', 'reconciling'].includes(current.status)));
    if (!current || !owns(current) || !active) { interrupt('lease_lost'); return; }
    if (!await db(operation => store.heartbeat(claim, operation))) { interrupt('lease_lost'); return; }
    controller.signal.throwIfAborted();
    if (prepared && provider.validatePlayback) {
      const proof = await boundedWorkerOperation(signal => provider.validatePlayback!(prepared!, signal), { signal: controller.signal, timeoutMs: limits.operationMs });
      inspectPlaybackFinalProof(proof, claim);
    }
    controller.signal.throwIfAborted();
  };
  const inspectOnce = () => {
    polling ??= inspect().catch(error => { failure ??= error; interrupt('validation_failed'); }).finally(() => { polling = undefined; });
    return polling;
  };
  const timer = setInterval(() => { if (!controller.signal.aborted) void inspectOnce(); }, pollMs);
  const check = async () => {
    if (polling) await polling;
    if (!controller.signal.aborted) await inspectOnce();
    controller.signal.throwIfAborted();
  };
  const work = <T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number) => boundedWorkerOperation(signal => {
    const pending = run(signal).catch(error => {
      // Cancellation can win the bounded wrapper before a school report rejects.
      // Retain the underlying report uncertainty through runtime disposal.
      if (error instanceof AppError && error.code === 'PLAYBACK_REPORT_UNKNOWN') reportUnconfirmed = true;
      throw error;
    }); inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = undefined; }).catch(() => {});
    return pending;
  }, { signal: controller.signal, timeoutMs });
  const available = provider.capabilities.playback && provider.preparePlayback && provider.play && provider.validatePlayback && provider.playbackLearningStatus;

  try {
    if (!available) throw new AppError(503, 'PLAYBACK_UNAVAILABLE', '재생 기능을 사용할 수 없습니다.');
    await check();
    const value = await work(async signal => {
      const value = await provider.preparePlayback!(context, target, signal);
      if (claimedHandles.has(value.handle)) throw new AppError(503, 'PLAYBACK_HANDLE_REUSED', '재생 작업을 다시 확인해 주세요.');
      claimedHandles.add(value.handle); prepared = value;
      // Even a non-cooperative adapter that resolves after interruption must release its runtime.
      if (signal.aborted) { void boundedWorkerOperation(() => dispose(), { timeoutMs: limits.cleanupMs }).catch(() => {}); signal.throwIfAborted(); }
      return value;
    }, limits.preparationMs);
    await check();
    if (!value.alreadyRecognized) {
      outcome = 'interrupted';
      await work(signal => provider.play!(value, signal), 4 * 60 * 60_000);
      controller.signal.throwIfAborted();
      outcome = 'ended';
    } else outcome = 'not_started';
    await check();
    transitioning = true;
    try {
      if (!await db(operation => store.transitionJob(claim, ['running'], 'reconciling', null, null, {}, operation))) {
        interrupt('lease_lost'); controller.signal.throwIfAborted();
      }
      phase = 'reconciling';
    } finally { transitioning = false; }
    result = await work(signal => provider.playbackLearningStatus!(prepared!, signal), limits.resultMs);
    await check();
  } catch (error) {
    outcome ??= 'not_started';
    failure ??= error;
    controller.abort('execution_failed');
  } finally {
    try {
      await boundedWorkerOperation(async () => {
        // Ask disposal to stop the runtime immediately, and also wait for any already-aborted operation.
        const pending = inFlight;
        await Promise.all([dispose(), pending?.catch(() => {})]);
        // Preparation may have produced its handle while the preceding wait was settling.
        if (prepared) await dispose();
      }, { timeoutMs: limits.cleanupMs });
    } catch { cleanupFailed = true; interrupt('cleanup_failed'); }
    if (polling) await polling;
    if (!controller.signal.aborted && !cleanupFailed) await inspectOnce();
    clearInterval(timer);
    if (polling) await polling;
    // Neither a missing handle nor the adapter's legacy cleanup flag is a proof.
    // The adapter must attest actual closure and drained dispatch callbacks.
    const terminated = prepared as (PreparedPlayback & { terminationProof?: () => PlaybackTerminationProof | null }) | undefined;
    if (!cleanupFailed && terminated?.terminationProof) {
      try { terminationProof = terminated.terminationProof() ?? undefined; } catch { terminationProof = undefined; }
    }
  }

  try {
    await boundedWorkerOperation(async finalSignal => {
      const read = () => db(operation => store.getWorkerJob(claim, operation), finalSignal);
      const transition = async (from: Job['status'][], to: Job['status'], value: SchoolResult | null, code: string | null, success = false) => {
        const signal = success ? AbortSignal.any([finalSignal, controller.signal]) : finalSignal;
        // Final success and any fresh result are bound to this prepared generation even after disposal.
        const authority = value && prepared && provider.validatePlayback
          ? await boundedWorkerOperation(inner => provider.validatePlayback!(prepared!, inner), { signal, timeoutMs: limits.operationMs }) : undefined;
        return db(operation => store.transitionJob(claim, from, to, value, code, { outcome, authority, terminationProof }, operation), signal);
      };
      const finishCancellation = async () => {
        const current = await read();
        if (!current || !owns(current) || current.status !== 'cancel_requested') return false;
        if (reportUnconfirmed) {
          await transition(['cancel_requested'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN');
          return true;
        }
        // Shutdown/claim loss never starts a new school read; cancellation alone can reconcile after cleanup.
        if (shutdown?.aborted || cleanupFailed || !provider.playbackLearningStatus || !prepared) {
          await transition(['cancel_requested'], 'needs_verification', null, cleanupFailed ? 'PLAYBACK_CLEANUP_FAILED' : 'WORKER_INTERRUPTED');
          return true;
        }
        try {
          result = await boundedWorkerOperation(signal => provider.playbackLearningStatus!(prepared!, signal), {
            signal: AbortSignal.any([finalSignal, ...(shutdown ? [shutdown] : [])]), timeoutMs: limits.operationMs,
          });
        } catch { result = null; }
        if (shutdown?.aborted) await transition(['cancel_requested'], 'needs_verification', null, 'WORKER_INTERRUPTED');
        else await transition(['cancel_requested'], 'cancelled', result, result ? null : 'SCHOOL_RESULT_UNKNOWN');
        return true;
      };
      const current = await read();
      if (!current || !owns(current)) return;
      if (cleanupFailed) {
        if (['running', 'reconciling', 'cancel_requested', 'pause_requested'].includes(current.status))
          await transition([current.status], 'needs_verification', null, 'PLAYBACK_CLEANUP_FAILED');
        return;
      }
      if (await finishCancellation()) return;
      if (!['running', 'reconciling', 'pause_requested'].includes(current.status)) return;
      if (!available && !interrupted) { await transition(['running'], 'failed', null, 'PLAYBACK_UNAVAILABLE'); return; }
      if (failure || controller.signal.aborted) {
        const expired = !reportUnconfirmed && failure instanceof AppError && ['AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED'].includes(failure.code);
        const status = expired && current.status !== 'pause_requested' ? 'needs_reauthentication' : 'needs_verification';
        const code = reportUnconfirmed ? 'PLAYBACK_REPORT_UNKNOWN' : expired ? 'AUTH_REQUIRED' : interrupted ? 'WORKER_INTERRUPTED' : 'SCHOOL_RESULT_UNKNOWN';
        if (!await transition([current.status], status, null, code)) await finishCancellation();
        return;
      }
      if (!await transition(['reconciling'], resultStatus(result, outcome), result, resultStatus(result, outcome) === 'needs_verification' ? 'SCHOOL_RESULT_UNKNOWN' : null, true))
        await finishCancellation();
    }, { timeoutMs: limits.finalizationMs });
  } catch {
    // Never retry an uncertain write or start playback again. Stale running jobs are recovered by maintenance.
    controller.abort('finalization_failed');
  } finally { shutdown?.removeEventListener('abort', stop); }
}
