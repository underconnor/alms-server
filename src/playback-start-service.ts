import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, notFound } from './errors.js';
import { hashToken } from './store.js';
import { boundedWorkerOperation } from './worker-bounds.js';
import type { SchoolResult } from './domain.js';
import type { ManualVideoContext, ManualVideoObservation } from './manual-video-types.js';
import type { PlaybackLeaseRepository, PlaybackLeaseScope } from './manual-video-lease.js';
import { copyPlaybackStartDiagnostic } from './playback-start-diagnostics.js';

export interface PreparedPlaybackStart {
  generation: string;
  authority(validate: () => Promise<void>, signal: AbortSignal): Promise<{ generation: string; encryptedSession: string }>;
  confirmStart(observation: ManualVideoObservation, validate: () => Promise<void>, signal: AbortSignal): Promise<{ transport: 'acknowledged' | 'unknown'; school: SchoolResult }>;
  close(): void;
}
export interface PlaybackStartSchool {
  prepare(context: ManualVideoContext, validate: () => Promise<void>, signal: AbortSignal): Promise<PreparedPlaybackStart>;
}
type Result = { state: 'confirmed'; confirmedAt: string; schoolResult: SchoolResult }
  | { state: 'verification_required'; confirmedAt: null; schoolResult: SchoolResult };
type Entry = { id: string; hash: string; context: ManualVideoContext; driver: PreparedPlaybackStart;
  expiresAt: number; state: 'prepared' | 'confirming' | 'consumed'; result?: Result; abort: AbortController };
const unavailable = () => new AppError(503, 'PLAYBACK_START_UNAVAILABLE', '학교 진도 기록 시작을 준비하지 못했습니다.');
const consumed = () => new AppError(409, 'PLAYBACK_START_CONSUMED', '이미 처리한 확인 요청입니다. 학교 결과를 확인해 주세요.');
const busy = () => new AppError(409, 'PLAYBACK_BUSY', '진도를 기록 중인 영상이 있습니다. 기존 재생이 끝난 뒤 다시 시도해 주세요.');
const closeDriver = (driver: PreparedPlaybackStart) => { try { driver.close(); } catch {} };
const expired = () => new AppError(409, 'PLAYBACK_START_EXPIRED', '확인 시간이 지났습니다. 다시 확인창을 열어 주세요.');
function normalize(error: unknown) {
  if (error instanceof AppError) return error;
  if (['authentication_required', 'identity_mismatch'].includes(String((error as { code?: unknown })?.code)))
    return new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 다시 확인해 주세요.');
  return unavailable();
}

