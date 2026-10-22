import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgSchoolReadCache, type SchoolCacheScope } from '../../src/school-read-cache.js';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test','/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');
describe('encrypted school JSON cache in real PostgreSQL', { skip: !databaseUrl }, () => {
  let pool: Pool, store: PgStore, cache: PgSchoolReadCache;
  const key = randomBytes(32), owners: string[] = [];
  async function user() {
    const subject = randomUUID(), encryptedSession = `synthetic-session-${randomUUID()}`;
    const session = await store.issueVerifiedSession({ provider: 'cache-integration', subject }, 3600, { provider: 'ssu', seal: () => encryptedSession });
    owners.push(session.user.id);
    const scope: SchoolCacheScope = { owner: session.user.id, provider: 'ssu', generation: randomUUID(), resource: 'course:synthetic', encryptedSession };
    return { session, scope, subject };
  }
  before(async () => { pool = new Pool({ connectionString: databaseUrl, max: 5 }); await migrate(pool); await migrate(pool); store = new PgStore(pool); cache = new PgSchoolReadCache(pool, key); });
  after(async () => { if (pool) { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); } });
  it('persists ciphertext across instances and isolates owner, generation, resource and current session', async () => {
    const a = await user(), b = await user(), value = { title: 'synthetic-private-cache-title', weeks: [1, 2] };
    assert.equal(await cache.put(a.scope, value, 60_000), true);
    const raw = (await pool.query('SELECT encrypted_payload FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rows[0].encrypted_payload;
    assert.doesNotMatch(raw, /synthetic-private-cache-title/);
    const another = new PgSchoolReadCache(pool, key);
    assert.deepEqual((await another.get(a.scope))?.value, value);
    assert.equal(await another.get({ ...a.scope, owner: b.scope.owner }), null);
    assert.equal(await another.get({ ...a.scope, generation: randomUUID() }), null);
    assert.equal(await another.get({ ...a.scope, resource: 'other' }), null);
    assert.equal(await another.get({ ...a.scope, encryptedSession: 'old-session' }), null);
    assert.equal(await another.put({ ...a.scope, encryptedSession: 'old-session' }, {}, 60_000), false);
  });
  it('does not return expired entries or copied ciphertext under another resource', async () => {
    const a = await user(); await cache.put(a.scope, { private: true }, 60_000);
    await pool.query("UPDATE school_read_cache SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.scope.owner]);
    assert.equal(await cache.get(a.scope), null);
    await cache.put(a.scope, { private: true }, 60_000);
    await pool.query("UPDATE school_read_cache SET resource_key='copied' WHERE user_id=$1", [a.scope.owner]);
    assert.equal(await cache.get({ ...a.scope, resource: 'copied' }), null);
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rowCount, 0);
  });
  it('new login and logout delete cached rows while late old writes are rejected', async () => {
    const a = await user(); await cache.put(a.scope, { private: true }, 60_000);
    const newer = await store.issueVerifiedSession({ provider: 'cache-integration', subject: a.subject }, 3600, { provider: 'ssu', seal: () => 'new-synthetic-session' });
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rowCount, 0);
    assert.equal(await cache.put(a.scope, { late: true }, 60_000), false);
    const next = { ...a.scope, generation: randomUUID(), encryptedSession: 'new-synthetic-session' };
    assert.equal(await cache.put(next, { current: true }, 60_000), true);
    await store.deleteSession(hashToken(newer.token));
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rowCount, 0);
    await store.deleteSession(hashToken(a.session.token));
    assert.equal(await cache.put(next, { late: true }, 60_000), false);
    assert.equal(await cache.get(next), null);
  });
  it('caps per-owner entry count and payload bytes without evicting another owner', async () => {
    const a = await user(), b = await user(); await cache.put(b.scope, { kept: true }, 60_000);
    for (let i = 0; i < 102; i++) await cache.put({ ...a.scope, resource: `course:${String(i).padStart(3, '0')}` }, { i }, 60_000);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rows[0].n), 100);
    await cache.delete(a.scope.owner, 'ssu');
    for (let i = 0; i < 10; i++) await cache.put({ ...a.scope, resource: `course:${i}` }, { bytes: 'x'.repeat(900_000) }, 60_000);
    const usage = (await pool.query('SELECT count(*) AS n,sum(octet_length(encrypted_payload)) AS bytes FROM school_read_cache WHERE user_id=$1', [a.scope.owner])).rows[0];
    assert.ok(Number(usage.bytes) <= 8 * 1024 * 1024); assert.ok(Number(usage.n) < 10);
    assert.deepEqual((await cache.get(b.scope))?.value, { kept: true });
    assert.equal(await cache.put(a.scope, { tooBig: 'x'.repeat(1024 * 1024) }, 60_000), false);
    assert.equal(await cache.put(a.scope, {}, 600_001), false);
  });
  it('batch deletion isolates owner/provider/resource while clearing all generations in one transaction', async () => {
    const a = await user(), b = await user();
    for (const resource of ['course:10', 'activity:10:20', 'calendar-modules:10', 'attendance:10', 'tasks', 'attendance', 'course:11', 'calendar-modules:11', 'saint:timetable'])
      await cache.put({ ...a.scope, resource }, { resource }, 60_000);
    await cache.put({ ...b.scope, resource: 'course:10' }, { other: true }, 60_000);
    await pool.query(`INSERT INTO school_read_cache(user_id,provider,generation,resource_key,encrypted_payload,payload_bytes,stored_bytes,expires_at)
      SELECT user_id,'other-provider',generation,resource_key,encrypted_payload,payload_bytes,stored_bytes,expires_at
      FROM school_read_cache WHERE user_id=$1 AND resource_key='course:10'`, [a.scope.owner]);
    await cache.deleteMany(a.scope.owner, 'ssu', ['course:10', 'activity:10:20', 'calendar-modules:10', 'attendance:10', 'tasks', 'attendance', 'course:10']);
    const remaining = (await pool.query('SELECT provider,resource_key FROM school_read_cache WHERE user_id=$1 ORDER BY provider,resource_key', [a.scope.owner])).rows;
    assert.deepEqual(remaining, [{ provider: 'other-provider', resource_key: 'course:10' }, { provider: 'ssu', resource_key: 'calendar-modules:11' }, { provider: 'ssu', resource_key: 'course:11' }, { provider: 'ssu', resource_key: 'saint:timetable' }]);
    assert.deepEqual((await cache.get({ ...b.scope, resource: 'course:10' }))?.value, { other: true });
  });
  it('aborted batch deletes roll back the actual blocked SQL and never commit after lock release', async () => {
    const a = await user(); await cache.put(a.scope, { kept: true }, 60_000);
    const locker = await pool.connect(), controller = new AbortController();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM school_read_cache WHERE user_id=$1 FOR UPDATE', [a.scope.owner]);
      const removing = cache.deleteMany(a.scope.owner, 'ssu', [a.scope.resource], controller.signal);
      const rejected = assert.rejects(removing);
      // Observe the actual blocked DELETE, then abort its checked-out connection.
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND query LIKE 'DELETE FROM school_read_cache WHERE user_id=$1 AND provider=$2 AND resource_key=ANY%' AND wait_event_type='Lock'`);
        if (rows.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true); controller.abort(); await rejected;
      await locker.query('ROLLBACK');
      assert.deepEqual((await cache.get(a.scope))?.value, { kept: true });
      await cache.deleteMany(a.scope.owner, 'ssu', [a.scope.resource]); assert.equal(await cache.get(a.scope), null);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
  });

});
