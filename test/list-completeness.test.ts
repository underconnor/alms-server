import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PgStore, hashToken, type Store } from '../src/store.js';
import { publicJob, type Job, type Session, type Todo } from '../src/domain.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { createJobResultCache } from '../src/job-result-cache.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const token = 'a'.repeat(43), owner = 'synthetic-owner', instant = '2030-01-01T00:00:00.000Z';
const headers = { cookie: '__Host-alms_session=' + token, origin: 'https://lms.flyjung.kr' };
const session: Session = { tokenHash: hashToken(token), csrfToken: 'synthetic-csrf', analyticsSessionId: randomUUID(),
  expiresAt: instant, user: { id: owner, displayName: null, analyticsId: randomUUID(), analyticsEnabled: true } };
const todo = (): Todo => ({ id: randomUUID(), title: '합성 할 일', completed: false, dueAt: null, createdAt: instant, updatedAt: instant });
const job = (patch: Partial<Job> = {}): Job => ({ id: randomUUID(), userId: owner, courseId: '10', lectureId: randomUUID(),
  status: 'completed', scheduledFor: instant, createdAt: instant, updatedAt: instant, schoolResult: null, errorCode: null,
  idempotencyKey: randomUUID(), requestHash: 'synthetic-private-hash', acceptedGeneration: null, executionTokenHash: null,
  executionOutcome: 'ended', ...patch });

for (const count of [0, 499, 500, 501]) test(`personal TODO list reports exact completeness for ${count} owned rows`, async () => {
  const rows = Array.from({ length: count }, todo), calls: unknown[] = [];
  const store = { getSession: async () => session, listTodos: async (...args: unknown[]) => { calls.push(args); return rows; } } as unknown as Store;
  const app = await buildApp(config, store);
  try {
    const response = await app.inject({ url: '/v1/todos', headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { items: rows.slice(0, 500), complete: count <= 500, hasMore: count > 500, limit: 500 });
    assert.deepEqual(calls, [[owner, 501]]);
    assert.equal(response.json().total, undefined); assert.equal(response.json().nextCursor, undefined);
  } finally { await app.close(); }
});

for (const count of [0, 199, 200, 201]) test(`playback job list reports exact completeness for ${count} owned rows`, async () => {
  const rows = Array.from({ length: count }, () => job()), calls: unknown[] = [];
  const store = { getSession: async () => session, listJobs: async (...args: unknown[]) => { calls.push(args); return rows; } } as unknown as Store;
  const app = await buildApp(config, store);
  try {
    const response = await app.inject({ url: '/v1/jobs?courseId=10', headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { items: rows.slice(0, 200).map(publicJob), complete: count <= 200, hasMore: count > 200, limit: 200 });
    assert.deepEqual(calls, [[owner, '10', 201]]);
    assert.doesNotMatch(response.body, /synthetic-private-hash|acceptedGeneration|executionTokenHash|userId/);
  } finally { await app.close(); }
});

test('list completeness preserves authentication and owner/course scope', async () => {
  const ownTodo = todo(), ownJob = job(); let reads = 0;
  const store = {
    getSession: async (hash: string) => hash === hashToken(token) ? session : hash === hashToken('b'.repeat(43))
      ? { ...session, user: { ...session.user, id: 'other-owner' } } : null,
    listTodos: async (user: string) => { reads++; return user === owner ? [ownTodo] : []; },
    listJobs: async (user: string, course?: string) => { reads++; return user === owner && (!course || course === ownJob.courseId) ? [ownJob] : []; },
  } as unknown as Store;
  const app = await buildApp(config, store);
  try {
    for (const url of ['/v1/todos', '/v1/jobs']) assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(reads, 0);
    for (const url of ['/v1/todos', '/v1/jobs?courseId=10']) {
      const response = await app.inject({ url, headers: { ...headers, cookie: '__Host-alms_session=' + 'b'.repeat(43) } });
      assert.deepEqual(response.json(), { items: [], complete: true, hasMore: false, limit: url === '/v1/todos' ? 500 : 200 });
    }
    assert.deepEqual((await app.inject({ url: '/v1/jobs?courseId=11', headers })).json(), { items: [], complete: true, hasMore: false, limit: 200 });
    assert.equal((await app.inject({ url: '/v1/jobs?courseId=10&extra=1', headers })).statusCode, 400);
  } finally { await app.close(); }
});

test('hidden job sentinel neither expands legacy Accept protection nor refreshes school result caches', async () => {
  const rows = [...Array.from({ length: 200 }, () => job()), job({ acceptedGeneration: randomUUID(), executionTokenHash: 'b'.repeat(64) })];
  const refreshed: unknown[] = [], cache = createJobResultCache(async (user, targets) => { refreshed.push({ user, targets }); });
  const store = { getSession: async () => session, listJobs: async () => rows } as unknown as Store;
  const app = await buildApp(config, store, unavailableSchoolProvider, undefined, undefined, undefined, cache);
  try {
    const response = await app.inject({ url: '/v1/jobs', headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().hasMore, true); assert.equal(response.json().items.length, 200);
    assert.equal(refreshed.length, 1);
    assert.deepEqual(refreshed, [{ user: owner, targets: rows.slice(0, 200).map(row => ({ courseId: row.courseId, lectureId: row.lectureId })) }]);
    rows[0]!.acceptedGeneration = randomUUID();
    assert.equal((await app.inject({ url: '/v1/jobs', headers })).statusCode, 409);
    assert.equal((await app.inject({ url: '/v1/jobs', headers: { ...headers, accept: playbackClientAccept } })).statusCode, 200);
  } finally { await app.close(); }
});

test('PostgreSQL list queries retain bounded defaults, scoped sentinels and deterministic tie order', async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const store = new PgStore({ query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); return { rows: [] }; } } as unknown as Pool);
  await store.listTodos(owner); await store.listTodos(owner, 501);
  await store.listJobs(owner); await store.listJobs(owner, '10', 201);
  assert.deepEqual(calls.map(call => call.args), [[owner, 500], [owner, 501], [owner, null, 200], [owner, '10', 201]]);
  for (const call of calls.slice(0, 2)) assert.match(call.sql, /WHERE user_id=\$1 ORDER BY created_at DESC,id DESC LIMIT \$2$/);
  for (const call of calls.slice(2)) assert.match(call.sql, /WHERE job.user_id=\$1 AND \(\$2::text IS NULL OR job.course_id=\$2\) ORDER BY job.created_at DESC,job.id DESC LIMIT \$3$/);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 502]) await assert.rejects(store.listTodos(owner, limit), RangeError);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 202]) await assert.rejects(store.listJobs(owner, undefined, limit), RangeError);
  assert.equal(calls.length, 4);
});
