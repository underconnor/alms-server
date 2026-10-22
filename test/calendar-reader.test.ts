import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { AppError } from '../src/errors.js';
import { schoolCacheTtl, type SchoolReadCache, type SchoolCacheScope } from '../src/school-read-cache.js';
const query = { start: '2099-10-01', end: '2099-11-01' };
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture(hooks: { calendar?: () => Promise<void>; afterGet?: () => Promise<void>; afterCas?: () => Promise<void> } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b');
  let courseIds = ['10'], calendarReads = 0, catalogReads = 0, seenSignal: AbortSignal | undefined;
  const entries = new Map<string, { value: unknown; expiresAt: number }>(), writes: SchoolCacheScope[] = [];
  const cacheKey = (scope: SchoolCacheScope) => `${scope.owner}/${scope.generation}/${scope.resource}`;
  const durable: SchoolReadCache = { get: async <T>(scope: SchoolCacheScope) => entries.get(cacheKey(scope)) as { value: T; expiresAt: number } ?? null,
    put: async (scope, value, ttl) => { assert.equal(scope.encryptedSession, states.get(scope.owner)); writes.push(scope); entries.set(cacheKey(scope), { value, expiresAt: Date.now() + ttl }); return true; },
    delete: async (owner, _provider, resource) => { for (const k of entries.keys()) if (k.startsWith(owner + '/') && (!resource || k.endsWith('/' + resource))) entries.delete(k); } };
  const create = () => createLearningxReader({ getEncryptedSchoolSession: async owner => { const value = states.get(owner) ?? null; await hooks.afterGet?.(); return value; },
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => { if (states.get(owner) !== previous) return false; states.set(owner, next); await hooks.afterCas?.(); return true; } }, key,
    async (_session, signal) => { seenSignal = signal; return { client: {
      terms: async () => [{ id: '1', name: '합성 학기', default: true }],
      courses: async () => { catalogReads++; return courseIds.map(id => ({ id, name: '합성 강좌 ' + id, termId: '1' })); },
      calendar: async (input: typeof query, signal: AbortSignal) => { calendarReads++; seenSignal = signal; await hooks.calendar?.(); signal.throwIfAborted();
        return { ...input, timeZone: 'Asia/Seoul', courses: courseIds.map(id => ({ id, title: '합성 강좌 ' + id })), items: [], complete: true, privateRaw: 'must-not-persist' }; },
    } as unknown as LearningxClient, serialize: async () => ({}) }; }, undefined, durable, undefined, null);
  return { reader: create(), create, replace, states, writes, entries, setCourses: (ids: string[]) => { courseIds = ids; }, signal: () => seenSignal,
    counts: () => ({ calendarReads, catalogReads }) };
}
test('calendar bounded memory and encrypted hits reuse catalog proof without school bootstrap', async () => {
  const f = fixture();
  await f.reader.readCalendar!('a', query, options()); await f.reader.readCalendar!('a', query, options());
  assert.deepEqual(f.counts(), { calendarReads: 1, catalogReads: 1 });
  await f.create().readCalendar!('a', query, options());
  assert.deepEqual(f.counts(), { calendarReads: 1, catalogReads: 1 });
  await f.reader.readCalendar!('b', query, options());
  await f.reader.readCalendar!('a', { ...query, courseId: '10' }, options());
  await f.reader.readCalendar!('a', { start: '2099-11-01', end: '2099-12-01' }, options());
  assert.equal(f.counts().calendarReads, 4);
  f.replace('a'); await f.reader.readCalendar!('a', query, options()); assert.equal(f.counts().calendarReads, 5);
  assert.doesNotMatch(JSON.stringify([...f.entries.values()]), /privateRaw|must-not-persist/);
  assert.equal(schoolCacheTtl('calendar:2099-10-01:2099-11-01:all'), 30_000);
});
test('explicit refresh checks changed enrollment and an unowned filter fails before native calendar', async () => {
  const f = fixture();
  await f.reader.readCalendar!('a', query, options());
  f.setCourses(['20']); const changed = await f.reader.readCalendar!('a', query, { ...options(), refresh: true });
  assert.equal(changed.courses[0]!.id, '20'); assert.equal(f.counts().calendarReads, 2);
  await assert.rejects(f.reader.readCalendar!('a', { ...query, courseId: '10' }, options()), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(f.counts().calendarReads, 2);
});
test('concurrent equivalent calendar requests reuse the first result and refresh bypasses both caches', async () => {
  const wait = gate(), f = fixture({ calendar: () => wait.promise });
  const first = f.reader.readCalendar!('a', query, options()), second = f.reader.readCalendar!('a', query, options());
  await flush(); wait.release(); await Promise.all([first, second]);
  assert.deepEqual(f.counts(), { calendarReads: 1, catalogReads: 1 });
  await f.reader.readCalendar!('a', query, { ...options(), refresh: true });
  assert.deepEqual(f.counts(), { calendarReads: 2, catalogReads: 2 });
});
test('calendar cache hits do not extend the original event freshness deadline', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(); await f.reader.readCalendar!('a', query, options());
  now += 20_000; await f.reader.readCalendar!('a', query, options()); assert.equal(f.counts().calendarReads, 1);
  now += 11_000; await f.reader.readCalendar!('a', query, options()); assert.equal(f.counts().calendarReads, 2);
});
test('school authentication and incomplete upstream failures are errors and never persisted as empty calendars', async () => {
  for (const code of ['authentication_required','unsupported','unexpected_response'] as const) {
    const f = fixture({ calendar: async () => { throw new SchoolError(code); } });
    await assert.rejects(f.reader.readCalendar!('a', query, options()), error => error instanceof AppError && error.statusCode === (code === 'authentication_required' ? 401 : code === 'unsupported' ? 503 : 502));
    assert.equal(f.entries.size, 0);
  }
});
test('logout and a newer school generation during calendar reads withhold all data and never overwrite new session', async () => {
  for (const mode of ['login','logout','alms'] as const) {
    const wait = gate(); let active = true;
    const f = fixture({ calendar: () => wait.promise });
    const reading = f.reader.readCalendar!('a', query, { ...options(), validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', '합성'); } });
    await flush(); if (mode === 'login') f.replace('a'); if (mode === 'logout') f.states.delete('a'); if (mode === 'alms') active = false;
    const updated = f.states.get('a'); wait.release();
    await assert.rejects(reading, error => error instanceof AppError && [401,409].includes(error.statusCode));
    if (mode !== 'alms') assert.equal(f.states.get('a'), updated);
  }
});
test('calendar caller cancellation returns while waiting for the owner lock and starts no school request afterward', async () => {
  const f = fixture(), wait = gate(), controller = new AbortController();
  const holding = withSchoolSessionLock('a', () => wait.promise);
  const loading = f.reader.readCalendar!('a', query, { ...options(), signal: controller.signal });
  await flush(); const rejected = assert.rejects(loading, error => error instanceof AppError && error.code === 'CALENDAR_UNAVAILABLE');
  controller.abort(); await rejected; wait.release(); await holding; await flush();
  assert.deepEqual(f.counts(), { calendarReads: 0, catalogReads: 0 });
});
test('calendar cancellation after generation or session CAS prevents result publication and later work', async () => {
  for (const phase of ['generation','cas']) {
    const controller = new AbortController(); let reads = 0;
    const f = fixture(phase === 'generation' ? { afterGet: async () => { if (++reads === 1) controller.abort(); } } : { afterCas: async () => controller.abort() });
    await assert.rejects(f.reader.readCalendar!('a', query, { ...options(), signal: controller.signal }));
    await flush(); assert.equal(f.writes.length, 0);
    if (phase === 'generation') assert.equal(f.counts().calendarReads, 0);
  }
});
test('calendar overall 90-second deadline propagates through school reads', async t => {
  const timeout = AbortSignal.timeout, wait = gate();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const f = fixture({ calendar: () => wait.promise }), alive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(f.reader.readCalendar!('a', query, options()), error => error instanceof AppError && error.code === 'CALENDAR_UNAVAILABLE');
    assert.equal(f.signal()?.aborted, true); wait.release(); await flush(); assert.equal(f.writes.length, 0);
  } finally { clearTimeout(alive); wait.release(); }
});
