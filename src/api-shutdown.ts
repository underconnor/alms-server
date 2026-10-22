import { boundedWorkerOperation } from './worker-bounds.js';

export const apiDrainTimeoutMs = 7_000;
export const apiPoolCloseTimeoutMs = 2_000;
export const apiShutdownHardLimitMs = 9_500;

/** Fastify onClose runs in reverse registration order. The final server hook must
 * drain all consumers before the pool; repeated registrar closes reuse their one promise. */
export function createApiResourceCloser(consumers: Array<() => Promise<void>>, closePool: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    let failed = false;
    try {
      const results = await boundedWorkerOperation(() => Promise.allSettled(consumers.map(close => Promise.resolve().then(close))), { timeoutMs: apiDrainTimeoutMs });
      failed = results.some(result => result.status === 'rejected');
    } catch { failed = true; }
    try { await boundedWorkerOperation(closePool, { timeoutMs: apiPoolCloseTimeoutMs }); }
    catch { failed = true; }
    if (failed) throw new Error('API_SHUTDOWN_FAILED');
  })();
}
