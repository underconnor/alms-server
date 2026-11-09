import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PgSchoolReadCache, sealSchoolRead, type SchoolCacheScope } from '../src/school-read-cache.js';

const scope = (): SchoolCacheScope => ({ owner: randomUUID(), provider: 'ssu', generation: randomUUID(),
  resource: 'course:synthetic', encryptedSession: 'synthetic-school-envelope' });

test('valid cache hits and absent rows never enter corrupt-row cleanup', async () => {
  const key = randomBytes(32), selected = scope(), expiresAt = new Date(Date.now() + 60_000);
  const value = { title: 'synthetic course' }, sealed = sealSchoolRead(value, key, selected)!;
  for (const present of [true, false]) {
    let calls = 0;
    const pool = { query: async (sql: string) => {
      assert.match(sql, /^UPDATE school_read_cache/); calls++;
      return { rows: present ? [{ encrypted_payload: sealed.encrypted, expires_at: expiresAt }] : [] };
    } } as unknown as Pool;
    const result = await new PgSchoolReadCache(pool, key).get(selected);
    assert.deepEqual(result, present ? { value, expiresAt: expiresAt.getTime() } : null);
    assert.equal(calls, 1);
  }
});

test('corrupt-row cleanup binds every original read selector and the returned ciphertext', async () => {
  const key = randomBytes(32), supplied = scope(), original = { ...supplied }, corrupt = 'synthetic-corrupt-ciphertext';
  let calls = 0;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls++;
    if (calls === 1) {
      assert.match(sql, /^UPDATE school_read_cache/);
      assert.deepEqual(values, [original.owner, original.provider, original.generation, original.resource, original.encryptedSession]);
      // The caller's mutable scope cannot retarget cleanup after this query begins.
      Object.assign(supplied, scope(), { provider: 'other', resource: 'course:other' });
      return { rows: [{ encrypted_payload: corrupt, expires_at: new Date(Date.now() + 60_000) }] };
    }
    assert.match(sql, /^DELETE FROM school_read_cache c USING school_sessions s/);
    for (const predicate of ['c.user_id=$1', 'c.provider=$2', 'c.generation=$3', 'c.resource_key=$4',
      'c.encrypted_payload=$6', 's.user_id=c.user_id', 's.provider=c.provider', 's.encrypted_state=$5'])
      assert.ok(sql.includes(predicate));
    assert.doesNotMatch(sql, /IS NULL/);
    assert.deepEqual(values, [original.owner, original.provider, original.generation, original.resource, original.encryptedSession, corrupt]);
    return { rows: [], rowCount: 0 };
  } } as unknown as Pool;
  const cache = new PgSchoolReadCache(pool, key);
  cache.delete = async () => assert.fail('repair must not reuse explicit invalidation');
  assert.equal(await cache.get(supplied), null); assert.equal(calls, 2);
});

test('cleanup query failure retains the existing rejected-read behavior', async () => {
  const error = new Error('synthetic database failure'); let calls = 0;
  const pool = { query: async () => {
    if (++calls === 1) return { rows: [{ encrypted_payload: 'corrupt', expires_at: new Date() }] };
    throw error;
  } } as unknown as Pool;
  await assert.rejects(new PgSchoolReadCache(pool, randomBytes(32)).get(scope()), value => value === error);
  assert.equal(calls, 2);
});
