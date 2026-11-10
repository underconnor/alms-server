import { PgBoss } from 'pg-boss';
import type { PgStore } from './store.js';
import type { SchoolProvider } from './provider.js';
import { executeJob } from './job-runner.js';
import { boundedWorkerOperation, workerPgOptions, type WorkerOperation } from './worker-bounds.js';
import { randomUUID } from 'node:crypto';
import { playbackAccountLock, playbackAccountLockKey } from './playback-lock.js';
import { playbackQueueLock, playbackQueueHead, playbackQueueBusy, deferUntouchedPlaybackDelivery } from './playback-queue-policy.js';

export const QUEUE = 'alms-playback';
export const workerQueueLimits = { maintenanceMs: 2000, operationMs: 5000, stopMs: 30_000 };
export function createQueueClient(databaseUrl: string) {
  return new PgBoss({ connectionString: databaseUrl, application_name: 'alms-worker', max: 5, ...workerPgOptions });
}

export async function dispatchOutbox(store: PgStore, boss: PgBoss, operation: WorkerOperation = { timeoutMs: 5000 }) {
  return store.workerTransaction(async query => {
    await query(playbackQueueLock);
    await query(`UPDATE job_outbox o SET dispatched_at=now() FROM playback_jobs j WHERE j.id=o.job_id AND o.dispatched_at IS NULL AND j.status NOT IN ('queued','scheduled')`);
    const { rows: [gate] } = await query(playbackQueueBusy);
    if (gate?.busy !== false) return 0;
    // Choose the head from every eligible due intent before considering its outbox.
    // A locked/dispatched head never permits a later job to overtake it.
    const { rows: [head] } = await query(playbackQueueHead);
    if (!head) return 0;
    await query(playbackAccountLock, [playbackAccountLockKey(head.user_id)]);
    const { rows: [outbox] } = await query('SELECT dispatched_at FROM job_outbox WHERE job_id=$1 FOR UPDATE SKIP LOCKED', [head.id]);
    if (!outbox) return 0;
    let { rows: [metadata] } = await query('SELECT dispatch_id FROM playback_queue_metadata WHERE job_id=$1 FOR UPDATE', [head.id]);
    if (!metadata) {
      metadata = { dispatch_id: outbox.dispatched_at ? head.id : randomUUID() };
      await query('INSERT INTO playback_queue_metadata(job_id,dispatch_id) VALUES($1,$2)', [head.id, metadata.dispatch_id]);
    }
    // The official pg-boss DB adapter keeps broker send/inspection, metadata and
    // outbox in this same transaction. An uncommitted message cannot be delivered.
    const db = { executeSql: (sql: string, values?: unknown[]) => query(sql, values) };
    if (outbox.dispatched_at) {
      const message = await boss.getJobById(QUEUE, metadata.dispatch_id, { db });
      if (message && !['completed', 'cancelled', 'failed'].includes(message.state)) return 0;
      // Claim timeout/legacy non-head delivery may have consumed only transport.
      // Recover it only while every proof of a prior execution remains absent.
      if (!await deferUntouchedPlaybackDelivery(query, head.id, metadata.dispatch_id)) return 0;
      ({ rows: [metadata] } = await query('SELECT dispatch_id FROM playback_queue_metadata WHERE job_id=$1', [head.id]));
    }
    if (!metadata) throw new Error('PLAYBACK_QUEUE_METADATA_MISSING');
    operation.signal?.throwIfAborted();
    const sent = await boss.send(QUEUE, { jobId: head.id }, { id: metadata.dispatch_id, db,
      group: { id: head.user_id }, retryLimit: 0, expireInSeconds: 21600, heartbeatSeconds: 30 });
    if (sent !== metadata.dispatch_id) throw new Error('PLAYBACK_QUEUE_SEND_UNCONFIRMED');
    await query('UPDATE job_outbox SET dispatched_at=now() WHERE job_id=$1', [head.id]);
    return 1;
  }, { ...operation, readCommitted: true });
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
      if (typeof job.id !== 'string' || !job.id) throw new Error('PLAYBACK_QUEUE_DELIVERY_MISSING');
      await executeJob(job.data.jobId, store, provider, AbortSignal.any([signal, job.signal]), 1000, {}, job.id);
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
