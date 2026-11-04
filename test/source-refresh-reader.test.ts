import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import type { SchoolReadCache, SchoolCacheScope, SchoolCacheEntry } from '../src/school-read-cache.js';
import { assignmentListFixture } from './helpers/assignment-fixture.js';

type State = { ids: string[]; fail: boolean; loadAssignments?: () => Promise<void>;
  calls: { modules: number; assignments: number; todos: number; terms: number; courses: number } };
const options = () => ({ signal: new AbortController().signal, validate: async () => {}, personalCompletionCourses: async (ids: readonly string[]) => ids });
const resourceOptions = () => ({ ...options(), refresh: true, refreshScope: 'resource' as const });
function fixture() {
  const key = randomBytes(32), sessions = new Map<string, string>(), generations = new Map<string, string>();
  for (const owner of ['a', 'b']) {
    const generation = randomUUID(); generations.set(owner, generation);
    sessions.set(owner, encryptSchoolSession({ version: 1, generation, identity: { studentId: owner === 'a' ? '90000001' : '90000002' }, jar: {} }, key, owner, 'ssu'));
  }
  const state: State = { ids: ['90'], fail: false, calls: { modules: 0, assignments: 0, todos: 0, terms: 0, courses: 0 } };
  const records = new Map<string, SchoolCacheEntry>();
  const personal = new Map([['a:10:70', false]]), retainedFile = Buffer.from('synthetic-retained-file');
  const replaceLogin = (owner: string) => {
    const generation = randomUUID(); generations.set(owner, generation);
    sessions.set(owner, encryptSchoolSession({ version: 1, generation, identity: { studentId: owner === 'a' ? '90000001' : '90000002' }, jar: {} }, key, owner, 'ssu'));
  };
  const recordKey = (scope: Pick<SchoolCacheScope, 'owner' | 'provider' | 'generation' | 'resource'>) => JSON.stringify([scope.owner, scope.provider, scope.generation, scope.resource]);
  const scoped = (owner: string, resource: string) => ({ owner, provider: 'ssu', generation: generations.get(owner)!, resource, encryptedSession: sessions.get(owner)! });
  const seed = (owner: string, resource: string, value: unknown, extra: Partial<SchoolCacheScope> = {}) => records.set(recordKey({ ...scoped(owner, resource), ...extra }), { value: structuredClone(value), expiresAt: Date.now() + 120_000 });
  const saved = (owner: string, resource: string, extra: Partial<SchoolCacheScope> = {}) => records.get(recordKey({ ...scoped(owner, resource), ...extra }));
  const durable: SchoolReadCache = {
    async get<T>(scope: SchoolCacheScope) {
      const found = records.get(recordKey(scope));
      return found && scope.encryptedSession === sessions.get(scope.owner) && found.expiresAt > Date.now()
        ? { ...found, value: structuredClone(found.value) as T } : null;
    },
    async put(scope, value, ttl) {
      if (scope.encryptedSession !== sessions.get(scope.owner)) return false;
      records.set(recordKey(scope), { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true;
    },
    async delete(owner, provider, resource, generation, expectedEncryptedSession) {
      if (expectedEncryptedSession && expectedEncryptedSession !== sessions.get(owner)) return;
      for (const id of records.keys()) { const [storedOwner, storedProvider, storedGeneration, name] = JSON.parse(id);
        if (owner === storedOwner && provider === storedProvider && (!generation || generation === storedGeneration) && (!resource || name === resource)) records.delete(id);
      }
    },
    async deleteRelated(owner, provider, generation, courses, exclude, signal) {
      signal?.throwIfAborted();
      assert.ok(courses.length <= 100 && courses.every(id => /^[1-9]\d{0,15}$/.test(id)));
      for (const id of records.keys()) {
        const [storedOwner, storedProvider, storedGeneration, name] = JSON.parse(id) as string[];
        if (owner !== storedOwner || provider !== storedProvider || generation !== storedGeneration || name === exclude) continue;
        const calendarCourse = name!.split(':')[4];
        if (name === 'tasks' || name!.startsWith('calendar:v3:') && (calendarCourse === 'all' || courses.includes(calendarCourse!)) || courses.some(course =>
          [`course:${course}`, `calendar-modules:${course}`, `assignments:${course}`].includes(name!) || name!.startsWith(`assignment:${course}:`))) records.delete(id);
      }
    },
  };
  const store = {
    getEncryptedSchoolSession: async (owner: string) => sessions.get(owner) ?? null,
    getAuthenticatedSchoolSession: async (owner: string) => ({ almsSessionValid: true, encryptedSchoolSession: sessions.get(owner) ?? null }),
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, before: string, after: string) => {
      if (before !== sessions.get(owner)) return false; sessions.set(owner, after); return true;
    },
  };
  const create = () => createLearningxReader(store, key, async () => ({ serialize: async () => ({}), client: {
    terms: async () => { state.calls.terms++; return [{ id: '1', name: '2099 synthetic term', default: true }]; },
    courses: async () => { state.calls.courses++; return ['10', '11'].map(id => ({ id, name: `Synthetic course ${id}`, termId: '1', usePureCanvas: true })); },
    modules: async (course: string) => { state.calls.modules++; return [{ id: '40', title: 'Synthetic week', week: 1,
      items: (course === '10' ? state.ids : ['90']).map((id, index) => ({ id: String(70 + index), title: `Synthetic ${id}`, assignmentId: id, contentType: 'assignment', published: true })) }]; },
    assignments: async (course: string) => { state.calls.assignments++; await state.loadAssignments?.(); if (state.fail) throw new Error('synthetic upstream failure');
      const value = assignmentListFixture(); return { ...value, courseId: course, items: (course === '10' ? state.ids : ['90']).map(id => ({ ...value.items[0], id, courseId: course, title: `Synthetic ${id}`, sourceUrl: `https://canvas.ssu.ac.kr/courses/${course}/assignments/${id}` })) }; },
    todos: async () => { state.calls.todos++; return [{ courseId: '10', activities: {}, items: state.ids.map(id => ({ componentType: 'assignment', assignmentId: id, title: `Synthetic ${id}` })) }]; },
  } as any }), undefined, durable, undefined, null);
  return { reader: create(), create, state, records, scoped, seed, saved, personal, retainedFile, replaceLogin };
}

test('fresh assignment discovery replaces linked course and TODO metadata within the same TTL', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  assert.equal((await f.reader.readCourse('a', '10')).modules[0]!.items.length, 1);
  assert.equal((await f.reader.readAssignments!('a', '10', options())).items.length, 1);
  assert.equal((await f.reader.readTasks('a', options())).groups[0]!.items.length, 1);
  f.state.ids.push('91');
  assert.equal((await f.reader.readAssignments!('a', '10', resourceOptions())).items.length, 2);
  const course = await f.reader.readCourse('a', '10');
  const tasks = await f.reader.readTasks('a', options());
  assert.equal(course.modules[0]!.items.length, 2); assert.equal(tasks.groups[0]!.items.length, 2);
  assert.deepEqual(tasks.moduleProofs?.[0]?.modules[0]?.items.map(item => [item.id, item.assignmentId]), [['70', '90'], ['71', '91']]);
  assert.equal((await f.create().readAssignments!('a', '10', options())).items.length, 2, 'a separate reader cannot restore the old durable assignment snapshot');
});
test('fresh course metadata expires related assignments and TODOs while retaining the fresh target', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  await f.reader.readCourse('a', '10'); await f.reader.readAssignments!('a', '10', options()); await f.reader.readTasks('a', options());
  f.state.ids.push('91');
  const course = await f.reader.readCourse('a', '10', resourceOptions());
  assert.equal(course.modules[0]!.items.length, 2); assert.ok(f.saved('a', 'course:10'));
  assert.equal(f.saved('a', 'assignments:10'), undefined); assert.equal(f.saved('a', 'tasks'), undefined);
  assert.equal((await f.reader.readAssignments!('a', '10', options())).items.length, 2);
  assert.equal((await f.reader.readTasks('a', options())).groups[0]!.items.length, 2);
});
test('source failure never clears independently usable courses, other owners or retained byte records', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  await f.reader.catalog('a'); await f.reader.readCourse('a', '10'); await f.reader.readCourse('a', '11');
  await f.reader.readAssignments!('a', '10', options()); await f.reader.readAssignments!('a', '11', options());
  await f.reader.readCourse('b', '10');
  f.seed('a', 'assignment-file:10:90:7', { bytes: [...f.retainedFile] });
  const untouched = ['course:10', 'course:11', 'assignments:11', 'catalog', 'assignment-file:10:90:7'].map(name => [name, structuredClone(f.saved('a', name))] as const);
  const other = structuredClone(f.saved('b', 'course:10')), overrides = [...f.personal];
  f.state.fail = true;
  await assert.rejects(f.reader.readAssignments!('a', '10', resourceOptions()), { statusCode: 502 });
  for (const [name, value] of untouched) assert.deepEqual(f.saved('a', name), value, name);
  assert.deepEqual(f.saved('b', 'course:10'), other); assert.deepEqual([...f.personal], overrides);
  const modules = f.state.calls.modules; await f.reader.readCourse('a', '11'); assert.equal(f.state.calls.modules, modules);
});
test('successful scoped refresh preserves other courses, owners, providers, generations and retained files', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture();
  await f.reader.readCourse('a', '10'); await f.reader.readCourse('a', '11'); await f.reader.readCourse('b', '10');
  f.seed('a', 'calendar:v3:2026-11-01:2026-11-30:11', { retained: 'unrelated course calendar' });
  f.seed('a', 'calendar:v3:2026-11-01:2026-11-30:10', { stale: 'related course calendar' });
  f.seed('a', 'calendar:v3:2026-11-01:2026-11-30:all', { stale: 'aggregate calendar' });
  for (const resource of ['activity:10:70', 'assignment-file:10:90:7', 'video:10:70', 'syllabus:10']) f.seed('a', resource, { retained: resource });
  f.seed('a', 'course:10', { old: 'generation' }, { generation: 'old-generation' });
  f.seed('a', 'course:10', { other: 'provider' }, { provider: 'other-provider' });
  const preserve = [...f.records.entries()].filter(([id]) => { const [owner, provider, generation, resource] = JSON.parse(id);
    return owner === 'b' || provider === 'other-provider' || generation === 'old-generation' || resource === 'course:11'
      || resource === 'calendar:v3:2026-11-01:2026-11-30:11'
      || ['activity:10:70', 'assignment-file:10:90:7', 'video:10:70', 'syllabus:10'].includes(resource);
  }).map(([id, value]) => [id, structuredClone(value)] as const);
  const overrides = [...f.personal], bytes = Buffer.from(f.retainedFile);
  f.state.ids.push('91'); await f.reader.readAssignments!('a', '10', resourceOptions());
  assert.equal(f.saved('a', 'calendar:v3:2026-11-01:2026-11-30:10'), undefined);
  assert.equal(f.saved('a', 'calendar:v3:2026-11-01:2026-11-30:all'), undefined);
  for (const [id, value] of preserve) assert.deepEqual(f.records.get(id), value, id);
  assert.deepEqual([...f.personal], overrides); assert.deepEqual(f.retainedFile, bytes);
});
test('a late source failure from the previous login cannot erase a newer generation snapshot', async t => {
  t.mock.method(Date, 'now', () => 1_900_000_000_000);
  const f = fixture(); await f.reader.readCourse('a', '10');
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  f.state.loadAssignments = async () => { started(); await held; };
  const reading = f.reader.readAssignments!('a', '10', resourceOptions());
  const rejected = assert.rejects(reading, { statusCode: 409 });
  try {
    await entered; f.replaceLogin('a');
    // A separate current-generation reader/replica can publish while the old request is still ending.
    f.seed('a', 'course:10', { currentGeneration: true });
    const current = structuredClone(f.saved('a', 'course:10'));
    release(); await rejected;
    assert.deepEqual(f.saved('a', 'course:10'), current);
  } finally { release(); await rejected; }
});
