import { rememberVideoReportDiagnostic } from './video-report-diagnostics.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, notFound } from './errors.js';
import { hashToken } from './store.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import { manualVideoObservationTiming } from './manual-video-timing.js';
import { rememberManualVideoObservationFailure } from './manual-video-observation-diagnostics.js';
import type { PlaybackLeaseRepository, PlaybackLeaseScope } from './manual-video-lease.js';
import type { ManualVideoContext, ManualVideoEvent, ManualVideoObservation, ManualVideoSchool, PreparedManualVideo } from './manual-video-types.js';

interface State { id: string; context: ManualVideoContext; hash: string; lease: PlaybackLeaseScope; driver: PreparedManualVideo;
  abort: AbortController; createdAt: number; lastObservedAt: number; sequence: number; reportSequence: number;
  observing: boolean; reporting: boolean; closed: boolean; lastReportAt: number | null;
  observationTiming?: 'client_monotonic_v1'; }
const busy = () => new AppError(409, 'PLAYBACK_BUSY', '다른 영상의 진도를 기록하고 있습니다. 기존 재생을 먼저 종료해 주세요.');
const expired = () => new AppError(409, 'PLAYBACK_SESSION_EXPIRED', '진도 기록이 중단됐습니다. 학교 결과를 확인한 뒤 다시 재생해 주세요.');
const invalid = () => new AppError(409, 'PLAYBACK_OBSERVATION_INVALID', '현재 재생 상태로는 학교 진도를 기록할 수 없습니다.');
const normalized = (error: unknown, report = false): AppError => {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown })?.code;
  if (code === 'authentication_required' || code === 'identity_mismatch') return new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해야 합니다. 통합 로그인으로 이어서 이용해 주세요.');
  return new AppError(503, report ? 'PLAYBACK_REPORT_UNKNOWN' : 'VIDEO_REPORT_UNAVAILABLE', report
    ? '진도 보고 결과를 확인하지 못했습니다. 학교 결과를 확인해 주세요.' : '이 영상의 학교 진도 기록을 준비하지 못했습니다.');
};
/** Manual lifetimes are process-local; the lease is shared with other API/worker processes. */
export class ManualVideoService {
  private readonly states = new Map<string, State>();
  private readonly starting = new Set<string>();
  private readonly shutdown = new AbortController();
  private closePromise: Promise<void> | undefined;
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor(private readonly leases: PlaybackLeaseRepository, private readonly school: ManualVideoSchool,
    private readonly now = () => Date.now()) {
    this.sweep = setInterval(() => {
      for (const state of this.states.values()) if (this.now() - state.lastObservedAt > 15_000 || this.now() - state.createdAt > 4 * 60 * 60_000)
        void this.dispose(state);
    }, 5_000); this.sweep.unref();
  }
  private async dispose(state: State, interrupt = true, retainLease = false) {
    if (state.closed) return;
    state.closed = true; if (interrupt) state.abort.abort();
    try { state.driver.close(); } catch { /* Local disposal must still remove state and settle the lease. */ }
    this.states.delete(state.id);
    // A cancelled in-flight report may already have reached the school. Keep its bounded
    // lease until expiry instead of allowing an immediate competing execution.
    if (retainLease || interrupt && state.reporting) return;
    // Exact ownership token prevents an old close from deleting a replacement lifetime.
    await this.leases.release(state.lease, AbortSignal.timeout(5_000)).catch(() => {});
  }
  private owned(context: ManualVideoContext, id: string, nonce: string): State {
    const state = this.states.get(id), supplied = hashToken(nonce);
    if (!state || state.context.owner !== context.owner || state.context.sessionHash !== context.sessionHash
      || state.context.courseId !== context.courseId || state.context.moduleItemId !== context.moduleItemId
      || !timingSafeEqual(Buffer.from(state.hash), Buffer.from(supplied))) throw notFound();
    if (state.closed || state.abort.signal.aborted || this.shutdown.signal.aborted
      || this.now() - state.createdAt > 4 * 60 * 60_000 || this.now() - state.lastObservedAt > 15_000) {
      void this.dispose(state); throw expired();
    }
    return state;
  }
  private async guard(state: State, validate: () => Promise<void>, signal: AbortSignal) {
    signal.throwIfAborted(); await validate(); signal.throwIfAborted(); await state.driver.validate(signal);
    signal.throwIfAborted(); if (!await this.leases.renew(state.lease, signal)) throw expired();
    await validate(); signal.throwIfAborted(); if (state.closed) throw expired();
  }
  async start(context: ManualVideoContext, validate: () => Promise<void>, signal: AbortSignal) {
    if (this.shutdown.signal.aborted) throw expired();
    if (this.starting.has(context.owner) || [...this.states.values()].some(state => state.context.owner === context.owner && !state.closed)) throw busy();
    if (this.states.size + this.starting.size >= 100) throw new AppError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
    this.starting.add(context.owner); let driver: PreparedManualVideo | undefined, lease: PlaybackLeaseScope | undefined, inserted: State | undefined;
    try {
      return await boundedWorkerOperation(async bounded => {
        await validate(); bounded.throwIfAborted(); const prepared = await this.school.prepare(context, validate, bounded);
        if (bounded.aborted) { prepared.close(); bounded.throwIfAborted(); }
        driver = prepared;
        const id = randomUUID(), nonce = randomBytes(32).toString('base64url'), hash = hashToken(nonce);
        lease = { owner: context.owner, generation: driver.generation, courseId: context.courseId, moduleItemId: context.moduleItemId, tokenHash: hash, kind: 'manual' };
        if (!await this.leases.acquire(lease, { encryptedSession: driver.encryptedSession, almsTokenHash: context.sessionHash }, bounded)) throw busy();
        await driver.validate(bounded); await validate(); bounded.throwIfAborted();
        const observationTiming = manualVideoObservationTiming(driver);
        const now = this.now(), state: State = { id, context: { ...context }, hash, lease, driver, abort: new AbortController(), createdAt: now,
          lastObservedAt: now, sequence: 0, reportSequence: 0, observing: false, reporting: false, closed: false, lastReportAt: null,
          ...(observationTiming ? { observationTiming } : {}) };
        inserted = state; this.states.set(id, state);
        return { playbackId: id, nonce, heartbeatIntervalMs: 5_000, reportIntervalMs: 300_000, maxInitialPositionSeconds: driver.baseline, state: 'ready' as const,
          ...(observationTiming ? { observationTiming } : {}) };
      }, { signal: AbortSignal.any([signal, this.shutdown.signal]), timeoutMs: 90_000 });
    } catch (error) {
      if (inserted) await this.dispose(inserted); else driver?.close(); if (lease) await this.leases.release(lease, AbortSignal.timeout(5_000)).catch(() => {});
      throw normalized(error);
    } finally { this.starting.delete(context.owner); }
  }
  async observe(context: ManualVideoContext, id: string, input: { nonce: string; sequence: number; observation: ManualVideoObservation }, validate: () => Promise<void>, signal: AbortSignal) {
    const state = this.owned(context, id, input.nonce);
    if (state.observing || input.sequence !== state.sequence + 1) throw invalid();
    if (Object.hasOwn(input.observation, 'capturedAtMs') && state.observationTiming !== 'client_monotonic_v1') throw invalid();
    state.observing = true;
    try {
      return await boundedWorkerOperation(async bounded => {
        await this.guard(state, validate, bounded); state.driver.observe({ ...input.observation });
        await validate(); bounded.throwIfAborted(); if (state.closed) throw expired();
        state.sequence = input.sequence; state.lastObservedAt = this.now();
        return { playbackId: id, sequence: input.sequence, state: 'ready' as const };
      }, { signal: AbortSignal.any([signal, state.abort.signal, this.shutdown.signal]), timeoutMs: 10_000 });
    } catch (error) {
      await this.dispose(state); const exposed = error instanceof AppError ? error : invalid();
      rememberManualVideoObservationFailure(exposed, error); throw exposed;
    }
    finally { state.observing = false; }
  }
  async report(context: ManualVideoContext, id: string, input: { nonce: string; reportSequence: number; event: ManualVideoEvent }, validate: () => Promise<void>, signal: AbortSignal) {
    const state = this.owned(context, id, input.nonce);
    if (state.reporting || input.reportSequence !== state.reportSequence + 1 || state.sequence < 1) throw invalid();
    if (input.event === 'update' && state.lastReportAt !== null && this.now() - state.lastReportAt < 300_000) throw invalid();
    state.reporting = true; state.reportSequence = input.reportSequence;
    try {
      return await boundedWorkerOperation(async bounded => {
        const current = () => this.guard(state, validate, bounded);
        await current(); const result = await state.driver.report(input.event, current, bounded);
        await validate(); bounded.throwIfAborted(); if (state.closed) throw expired();
        state.lastReportAt = this.now();
        if (result.state === 'closed' || result.transport === 'unknown') await this.dispose(state, false, result.transport === 'unknown');
        return { playbackId: id, reportSequence: input.reportSequence, state: result.state, report: result.transport, schoolResult: result.school };
      }, { signal: AbortSignal.any([signal, state.abort.signal, this.shutdown.signal]), timeoutMs: 90_000 });
    } catch (error) { await this.dispose(state); const exposed = normalized(error, true); rememberVideoReportDiagnostic(exposed, error); throw exposed; }
    finally { state.reporting = false; }
  }
  async stop(context: ManualVideoContext, id: string, nonce: string, validate: () => Promise<void>) {
    const state = this.owned(context, id, nonce); await validate(); await this.dispose(state);
    return { playbackId: id, state: 'closed' as const };
  }
  beginShutdown(): void { clearInterval(this.sweep); this.shutdown.abort(); }
  close(): Promise<void> { this.beginShutdown(); return this.closePromise ??= Promise.allSettled([...this.states.values()].map(state => this.dispose(state))).then(() => {}); }
}
