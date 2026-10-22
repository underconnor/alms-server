import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { hashToken, PgStore } from '../../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test', '/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');

describe('real PostgreSQL: login expiry after a row-lock wait', { skip: !databaseUrl }, () => {
  let pool: Pool; let store: PgStore;
  const attempts: string[] = [];
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    store = new PgStore(pool); await migrate(pool);
  });
  after(async () => {
    if (pool) {
      await pool.query('DELETE FROM login_attempts WHERE state_hash=ANY($1::text[])', [attempts]);
      await pool.end();
    }
  });

  it('concurrent consumers still allow one exact live binding and reject wrong state, wrong binding and replay', async () => {
    const stateHash = hashToken(randomUUID()); const bindingHash = hashToken(randomUUID());
    attempts.push(stateHash); await store.createLoginAttempt(stateHash, bindingHash);
    const results = await Promise.all([
      store.consumeLoginAttempt(stateHash, bindingHash),
      store.consumeLoginAttempt(stateHash, bindingHash),
      store.consumeLoginAttempt(stateHash, hashToken(randomUUID())),
      store.consumeLoginAttempt(hashToken(randomUUID()), bindingHash),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.slice(2), [false, false]);
    assert.equal(await store.consumeLoginAttempt(stateHash, bindingHash), false);
    const { rows: [row] } = await pool.query('SELECT consumed_at IS NOT NULL AS consumed FROM login_attempts WHERE state_hash=$1', [stateHash]);
    assert.equal(row.consumed, true);
  });

  it('a callback waiting for a row lock cannot consume an attempt after its wall-clock expiry', async () => {
    const stateHash = hashToken(randomUUID()); const bindingHash = hashToken(randomUUID());
    attempts.push(stateHash); await store.createLoginAttempt(stateHash, bindingHash);
    const consumer = await pool.connect(); const blocker = await pool.connect();
    const transactionStore = new PgStore(consumer as unknown as Pool);
    let pending: Promise<boolean> | undefined;
    let blocking = false;
    try {
      await consumer.query('BEGIN');
      const { rows: [clock] } = await consumer.query('SELECT now()::text AS started_at,pg_backend_pid() AS pid');
      await blocker.query('BEGIN'); blocking = true;
      // Keep the original live tuple visible to the consumer until its UPDATE is
      // waiting, then expose a deadline just after its fixed transaction clock.
      await blocker.query("UPDATE login_attempts SET expires_at=$2::timestamptz+interval '1 millisecond' WHERE state_hash=$1", [stateHash, clock.started_at]);
      pending = transactionStore.consumeLoginAttempt(stateHash, bindingHash);
      void pending.catch(() => undefined);
      let waiting = false;
      for (let poll = 0; poll < 200 && !waiting; poll++) {
        const { rows: [activity] } = await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [clock.pid]);
        waiting = activity?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'the consumer must really wait for the locked attempt');
      let { rows: [deadline] } = await blocker.query('SELECT expires_at::text AS expires_at,clock_timestamp()>expires_at AS expired FROM login_attempts WHERE state_hash=$1', [stateHash]);
      // Prove expiry before releasing the lock rather than assuming query latency.
      for (let poll = 0; poll < 200 && !deadline.expired; poll++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        ({ rows: [deadline] } = await blocker.query('SELECT expires_at::text AS expires_at,clock_timestamp()>expires_at AS expired FROM login_attempts WHERE state_hash=$1', [stateHash]));
      }
      assert.equal(deadline.expired, true);
      await blocker.query('COMMIT'); blocking = false;
      assert.equal(await pending, false);
      const { rows: [row] } = await consumer.query('SELECT consumed_at,expires_at::text AS expires_at FROM login_attempts WHERE state_hash=$1', [stateHash]);
      assert.equal(row.consumed_at, null); assert.equal(row.expires_at, deadline.expires_at);
    } finally {
      if (blocking) await blocker.query('ROLLBACK');
      if (pending) await pending.catch(() => undefined);
      await consumer.query('ROLLBACK'); consumer.release(); blocker.release();
    }
  });

  it('an unchanged row held by SELECT FOR UPDATE cannot be consumed after its wall-clock expiry', async () => {
    const stateHash = hashToken(randomUUID()); const bindingHash = hashToken(randomUUID());
    attempts.push(stateHash); await store.createLoginAttempt(stateHash, bindingHash);
    const consumer = await pool.connect(); const blocker = await pool.connect();
    const transactionStore = new PgStore(consumer as unknown as Pool);
    let pending: Promise<boolean> | undefined;
    let blocking = false;
    try {
      await consumer.query('BEGIN');
      const { rows: [backend] } = await consumer.query('SELECT pg_backend_pid() AS pid');
      // Commit one real deadline before locking; neither client changes this tuple afterward.
      await pool.query("UPDATE login_attempts SET expires_at=clock_timestamp()+interval '1 second' WHERE state_hash=$1", [stateHash]);
      await blocker.query('BEGIN'); blocking = true;
      const { rows: [locked] } = await blocker.query('SELECT expires_at::text AS expires_at FROM login_attempts WHERE state_hash=$1 FOR UPDATE', [stateHash]);
      pending = transactionStore.consumeLoginAttempt(stateHash, bindingHash);
      void pending.catch(() => undefined);
      let waiting = false;
      for (let poll = 0; poll < 200 && !waiting; poll++) {
        const { rows: [activity] } = await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [backend.pid]);
        waiting = activity?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'the consumption must wait for the unchanged locked row');
      let { rows: [deadline] } = await blocker.query('SELECT expires_at::text AS expires_at,clock_timestamp()>expires_at AS expired FROM login_attempts WHERE state_hash=$1', [stateHash]);
      assert.equal(deadline.expired, false, 'the waiting statement must begin while its deadline is live');
      for (let poll = 0; poll < 200 && !deadline.expired; poll++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        ({ rows: [deadline] } = await blocker.query('SELECT expires_at::text AS expires_at,clock_timestamp()>expires_at AS expired FROM login_attempts WHERE state_hash=$1', [stateHash]));
      }
      assert.equal(deadline.expired, true); assert.equal(deadline.expires_at, locked.expires_at);
      await blocker.query('COMMIT'); blocking = false;
      assert.equal(await pending, false);
      const { rows: [row] } = await consumer.query('SELECT consumed_at,expires_at::text AS expires_at FROM login_attempts WHERE state_hash=$1', [stateHash]);
      assert.equal(row.consumed_at, null); assert.equal(row.expires_at, locked.expires_at);
    } finally {
      if (blocking) await blocker.query('ROLLBACK');
      if (pending) await pending.catch(() => undefined);
      await consumer.query('ROLLBACK'); consumer.release(); blocker.release();
    }
  });
});
