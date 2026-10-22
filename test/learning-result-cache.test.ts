import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';

const fresh = () => ({ courseId: '10', moduleItemId: '90', itemId: '900', observedAt: new Date().toISOString(),
  resourceType: 'movie', published: true, opened: true, useAttendance: true, omitProgress: false, completed: null,
  schoolAttendanceStatus: null, progressSeconds: null, lastPositionSeconds: null, durationSeconds: null,
  progressPercent: null, attendance: 'unknown', recognized: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture() {
  const key = randomBytes(32), states = new Map<string, string>(), values = new Map<string, { value: unknown; expiresAt: number }>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b'); let current = false, schoolReads = 0;
  const resourceKey = (scope: SchoolCacheScope) => JSON.stringify([scope.owner, scope.generation, scope.resource]);
  const deleted: Array<{ owner: string; resources: string[] }> = [];
  const durable: SchoolReadCache = {
    async get<T>(scope: SchoolCacheScope) {
      if (states.get(scope.owner) !== scope.encryptedSession) return null;
      const value = values.get(resourceKey(scope)); return value ? { ...value, value: structuredClone(value.value) as T } : null;
    },
    async put(scope, value, ttl) {
      if (states.get(scope.owner) !== scope.encryptedSession) return false;
      values.set(resourceKey(scope), { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true;
    },
    async delete(owner, _provider, resource) {
      for (const key of values.keys()) { const [id, , name] = JSON.parse(key); if (id === owner && (!resource || name === resource)) values.delete(key); }
    },
    async deleteMany(owner, provider, resources, signal) {
      signal?.throwIfAborted(); deleted.push({ owner, resources: [...resources] });
      for (const resource of resources) { signal?.throwIfAborted(); await durable.delete(owner, provider, resource); }
    },
  };
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => {
      if (states.get(owner) !== previous) return false; states.set(owner, next); return true;
    } }, key, async () => ({ client: {
      terms: async () => [{ id: '1', name: '합성 학기', isDefault: true }],
      courses: async () => [10, 11].map(id => ({ id: String(id), name: '합성 강좌', termId: '1' })),
      modules: async () => [],
      moduleActivityDetail: async (courseId: string, moduleItemId: string) => ({ courseId, moduleItemId, completed: current }),
      moduleLearningStatus: async () => { schoolReads++; return fresh(); },
    } as any, serialize: async () => ({}) }), undefined, durable, undefined, null);
  return { reader, provider: createLearningxReads(reader), states, replace, durable, values, deleted,
    change: () => { current = true; }, schoolReads: () => schoolReads };
}
const options = (signal: AbortSignal, validate: () => Promise<void> = async () => {}) => ({ signal, validate });

test('successful explicit verification clears only its progress resources in memory and durable cache, including unknown results', async () => {
  const f = fixture(), signal = new AbortController().signal;
  for (const owner of ['a', 'b']) {
    await f.reader.readCourse(owner, '10'); await f.reader.readCourse(owner, '11');
    await f.reader.readActivity!(owner, '10', '90'); await f.reader.readActivity!(owner, '10', '91');
  }
  const sentinel = JSON.stringify(['a', 'sentinel-generation', 'saint:timetable']);
  f.values.set(sentinel, { value: { preserved: true }, expiresAt: Date.now() + 30_000 });
  const unaffected = new Map([...f.values].filter(([key]) => key === sentinel || JSON.parse(key)[0] === 'b'
    || ['course:11', 'activity:10:91'].includes(JSON.parse(key)[2])));
  const raw = await f.provider.learningStatus!({ userId: 'a' }, { courseId: '10', lectureId: '90' }, signal);
  assert.equal(raw.progressPercent, null); assert.equal(raw.recognized, null); f.change();
  assert.equal((await f.reader.readActivity!('a', '10', '90')).detail.completed, false);
  await f.provider.refreshLearningStatus!({ userId: 'a' }, { courseId: '10', lectureId: '90' }, raw, options(signal));
  assert.deepEqual(f.deleted, [{ owner: 'a', resources: ['course:10', 'activity:10:90', 'calendar-modules:10', 'tasks', 'attendance', 'attendance:10'] }]);
  for (const [key, value] of unaffected) assert.deepEqual(f.values.get(key), value);
  assert.equal((await f.reader.readActivity!('a', '10', '90')).detail.completed, true);
  assert.equal((await f.reader.readActivity!('a', '10', '91')).detail.completed, false);
  assert.equal((await f.reader.readActivity!('b', '10', '90')).detail.completed, false);
  assert.equal(f.schoolReads(), 1);
  assert.doesNotMatch(JSON.stringify(raw), /generation|owner|signal|jar|courseId|moduleItemId/);
});

test('the refresh proof rejects clones, another owner, another target, another request signal and reuse before any deletion', async () => {
  for (const mode of ['clone', 'owner', 'course', 'activity', 'signal', 'reuse']) {
    const f = fixture(), signal = new AbortController().signal;
    const raw = await f.reader.readLearningStatus!('a', '10', '90', signal);
    if (mode === 'reuse') await f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal));
    const before = f.deleted.length;
    await assert.rejects(f.reader.refreshLearningStatus!(mode === 'owner' ? 'b' : 'a', mode === 'course' ? '11' : '10',
      mode === 'activity' ? '91' : '90', mode === 'clone' ? structuredClone(raw) : raw,
      options(mode === 'signal' ? new AbortController().signal : signal)), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
    assert.equal(f.deleted.length, before); assert.equal(f.schoolReads(), 1);
  }
});

test('an expired fresh read cannot invalidate or publish as current', async t => {
  const f = fixture(), signal = new AbortController().signal;
  const raw = await f.reader.readLearningStatus!('a', '10', '90', signal), now = Date.now();
  t.mock.method(Date, 'now', () => now + 90_001);
  await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal)), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
  assert.equal(f.deleted.length, 0);
});

