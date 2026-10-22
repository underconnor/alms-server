import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseModules } from '@alms/ssu-api';
import { publicCourseContent, publicTasks, type TasksRead } from '../src/school-read.js';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';

const todo = {title: 'TODO 제목', componentType: 'commons', commonsType: 'readystream', componentId: '31', assignmentId: null,
  quizId: null, discussionId: null, sectionId: '1', unitId: '2', dueAt: null, sourceUrl: null};
const raw = [{module_id: 40, title: '7주차', module_items: [{module_item_id: 90, title: '서로 다른 제목',
  content_type: 'attendance_item', published: true, completion_determinable: true, completed: true,
  content_data: {course_id: 10, item_id: 31, item_content_type: 'commons', item_content_data: {content_type: 'readystream'}}}]}];
const modules = parseModules(raw, '10');
const course = {id: '10', title: '강좌', professor: null, term: null, sourceUrl: null};
const data: TasksRead = {catalog: {courses: [course], term: null, termIds: ['1'], commonsModes: {'10': true}},
  groups: [{courseId: '10', activities: {}, items: [todo]}], observedAt: '2099-01-01T00:00:00Z', taskMappingVersion: 4,
  moduleProofs: [{courseId: '10', modules, usePureCanvas: true, commonsMappingVersion: 3}]};
const changedItem = (change: object): TasksRead => ({...data, moduleProofs: [{...data.moduleProofs![0]!,
  modules: modules.map(module => ({...module, items: module.items.map(item => ({...item, ...change}))}))}]});

test('canonical readystream TODO and course metadata agree on video while server playback remains unavailable', () => {
  const cold = publicTasks({...data, moduleProofs: []})[0]!, linked = publicTasks(data)[0]!;
  assert.equal(linked.id, cold.id); assert.notEqual(linked.id, '31');
  assert.equal(linked.moduleItemId, '90'); assert.equal(linked.weekId, '40'); assert.equal(linked.type, 'video'); assert.equal(cold.type, 'video');
  assert.equal(linked.moduleCompleted, true); assert.equal(linked.personalCompleted, null);
  assert.equal(linked.schoolStatus, null); assert.equal(linked.progressPercent, null); assert.equal(linked.playbackAvailable, false);
  assert.doesNotMatch(JSON.stringify(linked), /todoReferenceAvailable|attendanceItemId|commonsMappingVersion|readystream/);
  const activity = publicCourseContent({course, modules}, true, true).weeks[0]!.activities[0]!;
  assert.equal(activity.type, 'video'); assert.equal(activity.resourceType, 'readystream');
  assert.equal(activity.detailAvailable, true); assert.equal(activity.playbackAvailable, false); assert.equal(activity.progressPercent, null);
});

