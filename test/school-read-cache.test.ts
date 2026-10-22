import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openSchoolRead, sealSchoolRead, schoolCacheTtl, type SchoolCacheScope, type SchoolReadCache } from '../src/school-read-cache.js';
import { createLearningxReader } from '../src/school-reader.js';
import { publicTasks, createLearningxReads } from '../src/school-read.js';
import { createSaintReader } from '../src/saint-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';

const scope = (): SchoolCacheScope => ({ owner: randomUUID(), provider: 'ssu', generation: randomUUID(), resource: 'course:synthetic', encryptedSession: 'synthetic-sealed-session' });
test('read-cache ciphertext authenticates owner, provider, generation and resource without storing plaintext', () => {
  const key = randomBytes(32), context = scope(), data = { title: 'synthetic-private-title', weeks: [{ id: 'private-module' }] };
  const sealed = sealSchoolRead(data, key, context)!;
  assert.doesNotMatch(sealed.encrypted, /synthetic-private|private-module/);
  assert.deepEqual(openSchoolRead(sealed.encrypted, key, context), data);
  for (const field of ['owner', 'provider', 'generation', 'resource'] as const)
    assert.throws(() => openSchoolRead(sealed.encrypted, key, { ...context, [field]: 'different' }));
  assert.throws(() => openSchoolRead(sealed.encrypted, randomBytes(32), context));
  const parts = sealed.encrypted.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => openSchoolRead(parts.join('.'), key, context));
  assert.equal(sealSchoolRead({ body: 'x'.repeat(1024 * 1024) }, key, context), null);
});
test('cache TTL leaves progress and attendance short-lived while reusing stable metadata', () => {
  assert.equal(schoolCacheTtl('catalog'), 300_000);
  assert.equal(schoolCacheTtl('catalog:all'), 300_000);
  assert.equal(schoolCacheTtl('catalog:term:123'), 300_000);
  assert.equal(schoolCacheTtl('course:123'), 120_000);
  assert.equal(schoolCacheTtl('activity:123:456'), 30_000);
  assert.equal(schoolCacheTtl('attendance'), 30_000);
  assert.equal(schoolCacheTtl('tasks'), 30_000);
  assert.equal(schoolCacheTtl('saint:timetable'), 600_000);
});
function fixture() {
  const key = randomBytes(32), states = new Map<string, string>();
  const state = (owner: string) => encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  states.set('a', state('a')); states.set('b', state('b'));
  const store = {
    getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    getAuthenticatedSchoolSession: async (owner: string, provider: string, tokenHash: string) => {
      assert.equal(provider, 'ssu'); assert.equal(tokenHash, 'synthetic-session');
      return {almsSessionValid: true, encryptedSchoolSession: states.get(owner) ?? null};
    },
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, previous: string, next: string) => {
      if (states.get(owner) !== previous) return false; states.set(owner, next); return true;
    },
  };
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  const cacheKey = (s: SchoolCacheScope) => JSON.stringify([s.owner, s.provider, s.generation, s.resource]);
  const durable: SchoolReadCache = {
    async get<T>(s: SchoolCacheScope) {
      if (states.get(s.owner) !== s.encryptedSession) return null;
      const saved = values.get(cacheKey(s)); return saved && saved.expiresAt > Date.now() ? { ...saved, value: structuredClone(saved.value) as T } : null;
    },
    async put(s, value, ttl) {
      if (states.get(s.owner) !== s.encryptedSession) return false;
      values.set(cacheKey(s), { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true;
    },
    async delete(owner, _provider, resource) {
      for (const k of values.keys()) { const [id, , , name] = JSON.parse(k); if (id === owner && (!resource || resource === name)) values.delete(k); }
    },
  };
  return { key, states, state, store, durable, values };
}
const client = () => ({
  terms: async () => [{ id: 'term', name: '합성 학기', isDefault: true }],
  courses: async () => [{ id: '10', name: '합성 강좌', termId: 'term' }],
  modules: async () => [],
});
test('new reader instances reuse owner-scoped durable data and new logins require school reads', async () => {
  const f = fixture(); let calls = 0;
  const connect = async () => { calls++; return { client: client() as any, serialize: async () => ({}) }; };
  const a = await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readCourse('a', '10');
  const restored = await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readCourse('a', '10');
  assert.deepEqual(restored, a); assert.equal(calls, 1);
  await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readCourse('b', '10'); assert.equal(calls, 2);
  f.states.set('a', f.state('a'));
  await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readCourse('a', '10'); assert.equal(calls, 3);
});
test('expired durable results never replace a failed current school read', async () => {
  const f = fixture();
  await createLearningxReader(f.store, f.key, async () => ({ client: client() as any, serialize: async () => ({}) }), undefined, f.durable).catalog('a');
  for (const value of f.values.values()) value.expiresAt = Date.now() - 1;
  const reader = createLearningxReader(f.store, f.key, async () => { throw new Error('school unavailable'); }, undefined, f.durable);
  await assert.rejects(reader.catalog('a'), error => error instanceof AppError && error.statusCode === 502);
  assert.equal(f.values.size, 0);
});
test('a login while durable lookup awaits cannot publish the previous login data', async () => {
  const f = fixture();
  await createLearningxReader(f.store, f.key, async () => ({ client: client() as any, serialize: async () => ({}) }), undefined, f.durable).catalog('a');
  const get = f.durable.get.bind(f.durable);
  f.durable.get = async <T>(context: SchoolCacheScope) => { const value = await get<T>(context); f.states.set('a', f.state('a')); return value; };
  await assert.rejects(createLearningxReader(f.store, f.key, async () => { throw new Error('must not call'); }, undefined, f.durable).catalog('a'), error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
});
test('cache failures still allow a fresh school result and never turn failures into empty success', async () => {
  const f = fixture(); f.durable.get = async () => { throw new Error('cache offline'); }; f.durable.put = async () => { throw new Error('cache offline'); };
  const fresh = await createLearningxReader(f.store, f.key, async () => ({ client: client() as any, serialize: async () => ({}) }), undefined, f.durable).catalog('a');
  assert.equal(fresh.courses[0]?.id, '10');
  await assert.rejects(createLearningxReader(f.store, f.key, async () => { throw new Error('school offline'); }, undefined, f.durable).catalog('a'), error => error instanceof AppError && error.statusCode === 502);
});
test('Saint timetable survives a reader restart within its generation and refuses expired school state', async () => {
  const f = fixture(); let calls = 0;
  const connect = async () => { calls++; return { timetable: { selectedYear: 2026, selectedSemester: '092' as const, entries: [] }, jar: {} }; };
  const first = await createSaintReader(f.store, f.key, connect, f.durable).timetable('a');
  assert.deepEqual(await createSaintReader(f.store, f.key, connect, f.durable).timetable('a'), first); assert.equal(calls, 1);
  f.states.delete('a');
  await assert.rejects(createSaintReader(f.store, f.key, connect, f.durable).timetable('a'), error => error instanceof AppError && error.statusCode === 401);
});

test('awaited invalidation refreshes progress resources in memory and durable storage without deleting another owner', async () => {
  const f = fixture(); let moduleCalls = 0;
  const connect = async () => ({ client: { ...client(), modules: async () => { moduleCalls++; return []; } } as any, serialize: async () => ({}) });
  const reader = createLearningxReader(f.store, f.key, connect, undefined, f.durable);
  await reader.readCourse('a', '10');
  await reader.readCourse('b', '10');
  assert.equal(moduleCalls, 2);
  await reader.invalidate('a', '10', 'activity');
  await reader.readCourse('a', '10');
  await reader.readCourse('b', '10');
  assert.equal(moduleCalls, 3);
  await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readCourse('b', '10');
  assert.equal(moduleCalls, 3);
});
test('invalidation waits for an in-flight read before dropping its newly published result', async () => {
  const f = fixture(); let started!: () => void, finish!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const reader = createLearningxReader(f.store, f.key, async () => ({ client: { ...client(), modules: async () => {
    if (++calls === 1) { started(); await release; } return [];
  } } as any, serialize: async () => ({}) }), undefined, f.durable);
  const reading = reader.readCourse('a', '10'); await entered;
  const invalidating = reader.invalidate('a', '10', 'activity');
  finish(); await reading; await invalidating;
  await reader.readCourse('a', '10'); assert.equal(calls, 2);
});

test('worker DB deletion alone leaves API memory stale until a terminal-result batch invalidates the exact resources', async () => {
  const f = fixture(), calls = new Map<string, number>(); let completed = false;
  const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const connect = async () => ({ client: { ...client(),
    courses: async () => [10, 11].map(id => ({ id: String(id), name: '합성 강좌', termId: 'term' })),
    modules: async (id: string) => { count('course:' + id); return []; },
    moduleActivityDetail: async (courseId: string, moduleItemId: string) => { count('activity:' + courseId); return { courseId, moduleItemId, completed }; },
    todos: async () => { count('tasks'); return []; },
    lessons: async (id: string) => { count('lessons:' + id); return []; },
    lessonAttendances: async (id: string) => { count('attendance:' + id); return []; },
  } as any, serialize: async () => ({}) });
  const reader = createLearningxReader(f.store, f.key, connect, undefined, f.durable);
  for (const owner of ['a', 'b']) {
    await reader.readCourse(owner, '10'); await reader.readCourse(owner, '11'); await reader.readActivity(owner, '10', '20');
    await reader.readTasks(owner); await reader.readAttendance(owner, '10'); await reader.readAttendance(owner, '11');
  }
  const sentinel = JSON.stringify(['a', 'ssu', 'synthetic-generation', 'saint:timetable']);
  f.values.set(sentinel, { value: { kept: true }, expiresAt: Date.now() + 30_000 });
  await f.durable.delete('a', 'ssu', 'activity:10:20'); completed = true;
  assert.equal((await reader.readActivity('a', '10', '20')).detail.completed, false);
  const before = new Map(calls); let batches = 0; const deleted: string[][] = [];
  f.durable.deleteMany = async (owner, provider, resources, signal) => {
    signal?.throwIfAborted(); batches++; deleted.push([...resources]);
    for (const resource of resources) await f.durable.delete(owner, provider, resource);
  };
  await reader.invalidateActivities('a', Array.from({ length: 200 }, () => ({ courseId: '10', lectureId: '20' })), new AbortController().signal);
  assert.equal(batches, 1); assert.equal(deleted[0]!.length, 6);
  assert.equal((await reader.readActivity('a', '10', '20')).detail.completed, true);
  await reader.readCourse('a', '10'); await reader.readTasks('a'); await reader.readAttendance('a', '10');
  assert.equal(calls.get('course:10'), before.get('course:10')! + 1);
  assert.equal(calls.get('activity:10'), before.get('activity:10')! + 1);
  assert.equal(calls.get('tasks'), before.get('tasks')! + 1); assert.equal(calls.get('attendance:10'), before.get('attendance:10')! + 1);
  assert.equal(calls.get('lessons:10'), before.get('lessons:10')! + 2); // Course week dates and attendance both refresh.
  const after = new Map(calls);
  await reader.readCourse('a', '11'); await reader.readAttendance('a', '11');
  await reader.readCourse('b', '10'); await reader.readActivity('b', '10', '20'); await reader.readTasks('b');
  assert.deepEqual(calls, after); assert.deepEqual(f.values.get(sentinel)?.value, { kept: true });
});

test('batch invalidation waits for older owner reads; abort in that wait never deletes newly cached data', async () => {
  const f = fixture(); let enter!: () => void, release!: () => void, calls = 0, deletes = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.durable.deleteMany = async () => { deletes++; };
  const reader = createLearningxReader(f.store, f.key, async () => ({ client: { ...client(), modules: async () => {
    calls++; enter(); await held; return [];
  } } as any, serialize: async () => ({}) }), undefined, f.durable);
  const reading = reader.readCourse('a', '10'); await entered;
  const controller = new AbortController(), invalidating = reader.invalidateActivities('a', [{ courseId: '10', lectureId: '20' }], controller.signal);
  controller.abort(); release(); await reading; await assert.rejects(invalidating);
  await reader.readCourse('a', '10'); assert.equal(calls, 1); assert.equal(deletes, 0);
  await reader.invalidateActivities('a', [{ courseId: '10', lectureId: '20' }], new AbortController().signal);
  assert.equal(deletes, 1);
});


test('TODO backlinks reuse exact owner-generation durable module proof after reader restart without modules fanout', async () => {
  const f = fixture(); let modules = 0, todos = 0;
  const connect = async () => ({serialize: async () => ({}), client: {...client(),
    modules: async () => {modules++; return [{id: '40', title: '주차', week: 6, items: [{id: '90', assignmentId: '31', title: '다른 제목', contentType: 'assignment', sourceUrl: '', completed: true}]}];},
    todos: async () => {todos++; return [{courseId: '10', activities: {}, items: [{title: 'TODO 제목', componentType: 'assignment', commonsType: null, componentId: '12', assignmentId: '31', quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]}];},
  } as any});
  const first = createLearningxReader(f.store, f.key, connect, undefined, f.durable);
  await first.readCourse('a', '10'); await first.readTasks('a');
  assert.equal(modules, 1); assert.equal(todos, 1);
  const restarted = createLearningxReader(f.store, f.key, connect, undefined, f.durable);
  const value = await restarted.readTasks('a');
  assert.equal(publicTasks(value)[0]!.moduleItemId, '90'); assert.equal(publicTasks(value)[0]!.moduleCompleted, true);
  assert.equal(modules, 1); assert.equal(todos, 1);
  const other = await restarted.readTasks('b');
  assert.equal(publicTasks(other)[0]!.moduleItemId, undefined); assert.equal(modules, 1); assert.equal(todos, 2);
});

test('login replacement during a cached TODO module lookup withholds the old backlinks', async () => {
  const f = fixture();
  const connect = async () => ({serialize: async () => ({}), client: {...client(), todos: async () => [{courseId: '10', activities: {}, items: [{title: '합성 과제', componentType: 'assignment', commonsType: null, componentId: '12', assignmentId: '31', quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null}]}]} as any});
  await createLearningxReader(f.store, f.key, connect, undefined, f.durable).readTasks('a');
  const get = f.durable.get.bind(f.durable);
  f.durable.get = async <T>(context: SchoolCacheScope) => {
    const value = await get<T>(context);
    if (context.resource === 'course:10') f.states.set('a', f.state('a'));
    return value;
  };
  await assert.rejects(createLearningxReader(f.store, f.key, connect, undefined, f.durable).readTasks('a'),
    error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
});

test('cold TODO final proof stays private, binds the exact owner/object, and rejects a replaced school generation', async () => {
  const f = fixture(); let modules = 0, todos = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({serialize: async () => ({}), client: {...client(),
    modules: async () => {modules++; return [];}, todos: async () => {todos++; return [];},
  } as any}));
  const provider = createLearningxReads(reader);
  assert.equal(typeof provider.validateTasks, 'function');
  const value = await provider.tasks!({userId: 'a'});
  assert.deepEqual(Reflect.ownKeys(value as object), ['items', 'courses']);
  assert.doesNotMatch(JSON.stringify(value), /mappingGeneration|moduleProofs|encrypted|generation|owner/);
  await assert.rejects(provider.validateTasks!({userId: 'a', sessionTokenHash: 'synthetic-session'}, structuredClone(value)),
    error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  await assert.rejects(provider.validateTasks!({userId: 'b', sessionTokenHash: 'synthetic-session'}, value),
    error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  f.states.set('a', f.state('a'));
  await assert.rejects(provider.validateTasks!({userId: 'a', sessionTokenHash: 'synthetic-session'}, value),
    error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  const current = await provider.tasks!({userId: 'a'});
  await provider.validateTasks!({userId: 'a', sessionTokenHash: 'synthetic-session'}, current);
  await assert.rejects(provider.validateTasks!({userId: 'a', sessionTokenHash: 'synthetic-session'}, current),
    error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  assert.equal(modules, 0); assert.equal(todos, 2);
});
