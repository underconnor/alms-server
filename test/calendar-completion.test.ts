import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads, publicCalendarLearning, publicTasks, type CalendarRead } from '../src/school-read.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { encryptSchoolSession } from '../src/crypto.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';
import type { PersonalCompletion } from '../src/domain.js';

const query = {start: '2099-10-01', end: '2099-11-01'};
const headers = {cookie: '__Host-alms_session=' + 'a'.repeat(43)};
const url = '/v1/calendar?start=2099-10-01&end=2099-11-01';
const gate = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};};
const entry = (courseId = '10', assignmentId = '31', submitted: boolean | null = true) => ({id: `assignment_${assignmentId}`, type: 'assignment' as const,
  courseId, title: '합성 과제', startsAt: '2099-10-10T00:00:00Z', endsAt: '2099-10-10T00:00:00Z', allDay: false,
  allDayDate: null, dueAt: '2099-10-10T00:00:00Z', assignmentId, sourceUrl: null, userSubmitted: submitted});
const moduleRow = () => ({id: '40', title: '합성 주차', week: 1, items: [{id: '90', assignmentId: '31', title: '다른 제목',
  contentType: 'assignment', completed: true, published: true}]});
const calendar = (): CalendarRead => ({...query, timeZone: 'Asia/Seoul', courses: [{id: '10', title: '합성 강좌 10'}],
  items: [entry()], complete: true, moduleProofs: [{courseId: '10', modules: [moduleRow()] as any}]});

test('calendar uses exact unique assignment relations and never changes actual school submission', () => {
  const source = calendar(), result = publicCalendarLearning(source, query);
  assert.deepEqual(result.items[0], {...entry(), moduleItemId: '90', weekId: '40', moduleCompleted: true, personalCompleted: null});
  assert.equal(source.items[0]!.moduleItemId, undefined);
  assert.equal((result as any).moduleProofs, undefined); assert.equal((result as any).mappingGeneration, undefined);
  source.items[0]!.userSubmitted = false;
  assert.equal(publicCalendarLearning(source, query).items[0]!.userSubmitted, false);
  source.moduleProofs![0]!.modules[0]!.items[0]!.completed = null;
  assert.equal(publicCalendarLearning(source, query).items[0]!.moduleCompleted, null);
});

test('missing, unpublished, duplicate relation/module/week IDs and title-only matches cannot attach personal completion', () => {
  for (const mode of ['missing', 'unpublished', 'relation', 'unsupported-relation', 'module', 'week', 'proof', 'title', 'nonnumeric'] as const) {
    const value = calendar(), proof = value.moduleProofs![0]!, row = proof.modules[0]!, item = row.items[0]!;
    if (mode === 'missing') value.moduleProofs = [];
    if (mode === 'unpublished') item.published = false;
    if (mode === 'relation') row.items.push({...item, id: '91'});
    if (mode === 'unsupported-relation') row.items.push({...item, id: '91', contentType: 'quiz'});
    if (mode === 'module') row.items.push({...item, assignmentId: '99', contentType: 'quiz'} as any);
    if (mode === 'week') proof.modules.push({...row, items: []});
    if (mode === 'proof') value.moduleProofs!.push({...proof});
    if (mode === 'title') item.assignmentId = '32';
    if (mode === 'nonnumeric') item.id = 'not-an-activity';
    const observed = publicCalendarLearning(value, query).items[0]!;
    assert.equal(observed.moduleItemId, undefined, mode); assert.equal(observed.userSubmitted, true, mode);
  }
});