test('readystream refuses stale proofs, unsupported variants, malformed IDs and ambiguous course/module/item relations', () => {
  const variants: Array<[string, TasksRead]> = [
    ...[undefined, 1, 2, 3].map(version => ['old task proof', {...data, taskMappingVersion: version}] as [string, TasksRead]),
    ...[undefined, 1, 2].map(version => ['old module proof', {...data, moduleProofs: [{...data.moduleProofs![0]!, commonsMappingVersion: version}]}] as [string, TasksRead]),
    ...[undefined, false, null].map(mode => ['course mode', {...data, moduleProofs: [{...data.moduleProofs![0]!, usePureCanvas: mode}]}] as [string, TasksRead]),
    ['catalog mode absent', {...data, catalog: {...data.catalog, commonsModes: undefined}}],
    ['catalog mode false', {...data, catalog: {...data.catalog, commonsModes: {'10': false}}}],
    ['foreign course proof', {...data, moduleProofs: [{...data.moduleProofs![0]!, courseId: '20'}]}],
    ['duplicate course proof', {...data, moduleProofs: [...data.moduleProofs!, ...data.moduleProofs!]}],
    ['duplicate module', {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules, ...modules]}]}],
    ['duplicate module ID without item', {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules, {...modules[0]!, items: []}]}]}],
    ['duplicate item ID under another week', {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules,
      {...modules[0]!, id: '41', items: modules[0]!.items.map(item => ({...item, attendanceItemId: '32'}))}]}]}],
    ['duplicate attendance relation under another item', {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules,
      {...modules[0]!, id: '41', items: modules[0]!.items.map(item => ({...item, id: '91'}))}]}]}],
    ['mixed-resource duplicate attendance relation', {...data, moduleProofs: [{...data.moduleProofs![0]!, modules: [...modules,
      {...modules[0]!, id: '41', items: modules[0]!.items.map(item => ({...item, id: '91', resourceType: 'movie', activityDetailAvailable: true}))}]}]}],
    ...[{todoReferenceAvailable: undefined}, {todoReferenceAvailable: false}, {todoReferenceAvailable: 'true'}, {resourceType: 'movie'},
      {resourceType: 'Readystream'}, {resourceType: 'readystream2'}, {contentType: 'assignment'}, {itemContentType: 'unknown'},
      {attendanceItemId: undefined}, {attendanceItemId: '90'}, {published: false}, {id: '../90'}, {activityDetailAvailable: false}, {activityDetailAvailable: undefined}]
      .map(change => [JSON.stringify(change), changedItem(change)] as [string, TasksRead]),
    ...['0', '031', '../31', '31 ', '900719925474099999'].map(id => ['malformed TODO ID', {...data,
      groups: [{...data.groups[0]!, items: [{...todo, componentId: id}]}]}] as [string, TasksRead]),
    ...['Readystream', 'readystream2', 'future'].map(type => ['unsupported TODO resource', {...data,
      groups: [{...data.groups[0]!, items: [{...todo, commonsType: type}]}]}] as [string, TasksRead]),
    ['unsupported TODO component', {...data, groups: [{...data.groups[0]!, items: [{...todo, componentType: 'future'}]}]}],
    ['unrelated foreign course', {...data, catalog: {...data.catalog, courses: [course, {...course, id: '20'}]},
      groups: [{...data.groups[0]!, courseId: '20'}]}],
  ];
  for (const [name, value] of variants) {
    const linked = publicTasks(value)[0]!;
    assert.equal(linked.moduleItemId, undefined, name); assert.equal(linked.weekId, undefined, name);
    assert.equal(linked.playbackAvailable, false, name); assert.equal(linked.schoolStatus, null, name);
  }
});

test('SDK foreign-course metadata cannot become a readystream backlink despite matching titles and attendance IDs', () => {
  const foreign = structuredClone(raw); foreign[0]!.module_items[0]!.content_data.course_id = 20;
  assert.throws(() => parseModules(foreign, '10'), {code: 'unexpected_response'});
});

test('readystream selected-course proof survives restart but old caches, other owners and new generations cannot supply it', async () => {
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
    todos: async () => {todoGets++; return data.groups;},
    modules: async () => {moduleGets++; return modules;}, lessons: async () => [],
  } as any});
  const create = () => createLearningxReader(store, key, connect, undefined, durable);
  const first = create();
  assert.equal(publicTasks(await first.readTasks('a'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 0);
  await first.readCourse('a', '10'); assert.equal(moduleGets, 1);
  assert.equal(publicTasks(await create().readTasks('a'))[0]!.moduleItemId, '90'); assert.equal(moduleGets, 1); assert.equal(todoGets, 1);
  assert.equal(publicTasks(await create().readTasks('b'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 1);
  for (const [name, entry] of entries) if (JSON.parse(name)[0] === 'a') {
    if (JSON.parse(name)[2] === 'course:10') entry.value = {...entry.value as object, commonsMappingVersion: 1};
    if (JSON.parse(name)[2] === 'tasks') entry.value = {...entry.value as object, taskMappingVersion: 2};
  }
  const afterOldCache = create();
  assert.equal(publicTasks(await afterOldCache.readTasks('a'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 1); assert.equal(todoGets, 3);
  await afterOldCache.readCourse('a', '10'); assert.equal(moduleGets, 2);
  assert.equal(publicTasks(await afterOldCache.readTasks('a'))[0]!.moduleItemId, '90');
  states.set('a', seal('a'));
  assert.equal(publicTasks(await afterOldCache.readTasks('a'))[0]!.moduleItemId, undefined); assert.equal(moduleGets, 2);
});
