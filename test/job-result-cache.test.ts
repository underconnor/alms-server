import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createJobResultCache } from '../src/job-result-cache.js';
import { progressCacheResources } from '../src/school-progress-cache.js';
import { AppError } from '../src/errors.js';
import type { Job, Session } from '../src/domain.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken, type Store } from '../src/store.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { unavailableSchoolProvider } from '../src/provider.js';

const token = 'a'.repeat(43);
const session = (): Session => ({ tokenHash: hashToken(token), csrfToken: 'synthetic-csrf', analyticsSessionId: randomUUID(),
  expiresAt: '2030-01-01T00:00:00Z', user: { id: 'synthetic-owner', displayName: null, analyticsId: randomUUID(), analyticsEnabled: true } });
const job = (patch: Partial<Job> = {}): Job => ({ id: randomUUID(), userId: 'synthetic-owner', courseId: '10', lectureId: '20',
  status: 'completed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', scheduledFor: '2026-01-01T00:00:00Z',
  schoolResult: { observedAt: '2026-01-02T00:00:00Z', progressPercent: 100, attendance: 'unknown', recognized: null }, errorCode: null,
  idempotencyKey: randomUUID(), requestHash: 'synthetic-private-request', acceptedGeneration: 'synthetic-generation', executionTokenHash: 'synthetic-secret', executionOutcome: 'ended', ...patch });
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('initial terminal snapshots batch target duplicates, repeated reads skip, changed result and new session refresh', async () => {
  const calls: unknown[] = [], cache = createJobResultCache(async (owner, targets) => { calls.push({ owner, targets }); });
  const s = session(), jobs = Array.from({ length: 200 }, (_, i) => job({ lectureId: String(i % 2 + 20) }));
  await cache.refresh(s, jobs, options());
  assert.deepEqual(calls, [{ owner: s.user.id, targets: [{ courseId: '10', lectureId: '20' }, { courseId: '10', lectureId: '21' }] }]);
  await cache.refresh(s, jobs, options()); assert.equal(calls.length, 1);
  await cache.refresh(s, [{ ...jobs[0]!, schoolResult: { ...jobs[0]!.schoolResult!, observedAt: '2026-01-03T00:00:00Z' } }], options());
  assert.equal(calls.length, 2);
  await cache.refresh({ ...s, tokenHash: 'new-synthetic-session' }, [jobs[0]!], options()); assert.equal(calls.length, 3);
  await cache.refresh(s, [{ ...jobs[0]!, executionOutcome: 'interrupted' }], options()); assert.equal(calls.length, 4);
});

test('each terminal state refreshes without inferring success; active work does not refresh', async () => {
  let calls = 0; const cache = createJobResultCache(async () => { calls++; });
  for (const status of ['completed', 'succeeded', 'cancelled', 'failed', 'needs_reauthentication', 'needs_verification'] as const)
    await cache.refresh(session(), [job({ status, schoolResult: null })], options());
  assert.equal(calls, 6);
  for (const status of ['queued', 'scheduled', 'running', 'pause_requested', 'paused', 'cancel_requested', 'reconciling'] as const)
    await cache.refresh(session(), [job({ status })], options());
  assert.equal(calls, 6);
});

test('concurrent same-owner reads coalesce; another owner stays independent', async () => {
  const held = deferred(), entered = deferred(); let calls = 0;
  const cache = createJobResultCache(async owner => { calls++; if (owner === 'synthetic-owner') { entered.resolve(); await held.promise; } });
  const s = session(), jobs = [job()], a = cache.refresh(s, jobs, options()); await entered.promise;
  const b = cache.refresh(s, jobs, options());
  await cache.refresh({ ...s, user: { ...s.user, id: 'other-owner' } }, [job({ userId: 'other-owner' })], options());
  assert.equal(calls, 2); held.resolve(); await Promise.all([a, b]); assert.equal(calls, 2);
});

