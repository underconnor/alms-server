import type { Pool, PoolClient } from 'pg';
import { AppError } from './errors.js';
import { boundedWorkerOperation, WorkerDeadlineError } from './worker-bounds.js';
import type { SchoolSessionLockRunner } from './school-session-lock.js';

const busy = () => new AppError(503, 'SCHOOL_SESSION_BUSY', '다른 학교 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
const lost = () => new AppError(503, 'SCHOOL_SESSION_LOCK_LOST', '학교 요청 처리를 확인하지 못했습니다. 다시 조회해 주세요.');
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** Use a separate, bounded pool: a coordinator waiting on a school owner must never
 * consume the connection needed by that owner's validation, CAS or worker heartbeat.
 * No transaction spans school IO. Session advisory locks release on connection death. */
export function createPgSchoolSessionLockRunner(pool: Pool,
  options: { waitTimeoutMs?: number; pollMs?: number; unlockTimeoutMs?: number } = {}): SchoolSessionLockRunner {
  const waitTimeoutMs = options.waitTimeoutMs ?? 15_000, pollMs = options.pollMs ?? 50, unlockTimeoutMs = options.unlockTimeoutMs ?? 2_000;
  if (![waitTimeoutMs, pollMs, unlockTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)
    || waitTimeoutMs > 90_000 || pollMs > 1000 || unlockTimeoutMs > 5000) throw lost();
  return async <T>(owner: string, run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> => {
    if (typeof owner !== 'string' || !owner.length || owner.length > 200) throw lost();
    const key = `alms:ssu:school-session:v1:${owner}`, life = new AbortController();
    const signal = external ? AbortSignal.any([external, life.signal]) : life.signal;
    let client: PoolClient | undefined, released = false, acquired = false, callbackCompleted = false;
    const release = (destroy: boolean) => {
      if (client && !released) { released = true; client.removeListener('error', onError); client.release(destroy); }
    };
    const onError = () => { life.abort(lost()); };
    try {
      await boundedWorkerOperation(async acquiring => {
        const abort = () => release(true);
        const connecting = pool.connect();
        void connecting.then(value => { if (acquiring.aborted) { released = true; value.release(true); } }, () => {});
        client = await connecting;
        acquiring.throwIfAborted();
        client.on('error', onError);
        acquiring.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            acquiring.throwIfAborted(); signal.throwIfAborted();
            const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key]);
            acquiring.throwIfAborted(); signal.throwIfAborted();
            if (result.rows[0]?.acquired === true) { acquired = true; return; }
            if (result.rows[0]?.acquired !== false) throw lost();
            await pause(pollMs, acquiring);
          }
        } finally { acquiring.removeEventListener('abort', abort); }
      }, { signal, timeoutMs: waitTimeoutMs });
      signal.throwIfAborted();
      const value = await run(signal);
      signal.throwIfAborted();
      callbackCompleted = true;
      // Unlock failure is not authentication expiry; destroying the exact checked-out
      // connection releases its locks without returning it to the idle pool.
      const result = await boundedWorkerOperation(() => client!.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key]), { timeoutMs: unlockTimeoutMs });
      if (result.rows[0]?.unlocked !== true) throw lost();
      acquired = false; release(false); return value;
    } catch (error) {
      // On failures (including an uncertain school write), never run the callback again.
      // Destroying rather than pooling a connection cannot leak a session-level lock.
      release(true);
      if (external?.aborted) throw external.reason;
      if (life.signal.aborted) throw life.signal.reason;
      if (error instanceof WorkerDeadlineError && !acquired) throw busy();
      if (error instanceof AppError) throw error;
      // Preserve the callback's school/authority failure once execution started.
      if (acquired && !callbackCompleted) throw error;
      throw lost();
    } finally { release(acquired || signal.aborted); }
  };
}
