import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { LearningxClient } from '@alms/ssu-api';
import { PgSchoolReadCache } from '../../src/school-read-cache.js';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createLearningxReader } from '../../src/school-reader.js';
import { encryptSchoolSession } from '../../src/crypto.js';
import { schoolHistoryFixture } from '../helpers/assignment-history-fixture.js';
import { assignmentFixture } from '../helpers/assignment-fixture.js';
import { assignmentCatalogFixture } from '../helpers/assignment-catalog-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test', '/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');
describe('own history encrypted cache with synthetic school data in isolated PostgreSQL', { skip: !databaseUrl }, () => {
  let pool: Pool, store: PgStore; const key = randomBytes(32), owners: string[] = [];
  const identity = { provider: 'history-integration', subject: randomUUID() };
  const schoolState = (generation = randomUUID()) => ({ provider: 'ssu', seal: (owner: string) =>
    encryptSchoolSession({ version: 1, generation, identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu') });
  before(async () => { pool = new Pool({ connectionString: databaseUrl, max: 5, statement_timeout: 5000 }); await migrate(pool); store = new PgStore(pool); });
  after(async () => { if (pool) { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); } });
  it('persists private history across reader instances while HMAC keys and cache rows stay owner/generation scoped', async () => {
    const a = await store.issueVerifiedSession(identity, 3600, schoolState()), b = await store.issueVerifiedSession(
      { ...identity, subject: randomUUID() }, 3600, schoolState()); owners.push(a.user.id, b.user.id);
    let reads = 0, connects = 0;
    const source = schoolHistoryFixture(); source.items[1]!.content.text = { state: 'available', value: 'synthetic-private-history-content' };
    const reader = () => createLearningxReader(store, key, async () => { connects++; return { client: {
      terms: async () => [{ id: '1', name: 'Synthetic current', default: true }],
      courses: async () => [{ id: '10', name: 'Synthetic course', termId: '1' }],
      assignmentSubmissionHistory: async () => { reads++; return structuredClone(source); },
    } as unknown as LearningxClient, serialize: async () => ({}) }; }, undefined, new PgSchoolReadCache(pool, key), undefined, null);
    const options = (session: typeof a) => ({ signal: AbortSignal.timeout(10_000), validate: async () => {
      assert.ok(await store.getSession(hashToken(session.token))); } });
    const first = await reader().readAssignmentHistory!(a.user.id, '10', '90', options(a));
    const raw = (await pool.query('SELECT encrypted_payload FROM school_read_cache WHERE user_id=$1 AND resource_key=$2',
      [a.user.id, 'assignment-history:10:90'])).rows;
    assert.equal(raw.length, 1); assert.doesNotMatch(raw[0].encrypted_payload, /synthetic-private-history-content/);
    const restored = await reader().readAssignmentHistory!(a.user.id, '10', '90', options(a));
    assert.deepEqual(restored, first); assert.equal(reads, 1); assert.equal(connects, 1);
    const other = await reader().readAssignmentHistory!(b.user.id, '10', '90', options(b));
    assert.notEqual(other.items![0]!.key, first.items![0]!.key); assert.equal(reads, 2);
    const newer = await store.issueVerifiedSession(identity, 3600, schoolState());
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1', [a.user.id])).rowCount, 0);
    const replacement = await reader().readAssignmentHistory!(newer.user.id, '10', '90', options(newer));
    assert.notEqual(replacement.items![0]!.key, first.items![0]!.key); assert.equal(reads, 3);
    await store.deleteSession(hashToken(newer.token));
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1', [a.user.id])).rowCount, 0);
    await assert.rejects(reader().readAssignmentHistory!(a.user.id, '10', '90', options(newer)));
    assert.equal(reads, 3);
    assert.equal((await pool.query('SELECT 1 FROM school_read_cache WHERE user_id=$1 AND resource_key=$2', [b.user.id, 'assignment-history:10:90'])).rowCount, 1);
  });
  it('persists past assignment course context encrypted and preserves it across reader restarts', async () => {
    const session = await store.issueVerifiedSession({ ...identity, subject: randomUUID() }, 3600, schoolState()); owners.push(session.user.id);
    let reads = 0;
    const reader = () => createLearningxReader(store, key, async () => ({ client: {
      terms: async () => [{ id: '1', name: '2099 Current', default: true }, { id: '2', name: '2098 Past', default: false }],
      courses: async (terms: string[]) => [{ id: '20', name: 'Synthetic private past context', termId: '2', ended: true }].filter(course => terms.includes(course.termId)),
      assignmentDetail: async () => { reads++; const value = assignmentFixture(); value.courseId = '20'; value.sourceUrl = null; return value; },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, new PgSchoolReadCache(pool, key), undefined, null);
    const options = { signal: AbortSignal.timeout(10_000), validate: async () => { assert.ok(await store.getSession(hashToken(session.token))); } };
    const first = await reader().readAssignment!(session.user.id, '20', '90', options);
    assert.deepEqual(first.course, { id: '20', title: 'Synthetic private past context', term: '2098 Past', termId: '2', schoolDefaultTerm: false, ended: true });
    const raw = (await pool.query('SELECT encrypted_payload FROM school_read_cache WHERE user_id=$1 AND resource_key=$2', [session.user.id, 'assignment:20:90'])).rows;
    assert.equal(raw.length, 1); assert.doesNotMatch(raw[0].encrypted_payload, /Synthetic private past context|2098 Past/);
    assert.deepEqual(await reader().readAssignment!(session.user.id, '20', '90', options), first); assert.equal(reads, 1);
  });
  it('reuses encrypted exact current catalog for cold assignment reads while actual SDK authority stays fresh and owner/generation scoped', async () => {
    const who = { ...identity, subject: randomUUID() }, a = await store.issueVerifiedSession(who, 3600, schoolState()),
      b = await store.issueVerifiedSession({ ...identity, subject: randomUUID() }, 3600, schoolState()); owners.push(a.user.id, b.user.id);
    const f = assignmentCatalogFixture(store, key, new PgSchoolReadCache(pool, key));
    const options = (session: typeof a) => ({ signal: AbortSignal.timeout(10_000), validate: async () => { assert.ok(await store.getSession(hashToken(session.token))); } });
    await f.reader().catalog(a.user.id);
    const first = await f.reader().readAssignment!(a.user.id, '10', '90', options(a));
    await f.reader().readAssignments!(a.user.id, '10', options(a));
    await f.reader().readAssignmentHistory!(a.user.id, '10', '90', options(a));
    assert.equal(f.count('backend_terms'), 1); assert.equal(f.count('sdk_self'), 3); assert.equal(f.count('sdk_courses'), 3);
    const raw = (await pool.query('SELECT encrypted_payload FROM school_read_cache WHERE user_id=$1', [a.user.id])).rows;
    assert.ok(raw.length >= 4); raw.forEach(row => assert.doesNotMatch(row.encrypted_payload, /Synthetic|submitted text/));
    const before = [...f.trace]; assert.deepEqual(await f.reader().readAssignment!(a.user.id, '10', '90', options(a)), first); assert.deepEqual(f.trace, before);
    await pool.query("UPDATE school_read_cache SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND resource_key='catalog'", [a.user.id]);
    await f.reader().readAssignment!(a.user.id, '10', '91', options(a)); assert.equal(f.count('backend_terms'), 2);
    await f.reader().readAssignment!(b.user.id, '10', '90', options(b)); assert.equal(f.count('backend_terms'), 3);
    const newer = await store.issueVerifiedSession(who, 3600, schoolState());
    await f.reader().readAssignment!(newer.user.id, '10', '90', options(newer)); assert.equal(f.count('backend_terms'), 4);
    f.state.sdkCurrent = false;
    await assert.rejects(f.reader().readAssignment!(newer.user.id, '10', '91', options(newer)), { statusCode: 502 });
    assert.equal(f.count('backend_terms'), 4); assert.equal(f.count('sdk_self'), 7);
  });
});