async function fixture() {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({version: 1, generation: randomUUID(), identity: {studentId: '90000001'}, jar: {}}, key, owner, 'ssu'));
  replace('owner-a'); replace('owner-b');
  let owner = 'owner-a', active = true, completionReads = 0, snapshots = 0;
  let afterRows: (() => Promise<void>) | undefined;
  let modules = [moduleRow()] as any;
  let todos: any[] = [];
  const rows = new Map<string, PersonalCompletion[]>([['owner-a', [{courseId: '10', activityId: '90', completed: false, updatedAt: '2099-10-01T00:00:00Z'}]], ['owner-b', []]]);
  const schoolCalls = {calendar: 0, modules: [] as string[], todos: 0, lessons: 0};
  const session = () => ({user: {id: owner}, tokenHash: 'synthetic-session'});
  const store = {getSession: async () => active ? session() : null,
    getEncryptedSchoolSession: async (id: string) => states.get(id) ?? null,
    replaceEncryptedSchoolSession: async (id: string, _provider: string, previous: string, next: string) => {
      if (states.get(id) !== previous) return false; states.set(id, next); return true;
    },
    getAuthenticatedSchoolSession: async (id: string, provider: string, tokenHash: string) => {
      assert.equal(provider, 'ssu'); assert.equal(tokenHash, 'synthetic-session'); snapshots++;
      return {almsSessionValid: active && id === owner, encryptedSchoolSession: states.get(id) ?? null};
    },
    listCompletionsForCourses: async (id: string, courses: readonly string[]) => {
      completionReads++; const value = (rows.get(id) ?? []).filter(row => courses.includes(row.courseId));
      await afterRows?.(); return value;
    }} as unknown as Store;
  const cache = new Map<string, {value: unknown; expiresAt: number}>();
  const cacheKey = (scope: SchoolCacheScope) => `${scope.owner}/${scope.generation}/${scope.resource}`;
  const durable: SchoolReadCache = {get: async <T>(scope: SchoolCacheScope) => cache.get(cacheKey(scope)) as {value: T; expiresAt: number} ?? null,
    put: async (scope, value, ttl) => {cache.set(cacheKey(scope), {value, expiresAt: Date.now() + ttl}); return true;},
    delete: async (id, _provider, resource) => {for (const name of cache.keys()) if (name.startsWith(id + '/') && (!resource || name.endsWith('/' + resource))) cache.delete(name);}};
  const create = () => createLearningxReader(store as any, key, async () => ({serialize: async () => ({}), client: {
    terms: async () => [{id: '1', name: '합성 학기', isDefault: true}],
    courses: async () => ['10', '20'].map(id => ({id, name: '합성 강좌 ' + id, termId: '1', usePureCanvas: true})),
    calendar: async () => {schoolCalls.calendar++; return {...query, timeZone: 'Asia/Seoul', courses: ['10', '20'].map(id => ({id, title: '합성 강좌 ' + id})),
      items: [entry(), entry('20', '32', null)], complete: true};},
    modules: async (id: string) => {schoolCalls.modules.push(id); return modules;},
    lessons: async () => {schoolCalls.lessons++; throw new Error('Calendar mapping must not request lessons');},
    todos: async () => {schoolCalls.todos++; return todos;},
  } as any}), undefined, durable, undefined, null);
  const reader = create(), provider = {...unavailableSchoolProvider, ...createLearningxReads(reader)};
  const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'}), store, provider);
  return {app, create, reader, provider, store, rows, states, replace, schoolCalls, cache,
    setOwner: (value: string) => {owner = value;}, revoke: () => {active = false;},
    setModules: (value: any) => {modules = value;}, setTodos: (value: any[]) => {todos = value;}, afterRows: (value?: () => Promise<void>) => {afterRows = value;},
    counts: () => ({completionReads, snapshots})};
}

