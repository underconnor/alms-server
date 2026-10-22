import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseModules } from '@alms/ssu-api';
import { publicTasks, type TasksRead, createLearningxReads } from '../src/school-read.js';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';

const todo = {title: 'TODO 제목', componentType: 'commons', commonsType: 'mp4', componentId: '31', assignmentId: null,
  quizId: null, discussionId: null, sectionId: '1', unitId: '2', dueAt: null, sourceUrl: null};
const modules = parseModules([{module_id: 40, title: '7주차', module_items: [{module_item_id: 90, title: '서로 다른 제목',
  content_type: 'attendance_item', published: true, completion_determinable: true, completed: true,
  content_data: {course_id: 10, item_id: 31, item_content_type: 'commons', item_content_data: {content_type: 'movie'}}}]}], '10');
const data: TasksRead = {catalog: {courses: [{id: '10', title: '강좌', professor: null, term: null, sourceUrl: null}],
  term: null, termIds: ['1'], commonsModes: {'10': true}}, groups: [{courseId: '10', activities: {}, items: [todo]}],
  observedAt: '2099-01-01T00:00:00Z', taskMappingVersion: 2,
  moduleProofs: [{courseId: '10', modules, usePureCanvas: true, commonsMappingVersion: 1}]};

test('Commons joins attendance item ID and normalized type, preserving original task ID and unknown school status', () => {
  const cold = publicTasks({...data, moduleProofs: []})[0]!, linked = publicTasks(data)[0]!;
  assert.equal(linked.id, cold.id); assert.notEqual(linked.id, '31'); assert.equal(linked.moduleItemId, '90');
  assert.equal(linked.weekId, '40'); assert.equal(linked.type, 'video'); assert.equal(linked.moduleCompleted, true);
  assert.equal(linked.personalCompleted, null); assert.equal(linked.schoolStatus, null); assert.equal(linked.playbackAvailable, false);
  assert.doesNotMatch(JSON.stringify(linked), /attendanceItemId|commonsModes|usePureCanvas|commonsMappingVersion/);
  assert.equal('commonsModes' in data.catalog.courses[0]!, false);
});

test('Commons refuses old/missing cache metadata, legacy/unknown modes, ambiguity, different type/course and unpublished activity', () => {
  const variants: TasksRead[] = [
    {...data, taskMappingVersion: 1}, {...data, taskMappingVersion: undefined},
    {...data, catalog: {...data.catalog, commonsModes: undefined}},
    ...[false, null].map(mode => ({...data, catalog: {...data.catalog, commonsModes: {'10': mode}}})),
    ...[false, null, undefined].map(mode => ({...data, moduleProofs: [{...data.moduleProofs![0]!, usePureCanvas: mode}]})),
    {...data, moduleProofs: [{...data.moduleProofs![0]!, commonsMappingVersion: undefined}]},
    {...data, moduleProofs: [{...data.moduleProofs![0]!, courseId: '99'}]},
    {...data, moduleProofs: [...data.moduleProofs!, ...data.moduleProofs!]},
    {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules, ...modules]}]},
    {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules, {...modules[0]!, items: []}]}]},
    {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules, ...modules.map(module => ({...module,
      id: '41', items: module.items.map(item => ({...item, id: '91', resourceType: 'pdf'}))}))]}]},
    ...[{published: false}, {resourceType: 'pdf'}, {activityDetailAvailable: false}, {attendanceItemId: undefined}, {id: 'bad'}]
      .map(change => ({...data, moduleProofs: [{...data.moduleProofs![0]!, modules: modules.map(module => ({...module,
        items: module.items.map(item => ({...item, ...change}))}))}]})),
    {...data, groups: [{...data.groups[0]!, items: [{...todo, componentId: '90'}]}]},
  ];
  for (const value of variants) assert.equal(publicTasks(value)[0]!.moduleItemId, undefined);
});

