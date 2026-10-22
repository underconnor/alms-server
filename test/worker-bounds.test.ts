import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { boundedWorkerOperation, workerTransaction, WorkerDeadlineError } from '../src/worker-bounds.js';
import { shutdownWorker, workerShutdownTimeoutMs } from '../src/worker-shutdown.js';
import { workerQueueLimits } from '../src/queue.js';
import { readFile } from 'node:fs/promises';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function database(execute: (sql: string) => Promise<unknown> = async () => undefined) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const releases: boolean[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values }); await execute(sql); return { rows: [], rowCount: 0 };
    },
    release(destroy: boolean) { releases.push(destroy); },
  } as unknown as PoolClient;
  return { queries, releases, client, pool: { connect: async () => client } as unknown as Pool };
}

test('operation deadline aborts the underlying signal and ignores a late successful value', async () => {
  const gate = deferred<string>(); let signal!: AbortSignal;
  const result = boundedWorkerOperation(value => { signal = value; return gate.promise; }, { timeoutMs: 20 });
  await assert.rejects(result, WorkerDeadlineError);
  assert.equal(signal.aborted, true); gate.resolve('late'); await turn();
});

test('already aborted operation never calls its underlying task', async () => {
  const abort = new AbortController(); abort.abort(new Error('stopped')); let calls = 0;
  await assert.rejects(boundedWorkerOperation(async () => { calls++; }, { signal: abort.signal, timeoutMs: 100 }), /stopped/);
  assert.equal(calls, 0);
});

test('successful transaction sets local SQL bounds, commits once, and releases a reusable connection', async () => {
  const db = database();
  await workerTransaction(db.pool, query => query('UPDATE synthetic SET value=1'), { timeoutMs: 500 });
  assert.deepEqual(db.queries.map(query => query.sql), ['BEGIN', "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true),set_config('idle_in_transaction_session_timeout',$1,true)", 'UPDATE synthetic SET value=1', 'COMMIT']);
  assert.deepEqual(db.queries[1]!.values, ['500']);
  assert.deepEqual(db.releases, [false]);
});

test('a connection arriving after checkout expiry is destroyed once without executing SQL', async () => {
  const db = database(); const acquired = deferred<PoolClient>();
  const pool = { connect: () => acquired.promise } as unknown as Pool;
  await assert.rejects(workerTransaction(pool, query => query('UPDATE synthetic SET value=1'), { timeoutMs: 20 }), WorkerDeadlineError);
  acquired.resolve(db.client); await turn();
  assert.deepEqual(db.queries, []); assert.deepEqual(db.releases, [true]);
});

for (const interruption of ['abort', 'deadline'] as const) {
  test(`${interruption} destroys an active transaction and a late UPDATE cannot send COMMIT`, async () => {
    const entered = deferred<void>(); const update = deferred<void>(); const abort = new AbortController();
    const db = database(async sql => { if (sql.startsWith('UPDATE')) { entered.resolve(); await update.promise; } });
    const result = workerTransaction(db.pool, query => query('UPDATE synthetic SET value=1'), { signal: abort.signal, timeoutMs: interruption === 'deadline' ? 20 : 1000 });
    const rejected = assert.rejects(result); await entered.promise;
    if (interruption === 'abort') abort.abort();
    await rejected; assert.deepEqual(db.releases, [true]);
    update.resolve(); await turn();
    assert.equal(db.queries.some(query => query.sql === 'COMMIT'), false);
    assert.deepEqual(db.releases, [true]);
  });
}

test('a delayed COMMIT acknowledgement is unknown to the caller even if the server already accepted it', async () => {
  const ack = deferred<void>(); let accepted = 0;
  const db = database(async sql => { if (sql === 'COMMIT') { accepted++; await ack.promise; } });
  const result = workerTransaction(db.pool, query => query('UPDATE synthetic SET value=1'), { timeoutMs: 20 });
  await assert.rejects(result, WorkerDeadlineError);
  // Destroying a connection cannot undo a commit already accepted by PostgreSQL.
  assert.equal(accepted, 1); assert.deepEqual(db.releases, [true]);
  ack.resolve(); await turn(); assert.equal(accepted, 1);
});

test('shutdown aborts synchronously before draining consumers and closes the pool after their cleanup', async () => {
  const controller = new AbortController(); const order: string[] = [];
  const running = shutdownWorker({ controller, stop: [async () => { assert.equal(controller.signal.aborted, true); order.push('queue'); }, async () => { order.push('analytics'); }], close: async () => { order.push('pool'); }, failed: () => assert.fail('must drain'), timeoutMs: 1000 });
  assert.equal(controller.signal.aborted, true); await running;
  assert.deepEqual(order, ['queue', 'analytics', 'pool']);
});

for (const hanging of ['consumer', 'pool'] as const) {
  test(`shutdown is finite when the ${hanging} never resolves`, async () => {
    const never = new Promise<void>(() => {}); let failures = 0; let closed = 0;
    await assert.rejects(shutdownWorker({ controller: new AbortController(), stop: [() => hanging === 'consumer' ? never : Promise.resolve()], close: () => { closed++; return hanging === 'pool' ? never : Promise.resolve(); }, failed: () => { failures++; }, timeoutMs: 20 }), /WORKER_SHUTDOWN_FAILED/);
    assert.equal(failures, 1); assert.equal(closed, hanging === 'pool' ? 1 : 0);
  });
}

test('shutdown still stops every consumer and closes the pool when another consumer throws', async () => {
  let other = 0; let closed = 0; let failed = 0;
  await assert.rejects(shutdownWorker({ controller: new AbortController(), stop: [() => { throw new Error('synthetic'); }, async () => { other++; }], close: async () => { closed++; }, failed: () => { failed++; }, timeoutMs: 1000 }));
  assert.equal(other, 1); assert.equal(closed, 1); assert.equal(failed, 1);
});

test('SIGTERM exits a real child process when a consumer ignores cancellation', { timeout: 5000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { shutdownWorker } from './src/worker-shutdown.ts';
    const controller = new AbortController();
    process.once('SIGTERM', () => {
      void shutdownWorker({ controller, stop: [() => new Promise(() => {})], close: async () => {},
        failed: () => process.exit(controller.signal.aborted ? 23 : 24), timeoutMs: 30 }).catch(() => {});
    });
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data'); child.kill('SIGTERM');
    const [code, signal] = await exited; assert.equal(code, 23); assert.equal(signal, null);
  } finally { child.kill('SIGKILL'); }
});

// Cross-check the deployment grace period: Docker must not kill the worker before its own deadline.
test('the complete worker shutdown budget fits inside the Compose grace period', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const seconds = Number(/  worker:\n[\s\S]*?stop_grace_period:\s*(\d+)s/.exec(compose)?.[1]);
  assert.ok(Number.isFinite(seconds));
  assert.ok(workerShutdownTimeoutMs < seconds * 1000);
  assert.ok(workerQueueLimits.stopMs + 5000 <= workerShutdownTimeoutMs);
});