test('failure or final logout never records a completed marker, allowing explicit next read to retry', async () => {
  let calls = 0, fail = true, current = true;
  const cache = createJobResultCache(async () => { calls++; if (fail) throw new Error('synthetic-secret'); });
  const s = session(), jobs = [job()];
  await assert.rejects(cache.refresh(s, jobs, options()), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
  fail = false; await cache.refresh(s, jobs, options()); assert.equal(calls, 2);
  const second = createJobResultCache(async () => { calls++; current = false; });
  const check = async () => { if (!current) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.'); };
  await assert.rejects(second.refresh(s, jobs, { ...options(), validate: check }), { code: 'AUTH_REQUIRED' });
  current = true; await assert.rejects(second.refresh(s, jobs, { ...options(), validate: check }), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 4);
});

test('timeout rejects promptly, aborts work and coalesces unresolved late operations without success markers', async () => {
  const held = deferred(); let calls = 0, observed: AbortSignal | undefined;
  const cache = createJobResultCache(async (_owner, _targets, signal) => { calls++; observed = signal; await held.promise; },
    { timeoutMs: 20, maxMarkers: 10, maxPendingOwners: 2, ttlMs: 1000 });
  const s = session(), jobs = [job()];
  await assert.rejects(cache.refresh(s, jobs, options()), { code: 'SCHOOL_RESULT_UNAVAILABLE' }); assert.equal(observed?.aborted, true);
  await assert.rejects(cache.refresh(s, jobs, options()), { code: 'SCHOOL_RESULT_UNAVAILABLE' }); assert.equal(calls, 1);
  held.resolve(); await delay(0);
  await cache.refresh(s, jobs, options()); assert.equal(calls, 2);
});

test('cancelled caller cannot publish late success and snapshot is detached from caller mutation', async () => {
  const held = deferred(), entered = deferred(); let calls = 0;
  const cache = createJobResultCache(async () => { calls++; entered.resolve(); await held.promise; });
  const controller = new AbortController(), s = session(), jobs = [job()];
  const result = cache.refresh(s, jobs, { ...options(), signal: controller.signal }); await entered.promise;
  controller.abort(); await assert.rejects(result, { code: 'SCHOOL_RESULT_UNAVAILABLE' });
  held.resolve(); await delay(0); await cache.refresh(s, jobs, options()); assert.equal(calls, 2);
  const targets: unknown[] = [], mutated = job(), original = { ...mutated };
  const detached = createJobResultCache(async (_o, value) => { targets.push(value); mutated.lectureId = '99'; });
  await detached.refresh(s, [mutated], options()); await detached.refresh(s, [original], options());
  assert.deepEqual(targets, [[{ courseId: '10', lectureId: '20' }]]);
});

test('bounded markers evict without looping, TTL expires, and excessive/unowned batches never invalidate', async () => {
  let calls = 0; const cache = createJobResultCache(async () => { calls++; }, { timeoutMs: 200, maxMarkers: 2, maxPendingOwners: 2, ttlMs: 15 });
  const s = session(), jobs = [job(), job(), job()];
  await cache.refresh(s, jobs, options()); assert.equal(calls, 1);
  await cache.refresh(s, [jobs[0]!], options()); assert.equal(calls, 2);
  await delay(20); await cache.refresh(s, [jobs[0]!], options()); assert.equal(calls, 3);
  await assert.rejects(cache.refresh(s, [job({ userId: 'other' })], options()));
  await assert.rejects(cache.refresh(s, Array.from({ length: 201 }, () => job()), options())); assert.equal(calls, 3);
});

test('progress resources are a bounded union and never include timetable, unrelated courses or bytes', () => {
  assert.deepEqual(progressCacheResources([{ courseId: '10', lectureId: '20' }, { courseId: '10', lectureId: '20' }, { courseId: '10', lectureId: '21' }]),
    ['course:10', 'activity:10:20', 'calendar-modules:10', 'tasks', 'attendance', 'attendance:10', 'activity:10:21']);
  assert.equal(progressCacheResources(Array.from({ length: 200 }, (_, i) => ({ courseId: String(i), lectureId: String(i) }))).length, 802);
  assert.throws(() => progressCacheResources([{ courseId: '../escape', lectureId: '20' }]));
  assert.throws(() => progressCacheResources(Array.from({ length: 201 }, () => ({ courseId: '10', lectureId: '20' }))));
});

async function routeFixture(invalidate: Parameters<typeof createJobResultCache>[0]) {
  const s = session(), value = job(); let authenticated = true;
  const store = { getSession: async () => authenticated ? s : null, listJobs: async () => [value], getJob: async () => value } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, unavailableSchoolProvider,
    undefined, undefined, undefined, createJobResultCache(invalidate));
  const headers = { cookie: '__Host-alms_session=' + token, accept: playbackClientAccept };
  return { app, headers, value, logout: () => { authenticated = false; } };
}
test('list/single job responses await invalidation, share markers and preserve nullable school results/public DTO', async () => {
  const held = deferred(), entered = deferred(); let calls = 0, resolved = false;
  const f = await routeFixture(async () => { calls++; entered.resolve(); await held.promise; });
  try {
    const pending = f.app.inject({ url: '/v1/jobs', headers: f.headers }).then(value => { resolved = true; return value; });
    await entered.promise; assert.equal(resolved, false); held.resolve();
    const list = await pending, single = await f.app.inject({ url: '/v1/jobs/' + f.value.id, headers: f.headers });
    assert.equal(list.statusCode, 200); assert.equal(single.statusCode, 200); assert.equal(calls, 1);
    assert.equal(list.json().items[0].schoolResult.recognized, null); assert.deepEqual(single.json(), list.json().items[0]);
    assert.doesNotMatch(list.body, /synthetic-secret|synthetic-private|acceptedGeneration|executionTokenHash/);
  } finally { await f.app.close(); }
});
test('route errors remain errors, no marker on failure, old clients and unowned jobs cannot invalidate', async () => {
  let calls = 0, fail = true; const f = await routeFixture(async () => { calls++; if (fail) throw new Error('private-target-secret'); });
  try {
    const old = await f.app.inject({ url: '/v1/jobs', headers: { cookie: f.headers.cookie } }); assert.equal(old.statusCode, 409); assert.equal(calls, 0);
    const error = await f.app.inject({ url: '/v1/jobs', headers: f.headers });
    assert.equal(error.statusCode, 503); assert.equal(error.json().error.code, 'SCHOOL_RESULT_UNAVAILABLE'); assert.doesNotMatch(error.body, /private-target-secret|items|schoolResult/);
    fail = false; assert.equal((await f.app.inject({ url: '/v1/jobs', headers: f.headers })).statusCode, 200); assert.equal(calls, 2);
    f.value.userId = 'foreign'; assert.equal((await f.app.inject({ url: '/v1/jobs/' + f.value.id, headers: f.headers })).statusCode, 503); assert.equal(calls, 2);
  } finally { await f.app.close(); }
});
test('logout during invalidation rejects the result and future request authentication', async () => {
  const f = await routeFixture(async () => { f.logout(); });
  try {
    const response = await f.app.inject({ url: '/v1/jobs', headers: f.headers }); assert.equal(response.statusCode, 401); assert.equal(response.json().items, undefined);
    assert.equal((await f.app.inject({ url: '/v1/jobs', headers: f.headers })).statusCode, 401);
  } finally { await f.app.close(); }
});