test('cold calendar maps only courses with own stored overrides, even when no pending school TODO exists', async () => {
  const f = await fixture();
  try {
    const first = await f.app.inject({url, headers}); assert.equal(first.statusCode, 200);
    const items = first.json().items;
    assert.equal(items[0].personalCompleted, false); assert.equal(items[0].moduleCompleted, true); assert.equal(items[0].userSubmitted, true);
    assert.equal(items[0].moduleItemId, '90'); assert.equal(items[0].weekId, '40');
    assert.equal(items[1].moduleItemId, undefined); assert.equal(items[1].personalCompleted, undefined); assert.equal(items[1].userSubmitted, null);
    assert.deepEqual(f.schoolCalls, {calendar: 1, modules: ['10'], todos: 0, lessons: 0});
    assert.deepEqual(f.counts(), {completionReads: 2, snapshots: 1});
    assert.doesNotMatch(JSON.stringify([...f.cache.values()]), /personalCompleted|"completed":false/);
    const row = f.rows.get('owner-a')![0]!; row.completed = true;
    const changed = await f.app.inject({url, headers}); assert.equal(changed.statusCode, 200); assert.equal(changed.json().items[0].personalCompleted, true);
    f.rows.set('owner-a', []);
    const reset = await f.app.inject({url, headers}); assert.equal(reset.json().items[0].personalCompleted, null);
    assert.equal(reset.json().items[0].userSubmitted, true); assert.deepEqual(f.schoolCalls.modules, ['10']);
  } finally {await f.app.close();}
});

test('a fresh reader and newer school generation retain exact owner overrides without using old proof or another account', async () => {
  const f = await fixture();
  const config = loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'});
  try {
    assert.equal((await f.app.inject({url, headers})).json().items[0].personalCompleted, false);
    f.replace('owner-a');
    const restarted = await buildApp(config, f.store, {...unavailableSchoolProvider, ...createLearningxReads(f.create())});
    try {const value = await restarted.inject({url, headers}); assert.equal(value.statusCode, 200); assert.equal(value.json().items[0].personalCompleted, false);}
    finally {await restarted.close();}
    assert.deepEqual(f.schoolCalls.modules, ['10', '10']);
    f.setOwner('owner-b');
    const other = await f.app.inject({url, headers}); assert.equal(other.statusCode, 200);
    assert.equal(other.json().items[0].moduleItemId, undefined); assert.equal(other.json().items[0].personalCompleted, undefined);
    assert.equal(other.json().items[0].userSubmitted, true); assert.deepEqual(f.schoolCalls.modules, ['10', '10']);
  } finally {await f.app.close();}
});

test('verified progress invalidation clears the exact calendar module proof while keeping its school calendar and other courses', async () => {
  const f = await fixture();
  try {
    const first = await f.app.inject({url, headers}); assert.equal(first.json().items[0].moduleCompleted, true);
    const row = moduleRow(); row.items[0]!.completed = false; f.setModules([row]);
    await f.reader.invalidateActivities('owner-a', [{courseId: '10', lectureId: '90'}], new AbortController().signal);
    const next = await f.app.inject({url, headers}); assert.equal(next.statusCode, 200);
    assert.equal(next.json().items[0].moduleCompleted, false); assert.equal(next.json().items[0].personalCompleted, false);
    assert.equal(next.json().items[0].userSubmitted, true); assert.deepEqual(f.schoolCalls.modules, ['10', '10']); assert.equal(f.schoolCalls.calendar, 1);
  } finally {await f.app.close();}
});

test('ambiguous cold assignment mapping with an override does not invent a submitted or personal-complete result', async () => {
  const f = await fixture(), row = moduleRow(); row.items.push({...row.items[0]!, id: '91'});
  f.setModules([row]);
  try {const value = await f.app.inject({url, headers}); assert.equal(value.statusCode, 200);
    assert.equal(value.json().items[0].moduleItemId, undefined); assert.equal(value.json().items[0].personalCompleted, undefined);
    assert.equal(value.json().items[0].userSubmitted, true);
  } finally {await f.app.close();}
});

test('late logout or same-owner school replacement during fresh completion lookup withholds the entire calendar', async () => {
  for (const mode of ['logout', 'school'] as const) {
    const f = await fixture(), entered = gate(), held = gate(); let batches = 0;
    f.afterRows(async () => {if (++batches === 2) {entered.release(); await held.promise;}});
    try {
      const pending = f.app.inject({url, headers}); await entered.promise;
      if (mode === 'logout') f.revoke(); else f.replace('owner-a'); held.release();
      const value = await pending; assert.equal(value.statusCode, mode === 'logout' ? 401 : 409);
      assert.equal(value.json().error.code, mode === 'logout' ? 'AUTH_REQUIRED' : 'SCHOOL_SESSION_CHANGED');
      assert.equal(value.json().items, undefined); assert.equal(f.counts().snapshots, 1);
    } finally {held.release(); await f.app.close();}
  }
});