test('supported Commons PDF/file types match only the exact resource and never manufacture completion', () => {
  for (const type of ['pdf', 'file']) {
    const value: TasksRead = {...data, groups: [{...data.groups[0]!, items: [{...todo, commonsType: type}]}],
      moduleProofs: [{...data.moduleProofs![0]!, modules: modules.map(module => ({...module,
        items: module.items.map(item => ({...item, resourceType: type, completed: null}))}))}]};
    const result = publicTasks(value)[0]!;
    assert.equal(result.type, 'material'); assert.equal(result.moduleItemId, '90'); assert.equal(result.moduleCompleted, null);
  }
});

test('cold Commons TODO performs no module fanout; selected-course proof survives restart and excludes old caches/other owner/generation', async () => {
  const key = randomBytes(32), states = new Map<string, string>();
  const seal = (owner: string) => encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu');
  states.set('a', seal('a')); states.set('b', seal('b'));
  const store = {getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    getAuthenticatedSchoolSession: async (owner: string) => ({almsSessionValid: true, encryptedSchoolSession: states.get(owner) ?? null}),
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, old: string, next: string) => {
      if (states.get(owner) !== old) return false; states.set(owner, next); return true;
    }};
  const entries = new Map<string, {value: unknown; expiresAt: number}>();
  const cacheKey = (scope: SchoolCacheScope) => JSON.stringify([scope.owner, scope.generation, scope.resource]);
  const durable: SchoolReadCache = {
    get: async <T>(scope: SchoolCacheScope) => entries.get(cacheKey(scope)) as {value: T; expiresAt: number} ?? null,
    put: async (scope, value, ttl) => {entries.set(cacheKey(scope), {value: structuredClone(value), expiresAt: Date.now() + ttl}); return true;},
    delete: async (owner, _provider, resource) => {for (const name of entries.keys()) {
      const [id, , key] = JSON.parse(name); if (id === owner && (!resource || key === resource)) entries.delete(name);
    }},
  };
  let moduleGets = 0, todoGets = 0;
  const connect = async () => ({serialize: async () => ({}), client: {
    terms: async () => [{id: '1', name: '학기', default: true}],
    courses: async () => [10, 20].map(id => ({id: String(id), name: '강좌', termId: '1', usePureCanvas: true})),
    todos: async () => {todoGets++; return [{courseId: '10', activities: {}, items: [todo]}];},
    modules: async () => {moduleGets++; return modules;}, lessons: async () => [],
  } as any});
  const first = createLearningxReader(store, key, connect, undefined, durable);
  const cold = await first.readTasks('a'); assert.equal(moduleGets, 0); assert.equal(publicTasks(cold)[0]!.moduleItemId, undefined);
  await first.readCourse('a', '10'); assert.equal(moduleGets, 1);
  const restarted = createLearningxReader(store, key, connect, undefined, durable);
  const warm = await restarted.readTasks('a'); assert.equal(todoGets, 1); assert.equal(moduleGets, 1);
  assert.equal(publicTasks(warm)[0]!.id, publicTasks(cold)[0]!.id); assert.equal(publicTasks(warm)[0]!.moduleItemId, '90');
  const provider = createLearningxReads(restarted), dto = await provider.tasks!({userId: 'a'});
  assert.doesNotMatch(JSON.stringify(dto), /commonsModes|usePureCanvas|attendanceItemId|mappingVersion/i);
  await provider.validateTasks!({userId: 'a', sessionTokenHash: 'synthetic'}, dto);
  assert.equal(publicTasks(await restarted.readTasks('b'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 1);
  // A v37 durable course cannot attach a link, and must be reread on explicit selected-course entry.
  for (const [name, entry] of entries) if (JSON.parse(name)[0] === 'a' && JSON.parse(name)[2] === 'course:10')
    entry.value = {...entry.value as object, commonsMappingVersion: undefined};
  const afterOldCache = createLearningxReader(store, key, connect, undefined, durable);
  assert.equal(publicTasks(await afterOldCache.readTasks('a'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 1);
  await afterOldCache.readCourse('a', '10'); assert.equal(moduleGets, 2);
  states.set('a', seal('a'));
  assert.equal(publicTasks(await afterOldCache.readTasks('a'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 2);
});
