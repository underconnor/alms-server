import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { PgSchoolReadCache } from '../src/school-read-cache.js';

test('related source invalidation rejects unbounded or nonnumeric selectors before checking out SQL', async () => {
  let connections = 0;
  const pool = { connect: async () => { connections++; throw new Error('must not connect'); } } as unknown as Pool;
  const cache = new PgSchoolReadCache(pool, randomBytes(32));
  for (const ids of [Array(101).fill('10'), ['10%'], ['10:90'], ['0'], ['1'.repeat(17)], [''], ['owner-b']])
    await assert.rejects(cache.deleteRelated('a', 'ssu', 'generation', ids, 'assignments:10'), /CACHE_RESOURCE_LIMIT/);
  for (const exclude of ['', 'x'.repeat(513)])
    await assert.rejects(cache.deleteRelated('a', 'ssu', 'generation', ['10'], exclude), /CACHE_RESOURCE_LIMIT/);
  for (const generation of ['', 'x'.repeat(201)])
    await assert.rejects(cache.deleteRelated('a', 'ssu', generation, ['10'], 'assignments:10'), /CACHE_RESOURCE_LIMIT/);
  assert.equal(connections, 0);
});
test('already aborted related invalidation never obtains a SQL connection', async () => {
  let connections = 0;
  const cache = new PgSchoolReadCache({ connect: async () => { connections++; throw new Error('must not connect'); } } as unknown as Pool, randomBytes(32));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.deleteRelated('a', 'ssu', 'generation', ['10'], 'assignments:10', controller.signal));
  assert.equal(connections, 0);
});