test('calendar private proof rejects copied, cross-owner and consumed public DTOs', async () => {
  for (const mode of ['copy', 'owner', 'consumed'] as const) {
    const f = await fixture();
    try {
      const result = await f.provider.calendar!({userId: 'owner-a'}, query, {signal: new AbortController().signal, validate: async () => {},
        personalCompletionCourses: async () => ['10']});
      const validate = (value: unknown, owner = 'owner-a') => f.provider.validateCalendar!({userId: owner, sessionTokenHash: 'synthetic-session'}, value);
      if (mode === 'copy') await assert.rejects(validate(JSON.parse(JSON.stringify(result))), (error: any) => error.code === 'SCHOOL_SESSION_CHANGED');
      if (mode === 'owner') await assert.rejects(validate(result, 'owner-b'), (error: any) => error.code === 'SCHOOL_SESSION_CHANGED');
      if (mode === 'consumed') {await validate(result); await assert.rejects(validate(result), (error: any) => error.code === 'SCHOOL_SESSION_CHANGED');}
    } finally {await f.app.close();}
  }
});

const pendingGroup = (courseId: string, type: 'assignment' | 'commons' = 'assignment') => ({courseId, activities: {}, items: [{
  title: '합성 학교 TODO', componentType: type, componentId: '12', assignmentId: type === 'assignment' ? '31' : null,
  commonsType: type === 'commons' ? 'movie' : null, quizId: null, discussionId: null, sectionId: '13', unitId: '14', dueAt: null, sourceUrl: null,
}]});

test('TODO assignment backlinks reject duplicate assignment relations across types before selecting a supported item', () => {
  const row = moduleRow();
  const value = {catalog: {courses: [{id: '10', title: '합성 강좌 10'}]}, groups: [pendingGroup('10')],
    moduleProofs: [{courseId: '10', modules: [row]}]} as any;
  assert.equal(publicTasks(value)[0]!.moduleItemId, '90');
  row.items.push({...row.items[0]!, id: '91', contentType: 'quiz'});
  assert.equal(publicTasks(value)[0]!.moduleItemId, undefined);
  assert.equal(publicTasks(value)[0]!.assignmentId, '31'); assert.equal(publicTasks(value)[0]!.schoolStatus, null);
  row.items.shift();
  assert.equal(publicTasks(value)[0]!.moduleItemId, undefined);
});

test('TODO assignment and Commons backlinks reject global module activity ID duplicates in another week or type', () => {
  for (const type of ['assignment', 'commons'] as const) {
    const row = type === 'assignment' ? moduleRow() : {id: '40', title: '합성 주차', week: 1, items: [{id: '90', contentType: 'attendance_item',
      itemContentType: 'commons', attendanceItemId: '12', resourceType: 'movie', activityDetailAvailable: true, completed: true, published: true}]};
    const proof = {courseId: '10', modules: [row], commonsMappingVersion: 1, usePureCanvas: true};
    const value = {catalog: {courses: [{id: '10', title: '합성 강좌 10'}], commonsModes: {'10': true}}, groups: [pendingGroup('10', type)],
      taskMappingVersion: 2, moduleProofs: [proof]} as any;
    assert.equal(publicTasks(value)[0]!.moduleItemId, '90', type);
    proof.modules.push({id: '41', title: '다른 주차', week: 2, items: [{id: '90', contentType: 'quiz'}]} as any);
    assert.equal(publicTasks(value)[0]!.moduleItemId, undefined, type); assert.equal(publicTasks(value)[0]!.personalCompleted, undefined, type);
  }
});

