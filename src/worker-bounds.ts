import type { Pool, PoolClient, QueryResultRow } from 'pg';

export class WorkerDeadlineError extends Error {
  constructor() { super('WORKER_OPERATION_TIMEOUT'); }
}
export interface WorkerOperation { signal?: AbortSignal; timeoutMs: number }
export type WorkerQuery = <R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => Promise<import('pg').QueryResult<R>>;
// Only the worker pools use these connection defaults; API requests keep their existing settings.
export const workerPgOptions = {
  connectionTimeoutMillis: 5000,
  options: '-c statement_timeout=5000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000',
};

/** A deadline always aborts the underlying operation; a late value cannot resume the caller. */
export async function boundedWorkerOperation<T>(run: (signal: AbortSignal) => Promise<T>, options: WorkerOperation): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new WorkerDeadlineError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let rejectAbort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  timer = setTimeout(() => controller.abort(new WorkerDeadlineError()), options.timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }), stopped]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** Worker-only short transactions. Abort destroys the checked-out connection, so an
 * unfinished write is rolled back by PostgreSQL instead of committing after a JS timeout.
 * Never hand a cancelled connection back to another request. */
export function workerTransaction<T>(pool: Pool, run: (query: WorkerQuery) => Promise<T>, options: WorkerOperation): Promise<T> {
  return boundedWorkerOperation(async signal => {
    let client: PoolClient | undefined;
    let released = false;
    const release = (destroy: boolean) => { if (client && !released) { released = true; client.release(destroy); } };
    const abort = () => release(true);
    const pending = pool.connect();
    // A connection can arrive after pool checkout timed out; it must never execute SQL.
    void pending.then(value => { if (signal.aborted) { released = true; value.release(true); } }, () => {});
    try {
      client = await pending;
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      const query = async <R extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) => {
        signal.throwIfAborted();
        const result = await client!.query<R>(sql, values);
        signal.throwIfAborted();
        return result;
      };
      await query('BEGIN');
      await query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)", [String(options.timeoutMs)]);
      const value = await run(query);
      // The guarded query rejects after any prior abort, including a late UPDATE response.
      await query('COMMIT');
      return value;
    } catch (error) {
      release(true);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      release(signal.aborted);
    }
  }, options);
}
