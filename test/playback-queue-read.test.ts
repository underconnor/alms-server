import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PgStore } from '../src/store.js';

const emptySnapshot = { server_time: '2026-01-01T12:00:00.000Z', total: 0, active: 0,
  global_active_count: 0, global_active_status: null, global_active_observation: null,
  blocking_lease: false, items: [] };

function fixture(failure?: string, rollbackFailure = false, missingSnapshot = false) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [], releases: boolean[] = [];
  const original = new Error('synthetic-read-failure');
  let checkouts = 0;
  const pool = { query: async () => { throw new Error('Must use the checked-out connection'); },
    connect: async () => {
      checkouts++;
      return { query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const stage = sql.startsWith('WITH owned AS') ? 'snapshot' : sql;
        if (stage === failure) throw original;
        if (sql === 'ROLLBACK' && rollbackFailure) throw new Error('synthetic-rollback-failure');
        return { rows: stage === 'snapshot' && !missingSnapshot ? [emptySnapshot] : [] };
      }, release: (destroy: boolean) => { releases.push(destroy); } };
    },
  } as unknown as Pool;
  return { store: new PgStore(pool), calls, releases, original, checkouts: () => checkouts };
}

test('queue read uses one data statement in a read-only transaction with local JIT, preserving owner/course parameters', async () => {
  const f = fixture(), result = await f.store.getJobQueueSnapshot('synthetic-owner', '10');
  assert.equal(f.checkouts(), 1);
  assert.deepEqual(f.calls.map(call => call.sql.startsWith('WITH owned AS') ? 'snapshot' : call.sql),
    ['BEGIN READ ONLY', 'SET LOCAL jit=off', 'snapshot', 'COMMIT']);
  assert.deepEqual(f.calls[2]?.params, ['synthetic-owner', '10',
    ['running', 'reconciling', 'cancel_requested', 'pause_requested', 'queued', 'scheduled', 'paused'],
    ['running', 'reconciling', 'cancel_requested', 'pause_requested'], 200]);
  assert.deepEqual(f.releases, [false]);
  assert.deepEqual(result.counts, { active: 0, waiting: 0, total: 0 });
  assert.equal(result.serverTime, emptySnapshot.server_time);
  assert.equal(result.complete, true); assert.equal(result.hasMore, false);
});

for (const stage of ['BEGIN READ ONLY', 'SET LOCAL jit=off', 'snapshot', 'COMMIT']) {
  test(`queue ${stage} failure rolls back, preserves the original error and never retries the read`, async () => {
    const f = fixture(stage);
    await assert.rejects(f.store.getJobQueueSnapshot('synthetic-owner'), error => error === f.original);
    assert.equal(f.checkouts(), 1); assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.ok(f.calls.filter(call => call.sql.startsWith('WITH owned AS')).length <= 1);
    assert.deepEqual(f.releases, [false]);
  });
}

test('queue rollback failure destroys the connection and does not mask the initial read error', async () => {
  const f = fixture('snapshot', true);
  await assert.rejects(f.store.getJobQueueSnapshot('synthetic-owner'), error => error === f.original);
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK'); assert.deepEqual(f.releases, [true]);
});

test('queue response validation happens after transaction cleanup', async () => {
  const f = fixture(undefined, false, true);
  await assert.rejects(f.store.getJobQueueSnapshot('synthetic-owner'), /PLAYBACK_QUEUE_SNAPSHOT_MISSING/);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT'); assert.deepEqual(f.releases, [false]);
});