test('cold TODO restores the exact persisted override without all-course fanout and keeps explicit false/reset distinct', async () => {
  const f = await fixture(); f.setTodos([pendingGroup('10'), pendingGroup('20')]);
  try {
    const first = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(first.statusCode, 200);
    const linked = first.json().items.find((item: any) => item.courseId === '10');
    assert.equal(linked.moduleItemId, '90'); assert.equal(linked.weekId, '40'); assert.equal(linked.personalCompleted, false); assert.equal(linked.moduleCompleted, true);
    assert.equal(first.json().items.find((item: any) => item.courseId === '20').moduleItemId, undefined);
    assert.deepEqual(f.schoolCalls, {calendar: 0, modules: ['10'], todos: 1, lessons: 0});
    f.rows.get('owner-a')![0]!.completed = true;
    const changed = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().items.find((item: any) => item.courseId === '10').personalCompleted, true);
    f.rows.set('owner-a', []);
    const reset = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(reset.statusCode, 200);
    assert.equal(reset.json().items.find((item: any) => item.courseId === '10').personalCompleted, null);
    assert.deepEqual(f.schoolCalls.modules, ['10']);
  } finally {await f.app.close();}
});

test('cold Commons TODO after school relogin maps only the own override course with exact item proof', async () => {
  const f = await fixture(); f.setTodos([pendingGroup('10', 'commons'), pendingGroup('20', 'commons')]);
  f.setModules([{id: '40', title: '합성 주차', week: 1, items: [{id: '90', contentType: 'attendance_item', itemContentType: 'commons',
    attendanceItemId: '12', resourceType: 'movie', activityDetailAvailable: true, completed: true, published: true}]}]);
  try {
    const first = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(first.statusCode, 200);
    assert.equal(first.json().items.find((item: any) => item.courseId === '10').personalCompleted, false);
    f.rows.get('owner-a')![0]!.completed = true; f.replace('owner-a');
    const restarted = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent'}), f.store, {...unavailableSchoolProvider, ...createLearningxReads(f.create())});
    try {
      const value = await restarted.inject({url: '/v1/tasks', headers}); assert.equal(value.statusCode, 200);
      const task = value.json().items.find((item: any) => item.courseId === '10');
      assert.equal(task.type, 'video'); assert.equal(task.moduleItemId, '90'); assert.equal(task.weekId, '40'); assert.equal(task.personalCompleted, true);
      assert.equal(task.moduleCompleted, true); assert.equal(task.schoolStatus, null);
      assert.equal(value.json().items.find((item: any) => item.courseId === '20').moduleItemId, undefined);
    } finally {await restarted.close();}
    assert.deepEqual(f.schoolCalls.modules, ['10', '10']);
  } finally {await f.app.close();}
});

test('a vanished pending school TODO is not synthesized from a personal override and unproven scope never causes module fanout', async () => {
  const f = await fixture();
  try {
    const value = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(value.statusCode, 200); assert.deepEqual(value.json().items, []);
    assert.deepEqual(f.schoolCalls.modules, []);
    f.setTodos([pendingGroup('10')]);
    await f.reader.invalidate('owner-a');
    await assert.rejects(f.provider.tasks!({userId: 'owner-a'}, {personalCompletionCourses: async () => ['20']}), (error: any) => error.code === 'SCHOOL_UPSTREAM_UNAVAILABLE');
    assert.deepEqual(f.schoolCalls.modules, []);
  } finally {await f.app.close();}
});

test('TODO deadline bounds a hanging owner completion lookup without a school module request or stale payload', async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const f = await fixture(), held = gate(); f.setTodos([pendingGroup('10')]); f.afterRows(() => held.promise);
  const alive = setTimeout(() => {}, 100);
  try {
    const value = await f.app.inject({url: '/v1/tasks', headers}); assert.equal(value.statusCode, 503);
    assert.equal(value.json().error.code, 'SCHOOL_PROVIDER_UNAVAILABLE'); assert.equal(value.json().items, undefined); assert.deepEqual(f.schoolCalls.modules, []);
  } finally {held.release(); clearTimeout(alive); await f.app.close();}
});
