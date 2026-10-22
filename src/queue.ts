import { PgBoss } from 'pg-boss';
import type { PgStore } from './store.js';
import type { SchoolProvider } from './provider.js';
import { executeJob } from './job-runner.js';
import { boundedWorkerOperation, workerPgOptions, type WorkerOperation } from './worker-bounds.js';

export const QUEUE = 'alms-playback';
export const workerQueueLimits = { maintenanceMs: 2000, operationMs: 5000, stopMs: 30_000 };
export function createQueueClient(databaseUrl: string) {
  return new PgBoss({ connectionString: databaseUrl, application_name: 'alms-worker', max: 5, ...workerPgOptions });
}

export async function dispatchOutbox(store: PgStore, boss: PgBoss, operation: WorkerOperation = { timeoutMs: 5000 }) {
  return store.workerTransaction(async query => {
    await query(`UPDATE job_outbox o SET dispatched_at=now() FROM playback_jobs j WHERE j.id=o.job_id AND o.dispatched_at IS NULL AND j.status NOT IN ('queued','scheduled')`);
    const { rows } = await query(`SELECT o.job_id,j.user_id,j.scheduled_for FROM job_outbox o JOIN playback_jobs j ON j.id=o.job_id WHERE o.dispatched_at IS NULL AND j.status IN ('queued','scheduled') AND j.accepted_generation IS NOT NULL ORDER BY j.created_at LIMIT 20 FOR UPDATE OF o SKIP LOCKED`);
    for (const row of rows) {
      // send() uses a separate bounded SQL connection. A delayed acknowledgement can leave a
      // queue entry, but rollback leaves this outbox retryable with the same deterministic ID.
      operation.signal?.throwIfAborted();
      await boss.send(QUEUE, { jobId: row.job_id }, { id: row.job_id, startAfter: row.scheduled_for, group: { id: row.user_id }, retryLimit: 0, expireInSeconds: 21600, heartbeatSeconds: 30 });
      await query('UPDATE job_outbox SET dispatched_at=now() WHERE job_id=$1', [row.job_id]);
    }
    return rows.length;
  }, operation);
}

export async function startWorker(store: PgStore, boss: PgBoss, provider: SchoolProvider, shutdown: AbortSignal, onError: (code: string) => void = () => {}, limits = workerQueueLimits) {
  const stopping = new AbortController();
  const signal = AbortSignal.any([shutdown, stopping.signal]);
  const operation = { signal, timeoutMs: limits.operationMs };
  await boss.start();
  await boss.createQueue(QUEUE, { retryLimit: 0, expireInSeconds: 21600, heartbeatSeconds: 30 });
  await store.quarantineLegacyJobs(operation);
  await store.recoverStaleJobs(operation);
  await dispatchOutbox(store, boss, operation);
  await boss.work<{ jobId: string }>(QUEUE, { batchSize: 1, localConcurrency: 1, groupConcurrency: 1, pollingIntervalSeconds: 1 }, async jobs => {
    for (const job of jobs) {
      // Losing the queue claim or stopping consumption aborts the runtime immediately.
      await executeJob(job.data.jobId, store, provider, AbortSignal.any([signal, job.signal]));
    }
  });
  let maintenance: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (maintenance || signal.aborted) return;
    maintenance = (async () => {
      await store.quarantineLegacyJobs(operation);
      await dispatchOutbox(store, boss, operation);
      signal.throwIfAborted();
      await store.recoverStaleJobs(operation);
      await store.workerTransaction(async query => {
        await query('DELETE FROM sessions WHERE expires_at<now()');
        await query("DELETE FROM login_attempts WHERE expires_at<now()-interval '1 hour'");
        await query("DELETE FROM analytics_receipts WHERE received_at<now()-interval '7 days'");
      }, operation);
    })().catch(() => { if (!signal.aborted) onError('WORKER_MAINTENANCE_FAILED'); }).finally(() => { maintenance = null; });
  }, limits.maintenanceMs);
  let stopped: Promise<void> | undefined;
  return () => stopped ??= (async () => {
    stopping.abort('shutdown');
    clearInterval(timer);
    // Stop new claims before waiting for maintenance; neither wait is allowed to be infinite.
    await boundedWorkerOperation(async () => {
      await Promise.all([boss.stop({ graceful: true, timeout: limits.stopMs }), maintenance]);
    }, { timeoutMs: limits.stopMs });
  })();
}
