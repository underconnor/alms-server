import { createHash } from 'node:crypto';
import type { Job, Session } from './domain.js';
import { AppError } from './errors.js';
import type { ProgressCacheTarget } from './school-progress-cache.js';
import { boundedWorkerOperation } from './worker-bounds.js';

const terminal = new Set<Job['status']>(['completed', 'succeeded', 'cancelled', 'failed', 'needs_reauthentication', 'needs_verification']);
const unavailable = () => new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '작업 결과 갱신을 확인하지 못했습니다. 다시 시도해 주세요.');
type Invalidate = (owner: string, targets: readonly ProgressCacheTarget[], signal: AbortSignal) => Promise<void>;
type Options = { signal: AbortSignal; validate: () => Promise<void> };

/** Process-local refresh markers, never school completion evidence. */
export function createJobResultCache(invalidate: Invalidate, limits = { timeoutMs: 15_000, maxMarkers: 4000, maxPendingOwners: 64, ttlMs: 600_000 }) {
  const completed = new Map<string, number>();
  const pending = new Map<string, { wait: Promise<void> }>();
  return {
    async refresh(session: Session, jobs: readonly Job[], options: Options): Promise<void> {
      if (jobs.length > 200 || jobs.some(job => job.userId !== session.user.id)) throw unavailable();
      // Own a snapshot even if the caller mutates its objects while invalidation awaits.
      const snapshots = jobs.filter(job => terminal.has(job.status)).map(job => ({
        key: createHash('sha256').update(JSON.stringify([session.user.id, session.tokenHash, job.id, job.courseId, job.lectureId,
          job.status, job.updatedAt, job.schoolResult?.observedAt ?? null, job.acceptedGeneration, job.executionOutcome ?? null])).digest('hex'),
        target: { courseId: job.courseId, lectureId: job.lectureId },
      }));
      const added: string[] = [];
      try {
        await boundedWorkerOperation(async signal => {
          await options.validate(); signal.throwIfAborted();
          for (;;) {
            const now = Date.now();
            for (const [key, expiry] of completed) if (expiry <= now) completed.delete(key);
            const missing = snapshots.filter(snapshot => !completed.has(snapshot.key));
            if (!missing.length) break;
            const active = pending.get(session.user.id);
            if (active) { await active.wait; signal.throwIfAborted(); continue; }
            if (pending.size >= limits.maxPendingOwners) throw unavailable();
            const targets = [...new Map(missing.map(snapshot => [JSON.stringify(snapshot.target), snapshot.target])).values()];
            const entry = { wait: Promise.resolve() };
            pending.set(session.user.id, entry);
            // Retain the coalescing entry until the underlying lock/SQL really settles,
            // even when the request deadline already rejected. Never enqueue late copies.
            entry.wait = (async () => {
              signal.throwIfAborted();
              await invalidate(session.user.id, targets, signal);
              signal.throwIfAborted(); await options.validate(); signal.throwIfAborted();
              for (const snapshot of missing) {
                if (!completed.has(snapshot.key) && completed.size >= limits.maxMarkers) completed.delete(completed.keys().next().value!);
                completed.set(snapshot.key, Date.now() + limits.ttlMs); added.push(snapshot.key);
              }
            })();
            void entry.wait.finally(() => { if (pending.get(session.user.id) === entry) pending.delete(session.user.id); }).catch(() => {});
            await entry.wait; signal.throwIfAborted();
            // All requested snapshots were processed; marker eviction must not loop.
            break;
          }
          await options.validate(); signal.throwIfAborted();
        }, { signal: options.signal, timeoutMs: limits.timeoutMs });
      } catch (error) {
        for (const key of added) completed.delete(key);
        if (error instanceof AppError && [401, 403].includes(error.statusCode)) throw error;
        throw unavailable();
      }
    },
  };
}
export type JobResultCache = ReturnType<typeof createJobResultCache>;
