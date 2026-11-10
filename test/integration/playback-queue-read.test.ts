import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgStore } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('queue read JIT isolation and connection cleanup in PostgreSQL', { skip: !url }, () => {
  const schema = 'qa_queue_read_' + randomUUID().replaceAll('-', '');
  let admin: Pool, pool: Pool, owner: string, jobId: string;
  const settingsSql = `SELECT pg_backend_pid() AS pid,current_setting('jit') AS jit,
    current_setting('transaction_read_only') AS read_only,current_setting('statement_timeout') AS timeout`;
  before(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    // A different connection cannot accidentally make the reset assertions pass.
    pool = new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
    await migrate(pool);
    const store = new PgStore(pool);
    const session = await store.issueVerifiedSession({ provider: 'queue-read-qa', subject: randomUUID() }, 3600);
    const foreign = await store.issueVerifiedSession({ provider: 'queue-read-qa', subject: randomUUID() }, 3600);
    owner = session.user.id; jobId = randomUUID();
    for (const [id, user, course, status] of [[jobId, owner, '10', 'queued'],
      [randomUUID(), owner, '10', 'completed'], [randomUUID(), foreign.user.id, '10', 'queued'],
      [randomUUID(), owner, '11', 'queued']]) {
      await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash)
        VALUES($1,$2,$3,'20',$4,clock_timestamp(),$5,'synthetic-queue-read')`, [id, user, course, status, randomUUID()]);
    }
    await pool.query('SET jit=on');
  });
  after(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  const settings = async () => (await pool.query(settingsSql)).rows[0];
  const histories = async () => (await pool.query(`SELECT md5(string_agg(to_jsonb(job)::text,'' ORDER BY id)) AS hash FROM playback_jobs job`)).rows[0].hash;
  function observedStore(cancel = false) {
    const observed: Array<{ pid: number; jit: string; read_only: string; timeout: string }> = [];
    let reads = 0;
    const observedPool = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('WITH owned AS')) {
          reads++; observed.push((await client.query(settingsSql)).rows[0]);
          if (cancel) {
            await client.query("SET LOCAL statement_timeout='1ms'");
            await client.query('SELECT pg_sleep(0.05)');
          }
        }
        return client.query(sql, values);
      }, release: (destroy: boolean) => client.release(destroy) };
    } } as unknown as Pool;
    return { store: new PgStore(observedPool), observed, reads: () => reads };
  }
  async function assertRestored(before: Awaited<ReturnType<typeof settings>>) {
    const after = await settings();
    assert.deepEqual(after, before); // Includes the exact backend PID, not just defaults.
    assert.equal(after.jit, 'on'); assert.equal(after.read_only, 'off');
    // A fresh transaction must accept writes, proving the READ ONLY transaction ended.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE playback_jobs SET request_hash=request_hash WHERE false');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const next = await new PgStore(pool).getJobQueueSnapshot(owner, '10');
    assert.deepEqual(next.jobs.map(job => job.id), [jobId]);
    assert.deepEqual(await settings(), before);
  }
  it('disables JIT only during the read and returns owner/course counts with unchanged histories on the same pooled backend', async () => {
    const before = await settings(), hash = await histories(), f = observedStore();
    const result = await f.store.getJobQueueSnapshot(owner, '10');
    assert.equal(f.reads(), 1); assert.equal(f.observed.length, 1);
    assert.deepEqual(f.observed[0], { ...before, jit: 'off', read_only: 'on' });
    assert.deepEqual(result.counts, { active: 0, waiting: 1, total: 1 });
    assert.deepEqual(result.jobs.map(job => job.id), [jobId]); assert.equal(result.complete, true);
    await assertRestored(before); assert.equal(await histories(), hash);
  });
  it('a real SQL error rolls back local settings and leaves the same pooled backend usable without a retry', async () => {
    const before = await settings(), hash = await histories(), f = observedStore();
    await assert.rejects(f.store.getJobQueueSnapshot('synthetic-invalid-uuid', '10'), { code: '22P02' });
    assert.equal(f.reads(), 1); assert.deepEqual(f.observed[0], { ...before, jit: 'off', read_only: 'on' });
    await assertRestored(before); assert.equal(await histories(), hash);
  });
  it('a PostgreSQL statement cancellation also rolls back JIT and timeout settings on the same pooled backend', async () => {
    const before = await settings(), hash = await histories(), f = observedStore(true);
    await assert.rejects(f.store.getJobQueueSnapshot(owner, '10'), { code: '57014' });
    assert.equal(f.reads(), 1); assert.deepEqual(f.observed[0], { ...before, jit: 'off', read_only: 'on' });
    await assertRestored(before); assert.equal(await histories(), hash);
  });
});
