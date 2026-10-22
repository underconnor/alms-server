import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { PgPlaybackReadiness, playbackIsReady } from '../../src/playback-worker-readiness.js';
const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw Error('Use isolated test database');
describe('private worker readiness in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool; const instances: string[] = [];
  const identity = () => ({ commit: randomBytes(20).toString('hex'), sdkSha256: randomBytes(32).toString('hex') });
  const instance = () => { const id = randomUUID(); instances.push(id); return id; };
  before(async () => { pool = new Pool({ connectionString: url, max: 5 }); await migrate(pool); await migrate(pool); });
  after(async () => { if (pool) { await pool.query('DELETE FROM playback_worker_readiness WHERE instance_id=ANY($1::uuid[])', [instances]); await pool.end(); } });
  it('only matching commit and installed SDK digest see readiness; no browser/session rows are required', async () => {
    const build = identity(), repo = new PgPlaybackReadiness(pool, build), id = instance();
    assert.equal(await repo.isReady(), false); await repo.renew(id); assert.equal(await repo.isReady(), true);
    assert.equal(await new PgPlaybackReadiness(pool, { ...build, commit: identity().commit }).isReady(), false);
    assert.equal(await new PgPlaybackReadiness(pool, { ...build, sdkSha256: identity().sdkSha256 }).isReady(), false);
    const row = (await pool.query('SELECT extract(epoch FROM ready_until-clock_timestamp()) AS remaining FROM playback_worker_readiness WHERE instance_id=$1', [id])).rows[0];
    assert.ok(Number(row.remaining) > 28 && Number(row.remaining) <= 30);
  });
  it('DB expiry prevents admission even while stale rows remain; renewal recovers only the exact release', async () => {
    const build = identity(), repo = new PgPlaybackReadiness(pool, build), id = instance(); await repo.renew(id);
    await pool.query("UPDATE playback_worker_readiness SET ready_until=clock_timestamp()-interval '1 millisecond' WHERE instance_id=$1", [id]);
    assert.equal(await repo.isReady(), false); await repo.renew(id); assert.equal(await repo.isReady(), true);
    await assert.rejects(new PgPlaybackReadiness(pool, { ...build, commit: identity().commit }).renew(id));
    assert.equal(await repo.isReady(), true);
  });
  it('one process cannot withdraw another instance or another release; last matching withdrawal disables readiness', async () => {
    const build = identity(), repo = new PgPlaybackReadiness(pool, build), a = instance(), b = instance(); await repo.renew(a); await repo.renew(b);
    await new PgPlaybackReadiness(pool, identity()).withdraw(a); assert.equal(await repo.isReady(), true);
    await repo.withdraw(a); assert.equal(await repo.isReady(), true);
    await repo.withdraw(b); assert.equal(await repo.isReady(), false);
  });
  it('cancelled reads are false and a row-lock-blocked renewal cannot commit after shutdown', async () => {
    const repo = new PgPlaybackReadiness(pool, identity()), id = instance(); await repo.renew(id);
    const locker = await pool.connect(), abort = new AbortController();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT instance_id FROM playback_worker_readiness WHERE instance_id=$1 FOR UPDATE', [id]);
      const before = (await locker.query('SELECT ready_until FROM playback_worker_readiness WHERE instance_id=$1', [id])).rows[0].ready_until;
      const pending = repo.renew(id, abort.signal).then(() => false, () => true);
      await new Promise(resolve => setTimeout(resolve, 30)); abort.abort(); assert.equal(await pending, true);
      assert.equal(await playbackIsReady(repo, abort.signal), false); await locker.query('ROLLBACK');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual((await pool.query('SELECT ready_until FROM playback_worker_readiness WHERE instance_id=$1', [id])).rows[0].ready_until, before);
      await repo.withdraw(id); assert.equal(await repo.isReady(), false);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
  });
});