/** A confirmation belongs to this API process and exact signed-in target. A lost process never replays it. */
export class PlaybackStartService {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<Result>>();
  private readonly preparing = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor(private readonly leases: PlaybackLeaseRepository, private readonly school: PlaybackStartSchool,
    private readonly now = () => Date.now()) {
    this.sweep = setInterval(() => {
      for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now() && entry.state !== 'confirming') {
        entry.abort.abort(); closeDriver(entry.driver); this.entries.delete(id);
      }
    }, 10_000); this.sweep.unref();
  }
  async prepare(context: ManualVideoContext, validate: () => Promise<void>, signal: AbortSignal) {
    if (this.shutdown.signal.aborted) throw unavailable();
    if (this.preparing.has(context.owner)) throw busy();
    if (this.entries.size + this.preparing.size >= 100) throw new AppError(429, 'RATE_LIMITED', '잠시 후 다시 시도해 주세요.');
    this.preparing.add(context.owner);
    try {
      return await boundedWorkerOperation(async bounded => {
        await validate(); bounded.throwIfAborted();
        const prepared = await this.school.prepare(context, validate, bounded);
        let retained = false;
        try {
        bounded.throwIfAborted(); await prepared.authority(validate, bounded); bounded.throwIfAborted();
        const id = randomUUID(), nonce = randomBytes(32).toString('base64url'), expiresAt = this.now() + 120_000;
        this.entries.set(id, { id, hash: hashToken(nonce), context: { ...context }, driver: prepared,
          expiresAt, state: 'prepared', abort: new AbortController() });
        retained = true;
        return { confirmationId: id, nonce, expiresAt: new Date(expiresAt).toISOString() };
        } finally { if (!retained) closeDriver(prepared); }
      }, { signal: AbortSignal.any([signal, this.shutdown.signal]), timeoutMs: 90_000 });
    } catch (error) { throw normalize(error); }
    finally { this.preparing.delete(context.owner); }
  }
  private owned(context: ManualVideoContext, id: string, nonce: string) {
    const entry = this.entries.get(id), hash = hashToken(nonce);
    if (!entry || entry.context.owner !== context.owner || entry.context.sessionHash !== context.sessionHash
      || entry.context.courseId !== context.courseId || entry.context.moduleItemId !== context.moduleItemId
      || !timingSafeEqual(Buffer.from(entry.hash), Buffer.from(hash))) throw notFound();
    if (entry.expiresAt <= this.now() || this.shutdown.signal.aborted) throw expired();
    return entry;
  }
  confirm(context: ManualVideoContext, id: string, nonce: string, observation: ManualVideoObservation,
    validate: () => Promise<void>, signal: AbortSignal): Promise<Result> {
    const pending = this.confirmOnce(context, id, nonce, observation, validate, signal);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }
  private async confirmOnce(context: ManualVideoContext, id: string, nonce: string, observation: ManualVideoObservation,
    validate: () => Promise<void>, signal: AbortSignal): Promise<Result> {
    const entry = this.owned(context, id, nonce);
    // Claim synchronously, before any await; concurrent or repeated requests cannot enter the school write twice.
    if (entry.state !== 'prepared') {
      await validate(); await entry.driver.authority(validate, signal);
      if (entry.result) return entry.result;
      throw consumed();
    }
    entry.state = 'confirming';
    let lease: PlaybackLeaseScope | undefined, acquired = false, entered = false, acknowledged = false;
    const observedDiagnostic = {};
    try {
      const result = await boundedWorkerOperation(async bounded => {
        await validate(); const proof = await entry.driver.authority(validate, bounded); bounded.throwIfAborted();
        lease = { owner: context.owner, generation: proof.generation, courseId: context.courseId,
          moduleItemId: context.moduleItemId, tokenHash: entry.hash, kind: 'manual' };
        acquired = await this.leases.acquire(lease, { encryptedSession: proof.encryptedSession, almsTokenHash: context.sessionHash }, bounded);
        if (!acquired) throw busy();
        const current = async () => {
          bounded.throwIfAborted(); if (entry.expiresAt <= this.now()) throw expired(); await validate();
          const latest = await entry.driver.authority(validate, bounded);
          if (latest.generation !== proof.generation || !await this.leases.renew(lease!, bounded)) throw expired();
          bounded.throwIfAborted(); if (entry.expiresAt <= this.now()) throw expired();
        };
        await current(); if (entry.expiresAt <= this.now()) throw expired();
        entered = true;
        const answer = await entry.driver.confirmStart({ ...observation }, current, bounded);
        copyPlaybackStartDiagnostic(observedDiagnostic, answer);
        acknowledged = answer.transport === 'acknowledged';
        await current(); bounded.throwIfAborted();
        const result = answer.transport === 'acknowledged'
          ? { state: 'confirmed' as const, confirmedAt: new Date(this.now()).toISOString(), schoolResult: answer.school }
          : { state: 'verification_required' as const, confirmedAt: null, schoolResult: answer.school };
        copyPlaybackStartDiagnostic(result, answer); return result;
      }, { signal: AbortSignal.any([signal, entry.abort.signal, this.shutdown.signal]), timeoutMs: 90_000 });
      entry.result = result; return result;
    } catch (error) {
      const normalized = normalize(error); copyPlaybackStartDiagnostic(normalized, error);
      copyPlaybackStartDiagnostic(normalized, observedDiagnostic); throw normalized;
    }
    finally {
      entry.state = 'consumed'; closeDriver(entry.driver);
      // An uncertain school write retains the bounded common lease; expiry does not replay the request.
      if (acquired && lease && (!entered || acknowledged)) await this.leases.release(lease, AbortSignal.timeout(5_000)).catch(() => {});
    }
  }
  beginShutdown() { clearInterval(this.sweep); this.shutdown.abort(); }
  async close() { this.beginShutdown(); for (const entry of this.entries.values()) { entry.abort.abort(); closeDriver(entry.driver); } await Promise.allSettled([...this.pending]); this.entries.clear(); }
}