test('new school generation or missing school session before refresh preserves cached resources and rejects old evidence', async () => {
  for (const mode of ['login', 'logout']) {
    const f = fixture(), signal = new AbortController().signal;
    const raw = await f.reader.readLearningStatus!('a', '10', '90', signal);
    if (mode === 'login') f.replace('a'); else f.states.delete('a');
    await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal)),
      { code: mode === 'login' ? 'SCHOOL_SESSION_CHANGED' : 'SCHOOL_AUTH_REQUIRED' });
    assert.equal(f.deleted.length, 0);
  }
});

test('generation or ALMS authorization change during cache deletion withholds success without further school reads', async () => {
  for (const mode of ['generation', 'alms']) {
    const f = fixture(), signal = new AbortController().signal;
    const raw = await f.reader.readLearningStatus!('a', '10', '90', signal); let current = true;
    f.durable.deleteMany = async () => { if (mode === 'generation') f.replace('a'); else current = false; };
    await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal, async () => {
      if (!current) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    })), { code: mode === 'generation' ? 'SCHOOL_SESSION_CHANGED' : 'AUTH_REQUIRED' });
    assert.equal(f.schoolReads(), 1);
  }
});

test('ALMS authorization is checked before deletion and an invalidation error cannot produce fresh success', async () => {
  for (const mode of ['alms', 'cache']) {
    const f = fixture(), signal = new AbortController().signal;
    const raw = await f.reader.readLearningStatus!('a', '10', '90', signal);
    if (mode === 'cache') f.durable.deleteMany = async () => { throw new Error('private-cache-url-token'); };
    let error: unknown;
    try { await f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal, async () => {
      if (mode === 'alms') throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
    })); } catch (value) { error = value; }
    assert.ok(error instanceof AppError); assert.equal(error.code, mode === 'alms' ? 'AUTH_REQUIRED' : 'SCHOOL_RESULT_UNAVAILABLE');
    assert.doesNotMatch(error.message, /private-cache-url-token/); assert.equal(f.deleted.length, 0);
  }
});

test('cancelled refresh waiting for the owner lock performs no cache deletion', async () => {
  const f = fixture(), controller = new AbortController();
  const raw = await f.reader.readLearningStatus!('a', '10', '90', controller.signal);
  const held = gate(), entered = gate(), holding = withSchoolSessionLock('a', async () => { entered.release(); await held.promise; });
  await entered.promise;
  const result = f.reader.refreshLearningStatus!('a', '10', '90', raw, options(controller.signal));
  await flush(); const rejected = assert.rejects(result, { code: 'SCHOOL_RESULT_UNAVAILABLE' }); controller.abort(); await rejected;
  held.release(); await holding; await flush(); assert.equal(f.deleted.length, 0);
});

test('cache refresh deadline aborts a pending delete and a late completion never returns success', async t => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    timer(callback, delay === 15_000 ? 20 : delay, ...args)) as typeof setTimeout);
  const f = fixture(), signal = new AbortController().signal, held = gate(); let received: AbortSignal | undefined;
  const raw = await f.reader.readLearningStatus!('a', '10', '90', signal);
  f.durable.deleteMany = async (_owner, _provider, _resources, value) => { received = value; await held.promise; };
  await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal)), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
  assert.equal(received?.aborted, true); held.release(); await flush(); assert.equal(f.schoolReads(), 1);
  await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal)), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
});

test('a late read-only ALMS validation after the cache deadline starts no deletion or subsequent validation', async t => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    timer(callback, delay === 15_000 ? 20 : delay, ...args)) as typeof setTimeout);
  const f = fixture(), signal = new AbortController().signal, held = gate(); let validations = 0;
  const raw = await f.reader.readLearningStatus!('a', '10', '90', signal);
  await assert.rejects(f.reader.refreshLearningStatus!('a', '10', '90', raw, options(signal, async () => {
    validations++; await held.promise;
  })), { code: 'SCHOOL_RESULT_UNAVAILABLE' });
  held.release(); await flush(); assert.equal(validations, 1); assert.equal(f.deleted.length, 0); assert.equal(f.schoolReads(), 1);
});

test('the legacy cache delete fallback keeps the same exact resource union and respects cancellation before its next delete', async () => {
  for (const abort of [false, true]) {
    const f = fixture(), controller = new AbortController(), deleted: string[] = [];
    const raw = await f.reader.readLearningStatus!('a', '10', '90', controller.signal);
    f.durable.deleteMany = undefined;
    f.durable.delete = async (owner, provider, resource) => {
      assert.equal(owner, 'a'); assert.equal(provider, 'ssu'); assert.ok(resource); deleted.push(resource);
      if (abort) controller.abort();
    };
    const result = f.reader.refreshLearningStatus!('a', '10', '90', raw, options(controller.signal));
    if (abort) { await assert.rejects(result, { code: 'SCHOOL_RESULT_UNAVAILABLE' }); assert.deepEqual(deleted, ['course:10']); }
    else { await result; assert.deepEqual(deleted, ['course:10', 'activity:10:90', 'calendar-modules:10', 'tasks', 'attendance', 'attendance:10']); }
  }
});
