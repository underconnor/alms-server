import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SchoolError, parseModules, type LearningxClient, type SchoolModule } from '@alms/ssu-api';
import { createLearningxReader as makeLearningxReader } from '../src/school-reader.js';
import { createLearningxReads, normalizeSchoolReadError, publicTasks, publicTaskCatalog, publicAttendance, publicCourseContent, type Catalog } from '../src/school-read.js';
import { encryptSchoolSession, decryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';

// Every school response in this unit suite is synthetic; never fetch a real Commons viewer.
function createLearningxReader(...[store, key, connect, loader]: Parameters<typeof makeLearningxReader>) {
  return makeLearningxReader(store, key, connect, loader ?? (async () => Buffer.from('%PDF-1.7\nsynthetic')));
}

function fixture() {
  const key = randomBytes(32), states = new Map<string, string>();
  const makeState = (owner: string, studentId: string) => encryptSchoolSession({ version: 1, identity: { studentId }, jar: { cookies: [] } }, key, owner, 'ssu');
  states.set('owner-a', makeState('owner-a', '90000001'));
  states.set('owner-b', makeState('owner-b', '90000002'));
  const store = {
    getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, previous: string, next: string) => {
      if (states.get(owner) !== previous) return false;
      states.set(owner, next); return true;
    },
  };
  return { key, states, store, makeState };
}

test('school catalog restores each owner, selects school defaults, and shares only same-owner in-flight reads', async () => {
  const f = fixture(); let connects = 0; const selected: string[][] = [];
  const reader = createLearningxReader(f.store, f.key, async state => {
    connects++;
    return { serialize: async () => ({ cookies: [] }), client: {
      terms: async () => [{ id: '1', name: '이전 학기', default: false }, { id: '2', name: '현재 학기', default: true }],
      courses: async (ids: string[]) => { selected.push(ids); return [{ id: state.identity.studentId, name: '합성 강좌', termId: '2', professors: null, ended: false, sourceUrl: 'https://canvas.ssu.ac.kr/courses/1' }]; },
    } as unknown as LearningxClient };
  });
  const [a, again, b] = await Promise.all([reader.catalog('owner-a'), reader.catalog('owner-a'), reader.catalog('owner-b')]);
  assert.equal(connects, 2); assert.equal(a, again); assert.notEqual(a.courses[0]!.id, b.courses[0]!.id);
  assert.deepEqual(selected, [['2'], ['2']]); assert.equal(a.term, '현재 학기');
  assert.deepEqual(a.termIds, ['2']); assert.equal('client' in a, false);
  assert.equal(a.courses[0]!.sourceUrl, null);
  assert.equal((await reader.catalog('owner-a')), a); assert.equal(connects, 2);
  assert.throws(() => decryptSchoolSession(f.states.get('owner-a')!, f.key, 'owner-b', 'ssu'));
});

test('a login racing a school read cannot be replaced by the old school jar', async () => {
  const f = fixture(); let newer = '';
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: {
    terms: async () => {
      newer = f.makeState('owner-a', '90000001'); f.states.set('owner-a', newer);
      return [];
    },
  } as unknown as LearningxClient }));
  await assert.rejects(reader.catalog('owner-a'), error => error instanceof AppError && error.statusCode === 409 && error.code === 'SCHOOL_SESSION_CHANGED');
  assert.equal(f.states.get('owner-a'), newer);
});

test('a delayed concurrent DB read cannot mistake the same reader jar refresh for expired authentication', async () => {
  const f = fixture(); let reads = 0, connects = 0;
  const store = { ...f.store, getEncryptedSchoolSession: async (owner: string) => {
    const snapshot = f.states.get(owner) ?? null;
    if (++reads === 2) await new Promise(resolve => setTimeout(resolve, 20));
    return snapshot;
  } };
  const reader = createLearningxReader(store, f.key, async () => {
    connects++;
    return { serialize: async () => ({ cookies: [] }), client: { terms: async () => [] } as unknown as LearningxClient };
  });
  const [first, second] = await Promise.all([reader.catalog('owner-a'), reader.catalog('owner-a')]);
  assert.equal(first, second); assert.equal(connects, 1); assert.equal(reads, 2); // Initial state plus the final publication check.
});

test('absent, swapped and corrupt encrypted school sessions fail before a school request', async () => {
  const f = fixture(); let connects = 0;
  const reader = createLearningxReader(f.store, f.key, async () => { connects++; throw new Error('must not connect'); });
  f.states.set('owner-b', f.states.get('owner-a')!);
  f.states.set('corrupt', 'synthetic-secret');
  for (const owner of ['missing', 'owner-b', 'corrupt']) {
    await assert.rejects(reader.catalog(owner), error => error instanceof AppError && error.statusCode === 401 && !error.message.includes('synthetic-secret'));
  }
  assert.equal(connects, 0);
});

test('unowned courses are rejected before modules and unavailable sections stay distinct from empty data', async () => {
  const f = fixture(); let moduleReads = 0;
  const provider = createLearningxReads(createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: {
    terms: async () => [{ id: '1', name: '합성 학기', default: true }],
    courses: async () => [{ id: '10', name: '합성 강좌', professors: null, termId: '1' }],
    todos: async () => [],
    modules: async () => { moduleReads++; return [{ id: '20', title: '학교 목록', week: null, items: [{ id: '30', title: '활동', contentType: 'unobserved_type', sourceUrl: null }] }]; },
  } as unknown as LearningxClient })));
  await assert.rejects(provider.course!({ userId: 'owner-a' }, 'other'), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(moduleReads, 0);
  const detail = await provider.course!({ userId: 'owner-a' }, '10') as any;
  assert.equal(detail.weeks[0].number, null); assert.equal(detail.weeks[0].isCurrent, false);
  assert.equal(detail.weeks[0].activities[0].type, 'other'); assert.equal(detail.weeks[0].activities[0].playbackAvailable, false);
  assert.equal(detail.availability.weeks, 'available'); assert.equal(detail.availability.assignments, 'available');
  assert.deepEqual(detail.assignments, []); assert.deepEqual(detail.materials, []);
  assert.deepEqual(detail.categoryScope, { materials: 'modules', assignments: 'modules' });
  assert.equal(detail.availability.notices, 'unavailable'); assert.equal(detail.availability.quizzes, 'unavailable');
  const dashboard = await provider.dashboard!({ userId: 'owner-a' }) as any;
  assert.equal(dashboard.availability.timetable, 'unavailable'); assert.equal(dashboard.currentCourse, null);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const course = { id: '10', title: '합성 강좌', professor: null, term: '합성 학기', sourceUrl: null };
const catalog: Catalog = { courses: [course], term: '합성 학기', termIds: ['2'] };
function schoolClient(overrides: Record<string, unknown> = {}): LearningxClient {
  return { terms: async () => [{ id: '2', name: '합성 학기', default: true }],
    courses: async () => [{ id: '10', name: '합성 강좌', termId: '2', professors: null }],
    modules: async () => [], todos: async () => [], lessons: async () => [], lessonAttendances: async () => [],
    ...overrides } as unknown as LearningxClient;
}

test('the whole course read owns its jar until CAS; another resource waits and another owner remains independent', { timeout: 5000 }, async () => {
  const f = fixture(), started = gate(), finish = gate(); const steps: string[] = [], restored: unknown[] = [];
  const reader = createLearningxReader(f.store, f.key, async session => {
    const a = session.identity.studentId === '90000001';
    restored.push(session.jar); steps.push(a ? 'a-connect' : 'b-connect');
    return { serialize: async () => ({ cookies: [], revision: a ? 'after-a' : 'after-b' }), client: schoolClient({
      modules: async () => { steps.push('a-modules-start'); started.release(); await finish.promise; steps.push('a-modules-end'); return []; },
      todos: async () => { steps.push(a ? 'a-todos' : 'b-todos'); return []; },
    }) };
  });
  const first = reader.readCourse('owner-a', '10'); await started.promise;
  const queued = reader.readTasks('owner-a');
  await reader.readTasks('owner-b');
  assert.equal(steps.includes('a-todos'), false);
  finish.release(); await Promise.all([first, queued]);
  assert.ok(steps.indexOf('a-modules-end') < steps.indexOf('a-todos'));
  assert.deepEqual(restored.at(-1), { cookies: [], revision: 'after-a' });
  assert.equal('client' in await reader.readCourse('owner-a', '10'), false);
});

test('a login during modules rejects the whole result and leaves the newer encrypted state intact', async () => {
  const f = fixture(); let newer = '', moduleCalls = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [], stale: true }), client: schoolClient({
    modules: async () => { moduleCalls++; newer = f.makeState('owner-a', '90000001'); f.states.set('owner-a', newer); return []; },
  }) }));
  await reader.catalog('owner-a');
  await assert.rejects(reader.readCourse('owner-a', '10'), error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  assert.equal(f.states.get('owner-a'), newer); assert.equal(moduleCalls, 1);
});

test('cached data is reauthorized from the current encrypted generation and never returns a client', async () => {
  const f = fixture(); let calls = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({ modules: async () => { calls++; return []; } }) }));
  const result = await reader.readCourse('owner-a', '10');
  const state = decryptSchoolSession(f.states.get('owner-a')!, f.key, 'owner-a', 'ssu');
  f.states.set('owner-a', encryptSchoolSession(state, f.key, 'owner-a', 'ssu'));
  assert.equal(await reader.readCourse('owner-a', '10'), result); assert.equal(calls, 1);
  f.states.set('owner-a', f.makeState('owner-a', '90000001'));
  await reader.readCourse('owner-a', '10'); assert.equal(calls, 2);
  f.states.set('owner-a', 'private-corrupt-state');
  await assert.rejects(reader.readCourse('owner-a', '10'), error => error instanceof AppError && error.statusCode === 401);
  assert.equal(calls, 2);
});

test('tasks reject a foreign course and a failed attendance batch is neither stored nor returned as a partial list', async () => {
  const f = fixture(); let serializations = 0, lessons = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => { serializations++; return { cookies: [] }; }, client: schoolClient({
    todos: async () => [{ courseId: '99', activities: {}, items: [] }],
    lessons: async () => { lessons++; return []; },
    lessonAttendances: async () => { throw new SchoolError('upstream_unavailable'); },
  }) }));
  await assert.rejects(reader.readTasks('owner-a'), error => error instanceof AppError && error.statusCode === 502);
  await assert.rejects(reader.readAttendance('owner-a', '99'), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(lessons, 0);
  await assert.rejects(reader.readAttendance('owner-a', '10'), error => error instanceof AppError && error.statusCode === 502);
  await assert.rejects(reader.readAttendance('owner-a', '10'));
  assert.equal(lessons, 2); assert.equal(serializations, 0);
});

const todo = { title: '합성 활동', componentType: 'assignment', commonsType: null, dueAt: '2099-01-02T00:00:00Z',
  componentId: '21', assignmentId: '31', quizId: null, discussionId: null, sectionId: '1', unitId: '1', sourceUrl: null } as const;
test('TODO projection keeps stable IDs, observed types and unknown completion without exposing raw properties', () => {
  const data = { catalog, observedAt: '2099-01-01T00:00:00Z', groups: [{ courseId: '10', activities: {}, items: [
    { ...todo, privateField: 'private-response' },
    { ...todo, componentId: '22', assignmentId: null, componentType: 'commons', commonsType: 'mp4', dueAt: null },
    { ...todo, componentId: '23', componentType: 'future', dueAt: '2099-01-02 09:00' },
  ] }] };
  const items = publicTasks(data);
  assert.equal(items.length, 3); assert.equal(items[0]!.type, 'assignment');
  assert.equal(items.find(item => item.type === 'video')!.dueAt, null);
  assert.equal(items.find(item => item.type === 'other')!.dueAt, null);
  assert.ok(items.every(item => !('completed' in item) && item.schoolStatus === null && item.sourceUrl === null));
  assert.ok(items.every(item => item.todoSource === 'school_todo' && item.playbackAvailable === false));
  assert.doesNotMatch(JSON.stringify(items), /private-response/);
  const next = publicTasks({ ...data, groups: [{ ...data.groups[0]!, items: [{ ...todo, dueAt: null }] }] });
  assert.equal(next[0]!.id, items[0]!.id);
  assert.throws(() => publicTasks({ ...data, groups: [{ ...data.groups[0]!, courseId: '99' }] }), { code: 'unexpected_response' });
  assert.equal(publicTasks({ ...data, groups: [{ ...data.groups[0]!, items: [{ ...todo, dueAt: '2099-02-30T00:00:00Z' }] }] })[0]!.dueAt, null);
});

test('TODO backlinks join only exact unique same-course explicit assignment IDs and never titles or component IDs', () => {
  const modules = parseModules([{module_id: 40, title: '학교 주차', module_items: [
    {module_item_id: 90, content_type: 'assignment', content_id: 31, title: '다른 제목', completed: true, completion_determinable: true},
    {module_item_id: 21, content_type: 'assignment', content_id: 99, title: todo.title, published: true},
  ]}], '10');
  const data = {catalog, groups: [{courseId: '10', activities: {}, items: [todo]}], observedAt: '2099-01-01T00:00:00Z',
    moduleProofs: [{courseId: '10', modules}], mappingGeneration: 'private-generation'};
  const mapped = publicTasks(data)[0]!;
  assert.equal(mapped.assignmentId, '31'); assert.equal(mapped.moduleItemId, '90'); assert.equal(mapped.weekId, '40');
  assert.equal(mapped.moduleCompleted, true); assert.equal(mapped.personalCompleted, null); assert.equal(mapped.schoolStatus, null);
  assert.notEqual(mapped.id, mapped.moduleItemId); assert.doesNotMatch(JSON.stringify(mapped), /private-generation/);
  for (const moduleProofs of [[], [{courseId: '99', modules}], [{courseId: '10', modules: [...modules, ...modules]}],
    [{courseId: '10', modules: modules.map(module => ({...module, items: module.items.map(item => ({...item, published: false}))}))}]]) {
    const row = publicTasks({...data, moduleProofs})[0]!;
    assert.equal(row.assignmentId, '31'); assert.equal(row.moduleItemId, undefined); assert.equal(row.weekId, undefined);
    assert.equal(row.moduleCompleted, undefined);
  }
  const absent = publicTasks({...data, groups: [{...data.groups[0]!, items: [{...todo, assignmentId: null}]}]})[0]!;
  assert.equal(absent.assignmentId, undefined); assert.equal(absent.moduleItemId, undefined);
});

test('course TODO counts preserve only observed safe school keys; missing groups and counts remain absent', () => {
  const two = {...catalog, courses: [...catalog.courses, {...course, id: '20'}]};
  const result = publicTaskCatalog(two, [{courseId: '10', activities: {total_unsubmitted_assignments: 2,
    total_incompleted_movies: 0, total_unread_resources: -1, private_count: 99} as any, items: []}]);
  assert.deepEqual(result.courses[0]!.todoCounts, {total_unsubmitted_assignments: 2, total_incompleted_movies: 0});
  assert.equal(result.courses[1]!.todoCounts, undefined); assert.equal(catalog.courses[0]!.todoCounts, undefined);
  assert.throws(() => publicTaskCatalog(catalog, [{courseId: '99', activities: {}, items: []}]), {code: 'unexpected_response'});
});

test('cold TODO has no modules fanout; later exact cached course proof adds backlinks without another school GET', async () => {
  const f = fixture(); let moduleGets = 0, todoGets = 0;
  const modules = parseModules([{module_id: 40, title: '학교 주차', module_items: [
    {module_item_id: 90, content_type: 'assignment', content_id: 31, title: '서로 다른 제목', completion_determinable: true, completed: false},
  ]}], '10');
  const reader = createLearningxReader(f.store, f.key, async () => ({serialize: async () => ({cookies: []}), client: schoolClient({
    modules: async () => {moduleGets++; return modules;}, todos: async () => {todoGets++; return [{courseId: '10', activities: {total_unsubmitted_assignments: 2}, items: [todo]}];},
  })}));
  const first = await reader.readTasks('owner-a');
  assert.equal(moduleGets, 0); assert.equal(todoGets, 1); assert.equal(publicTasks(first)[0]!.moduleItemId, undefined);
  assert.equal(publicTasks(first)[0]!.assignmentId, '31');
  assert.deepEqual((await reader.catalog('owner-a')).courses[0]!.todoCounts, {total_unsubmitted_assignments: 2});
  await reader.readCourse('owner-a', '10'); assert.equal(moduleGets, 1);
  const next = await reader.readTasks('owner-a');
  assert.equal(moduleGets, 1); assert.equal(todoGets, 1); assert.equal(publicTasks(next)[0]!.moduleItemId, '90');
  assert.equal(publicTasks(next)[0]!.weekId, '40'); assert.equal(publicTasks(next)[0]!.moduleCompleted, false);
  const other = await reader.readTasks('owner-b');
  assert.equal(publicTasks(other)[0]!.moduleItemId, undefined); assert.equal(moduleGets, 1);
});

test('lesson attendance joins school dates while preserving unknown statuses and no progress evidence', () => {
  const result = publicAttendance({ observedAt: '2099-01-01T00:00:00Z', courses: [{ course,
    lessons: [{ week: 1, lessons: [{ lesson: 2, displayClassDate: null, classDate: '2099-01-02', classStartTime: '09:00', makeupDate: null, makeupStartTime: null }] }],
    attendances: [{ week: 1, lesson: 2, schoolStatus: 'attendance', calculationType: 'OFFLINE' },
      { week: 2, lesson: 1, schoolStatus: 'future_status', calculationType: null }] }] });
  assert.equal(result[0]!.date, '2099-01-02T00:00:00+09:00'); assert.equal(result[0]!.schoolStatus, '출석');
  assert.equal(result[1]!.date, null); assert.equal(result[1]!.schoolStatus, 'future_status');
  assert.ok(result.every(item => item.progressPercent === null && item.sourceUrl === null && item.type === '차시 출결'));
  assert.notEqual(result[0]!.id, result[1]!.id);
});

test('SDK Commons mp4 modules remain playable video details in the public course projection', () => {
  const modules = parseModules([{ module_id: 1, title: '합성 주차', week_position: 1,
    module_items: ['mp4', 'movie', 'MP4', 'video/mp4'].map((type, index) => ({
      module_item_id: 20 + index, title: '합성 영상', content_type: 'attendance_item',
      completion_determinable: true, completed: false, published: true,
      content_data: { course_id: 10, item_id: 30 + index, item_content_type: 'commons',
        item_content_data: { content_type: type, content_id: 'private-synthetic-content', viewer_url: 'https://private.invalid' } },
    })),
  }], '10');
  const result = publicCourseContent({ course: { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: null }, modules }, true);
  const items = result.weeks[0]!.activities;
  assert.deepEqual(items.map(item => item.type), ['video', 'video', 'other', 'other']);
  assert.deepEqual(items.map(item => item.detailAvailable), [true, true, false, false]);
  assert.ok(items.every(item => item.moduleCompleted === false && item.schoolStatus === null
    && item.progressPercent === null && item.playbackAvailable === false && item.sourceUrl === null));
  assert.deepEqual(result.materials, []); assert.deepEqual(result.assignments, []);
  assert.doesNotMatch(JSON.stringify(result), /private-synthetic-content|private\.invalid/);
  assert.equal(publicCourseContent({ course: result.course, modules }, false).weeks[0]!.activities[0]!.detailAvailable, false);
});

test('course playback selection is opt-in and uses only confirmed video, detail, publish and unlock metadata', t => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const modules = parseModules([{ module_id: 1, title: '합성 주차', week_position: 1,
    module_items: ['mp4', 'movie', 'MP4', 'video/mp4', 'pdf'].map((type, index) => ({
      module_item_id: 20 + index, title: '합성 활동', content_type: 'attendance_item',
      completion_determinable: true, completed: index === 0, published: true,
      content_data: { course_id: 10, item_id: 30 + index, item_content_type: 'commons',
        unlock_at: '2030-01-01T09:00:00+09:00', due_at: '2029-12-31T00:00:00Z',
        item_content_data: { content_type: type, content_id: 'private-content', viewer_url: 'https://private.invalid' } },
    })),
  }], '10');
  const data = { course, modules };
  for (const args of [[true], [true, false], [false, true]] as const) {
    assert.ok(publicCourseContent(data, ...args).weeks[0]!.activities.every(item => item.playbackAvailable === false));
  }
  const items = publicCourseContent(data, true, true).weeks[0]!.activities;
  assert.deepEqual(items.map(item => item.playbackAvailable), [true, true, false, false, false]);
  // Prior completion and due dates are not evidence for recognized school attendance or job support.
  assert.equal(items[0]!.moduleCompleted, true);
  assert.ok(items.every(item => item.schoolStatus === null && item.progressPercent === null && item.sourceUrl === null));
  assert.doesNotMatch(JSON.stringify(items), /private-content|private\.invalid/);
});

test('course selection rejects unknown, future, invalid and ambiguous unlock/publish/detail metadata', t => {
  t.mock.method(Date, 'now', () => Date.parse('2030-01-01T00:00:00Z'));
  const base = { id: '20', title: '합성 영상', contentType: 'attendance_item', itemContentType: 'commons',
    resourceType: 'movie', sourceUrl: 'https://private.invalid', activityDetailAvailable: true,
    published: true, unlockAt: '2029-12-31T23:59:59Z' };
  const variants = [
    base, { ...base, published: false }, { ...base, published: null }, { ...base, published: undefined },
    { ...base, activityDetailAvailable: false }, { ...base, activityDetailAvailable: undefined },
    { ...base, unlockAt: null }, { ...base, unlockAt: undefined }, { ...base, unlockAt: '' },
    { ...base, unlockAt: '2030-01-01T00:00:00.001Z' }, { ...base, unlockAt: '2029-12-31 09:00' },
    { ...base, unlockAt: '2029-02-30T00:00:00Z' }, { ...base, unlockAt: 'not-a-date' },
    { ...base, contentType: 'assignment' }, { ...base, itemContentType: 'other' },
  ];
  const result = publicCourseContent({ course, modules: [{ id: '1', title: '합성 주차', week: 1, items: variants }] }, true, true);
  assert.deepEqual(result.weeks[0]!.activities.map(item => item.playbackAvailable), [true, ...variants.slice(1).map(() => false)]);
});

test('assignment IDs project only explicit school mapping and never title matches or another activity type', () => {
  const item = { id: '30', title: '같은 제목', contentId: '0', contentType: 'assignment', itemContentType: 'assignment',
    resourceType: null, completed: null, unlockAt: null, published: true, activityDetailAvailable: false };
  const modules = [{ id: '1', title: '합성 주차', week: 1, items: [
    { ...item, assignmentId: '90' }, { ...item, id: '31' }, { ...item, id: '32', assignmentId: 'private-token' },
    { ...item, id: '33', contentType: 'commons', itemContentType: 'commons', resourceType: 'pdf', assignmentId: '90' },
  ] }] as unknown as SchoolModule[];
  const result = publicCourseContent({ course: { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: null }, modules });
  assert.deepEqual(result.weeks[0]!.activities.map(value => value.assignmentId), ['90', null, null, null]);
});
test('module classification uses only observed metadata and never turns completion into attendance', async () => {
  const f = fixture();
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    modules: async () => [{ id: '1', title: '주차', week: 1, items: [
      { id: '1', title: '영상', contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'movie', completed: true, dueAt: '2099-01-02T00:00:00Z' },
      { id: '2', title: '자료', contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'pdf', completed: null },
      { id: '3', title: '과제', contentType: 'assignment', completed: false },
      { id: '4', title: '알 수 없음', contentType: 'attendance_item', itemContentType: 'future', resourceType: 'movie' },
    ] }],
  }) }));
  const result = await createLearningxReads(reader).course!({ userId: 'owner-a' }, '10') as any;
  const items = result.weeks[0].activities;
  assert.deepEqual(items.map((item: any) => item.type), ['video', 'material', 'assignment', 'other']);
  assert.deepEqual(items.map((item: any) => item.moduleCompleted), [true, null, false, null]);
  assert.ok(items.every((item: any) => item.schoolStatus === null && item.progressPercent === null && item.playbackAvailable === false));
  assert.deepEqual(result.materials, [items[1]]); assert.deepEqual(result.assignments, [items[2]]);
  assert.deepEqual(result.categoryScope, { materials: 'modules', assignments: 'modules' });
  assert.equal(result.availability.materials, 'available'); assert.equal(result.availability.assignments, 'available');
  assert.equal(result.availability.notices, 'unavailable'); assert.deepEqual(result.notices, []);
  assert.equal(result.availability.quizzes, 'unavailable'); assert.deepEqual(result.quizzes, []);
});

test('an empty term set is a verified empty task list without calling the invalid empty-term API', async () => {
  const f = fixture(); let todoCalls = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    terms: async () => [], todos: async () => { todoCalls++; throw new Error('must not request'); },
  }) }));
  const result = await createLearningxReads(reader).tasks!({ userId: 'owner-a' });
  assert.deepEqual(result, { items: [], courses: [] }); assert.equal(todoCalls, 0);
});

test('school errors expose only normalized authentication, unsupported and upstream states', () => {
  for (const [code, status] of [['authentication_required', 401], ['identity_mismatch', 401], ['unsupported', 503], ['unexpected_response', 502], ['upstream_unavailable', 502]] as const) {
    assert.throws(() => normalizeSchoolReadError(new SchoolError(code)), error => error instanceof AppError && error.statusCode === status);
  }
  assert.throws(() => normalizeSchoolReadError(new Error('synthetic-private-response')), error => error instanceof AppError && error.statusCode === 502 && !error.message.includes('synthetic-private-response'));
});

function activityFixture(overrides: Record<string,unknown> = {}) {
  return {courseId:'10',moduleItemId:'30',itemId:'40',title:'합성 자료',descriptionText:'자료 본문',
    itemContentType:'commons',resourceType:'pdf',published:true,useAttendance:false,opened:true,
    unlockAt:'2026-09-01T00:00:00+09:00',dueAt:null,lateAt:null,lockAt:null,
    materialViewerUrl:'https://commons.ssu.ac.kr/em/synthetic',fileName:'sample.pdf',reportedSizeBytes:1234,durationValue:null,
    attendance:{completed:false,status:'none',progressValue:null,lastPositionValue:null}, ...overrides};
}

test('activity reads check course ownership, isolate users and expose only approved detail fields', async () => {
  const f = fixture(); let calls = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({serialize:async()=>({cookies:[]}),client:schoolClient({
    moduleActivityDetail: async (courseId: string, moduleItemId: string) => {
      calls++; assert.equal(courseId,'10'); assert.equal(moduleItemId,'30');
      return activityFixture({privateField:'never-forward',viewerUrl:'https://invalid.test/private-student'});
    },
  })}));
  const provider = createLearningxReads(reader);
  await assert.rejects(provider.activity!({userId:'owner-a'},'99','30'), error => error instanceof AppError && error.statusCode===404);
  assert.equal(calls,0);
  const a = await provider.activity!({userId:'owner-a'},'10','30') as any;
  await provider.activity!({userId:'owner-a'},'10','30'); assert.equal(calls,1);
  await provider.activity!({userId:'owner-b'},'10','30'); assert.equal(calls,2);
  assert.equal(a.materialViewerUrl,'https://commons.ssu.ac.kr/em/synthetic');
  assert.equal(a.fileSizeBytes,1234); assert.equal(a.completed,false); assert.equal(a.type,'material');
  for (const absent of ['privateField','viewerUrl','itemId','durationValue','progressValue','client','jar']) assert.equal(absent in a,false);
  assert.equal(JSON.stringify(a).includes('private-student'),false);
});

test('unpublished, unopened and video activity do not expose a material viewer', async () => {
  for (const overrides of [{published:false},{opened:false},{published:null},{resourceType:'movie'}]) {
    const reader = {readActivity:async()=>({course,detail:activityFixture(overrides),observedAt:'2026-10-01T00:00:00Z'})} as any;
    const value = await createLearningxReads(reader).activity!({userId:'owner-a'},'10','30') as any;
    assert.equal(value.materialViewerUrl,null);
  }
  const reader = {readActivity:async()=>({course,detail:activityFixture({courseId:'99'}),observedAt:'2026-10-01T00:00:00Z'})} as any;
  await assert.rejects(createLearningxReads(reader).activity!({userId:'owner-a'},'10','30'),error=>error instanceof AppError&&error.statusCode===502);
});

test('a login during activity read cannot publish stale details or replace newer school state', async () => {
  const f = fixture(); let newer = '';
  const reader = createLearningxReader(f.store,f.key,async()=>({serialize:async()=>({cookies:[],stale:true}),client:schoolClient({
    moduleActivityDetail:async()=>{newer=f.makeState('owner-a','90000001');f.states.set('owner-a',newer);return activityFixture();},
  })}));
  await assert.rejects(reader.readActivity!('owner-a','10','30'),error=>error instanceof AppError&&error.code==='SCHOOL_SESSION_CHANGED');
  assert.equal(f.states.get('owner-a'),newer);
});

const warmItem = (id: string, overrides: Record<string, unknown> = {}) => ({ id, title: '합성 자료',
  contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'pdf', published: true,
  activityDetailAvailable: true, unlockAt: null, ...overrides });
const warmModules = (items: ReturnType<typeof warmItem>[]) => [{ id: '20', title: '합성 주차', week: 1, items }];
const flushWarmups = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('a course returns before bounded material-only prewarming and direct opens reuse that metadata', async () => {
  const f = fixture(), entered = gate(), release = gate(); const reads: string[] = [];
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    modules: async () => warmModules([
      warmItem('31', { resourceType: 'movie' }), warmItem('32', { published: false }),
      warmItem('33', { published: null }), warmItem('34', { unlockAt: '2999-01-01T00:00:00Z' }),
      warmItem('35', { unlockAt: 'invalid' }), warmItem('36', { contentType: 'assignment' }),
      warmItem('37', { activityDetailAvailable: false }), warmItem('40'), warmItem('41', { resourceType: 'file' }),
      warmItem('42'), warmItem('43'),
    ]),
    moduleActivityDetail: async (_course: string, id: string) => {
      reads.push(id); if (id === '40') { entered.release(); await release.promise; }
      return activityFixture({ moduleItemId: id });
    },
    play: () => assert.fail('prewarming must never start playback'),
  }) }), async () => Buffer.from('%PDF-1.7\nsynthetic'));
  const response = await reader.readCourse('owner-a', '10');
  assert.equal(response.course.id, '10'); assert.deepEqual(reads, []);
  await entered.promise;
  const opened = reader.readActivity!('owner-a', '10', '40');
  release.release(); await opened; await flushWarmups();
  assert.deepEqual(reads, ['40', '41', '42']);
  await reader.readActivity!('owner-a', '10', '41'); assert.deepEqual(reads, ['40', '41', '42']);
});

test('prewarmed material metadata stays isolated by owner and expires with the normal short TTL', async t => {
  const f = fixture(); const reads: string[] = []; let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const reader = createLearningxReader(f.store, f.key, async state => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    modules: async () => warmModules([warmItem('40')]),
    moduleActivityDetail: async () => { reads.push(state.identity.studentId); return activityFixture({ moduleItemId: '40' }); },
  }) }), async () => Buffer.from('%PDF-1.7\nsynthetic'));
  await reader.readCourse('owner-a', '10'); await flushWarmups();
  await reader.readActivity!('owner-a', '10', '40'); assert.deepEqual(reads, ['90000001']);
  await reader.readActivity!('owner-b', '10', '40'); assert.deepEqual(reads, ['90000001', '90000002']);
  clock += 30_001;
  await reader.readActivity!('owner-a', '10', '40'); assert.deepEqual(reads, ['90000001', '90000002', '90000001']);
});

test('a new login or logout cancels queued material warmup before any school detail request', async () => {
  for (const loggedOut of [false, true]) {
    const f = fixture(); let reads = 0;
    const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
      modules: async () => warmModules([warmItem('40'), warmItem('41')]),
      moduleActivityDetail: async () => { reads++; return activityFixture({ moduleItemId: '40' }); },
    }) }), async () => Buffer.from('%PDF-1.7\nsynthetic'));
    await reader.readCourse('owner-a', '10');
    if (loggedOut) f.states.delete('owner-a'); else f.states.set('owner-a', f.makeState('owner-a', '90000001'));
    await flushWarmups(); assert.equal(reads, 0);
  }
});

test('speculative school failure stops the batch without evicting the visible course metadata', async () => {
  const f = fixture(); let moduleReads = 0, activityReads = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    modules: async () => { moduleReads++; return warmModules([warmItem('40'), warmItem('41')]); },
    moduleActivityDetail: async () => { activityReads++; throw new SchoolError('upstream_unavailable'); },
  }) }), async () => Buffer.from('%PDF-1.7\nsynthetic'));
  const value = await reader.readCourse('owner-a', '10'); await flushWarmups();
  assert.equal(activityReads, 1); assert.equal(await reader.readCourse('owner-a', '10'), value); assert.equal(moduleReads, 1);
  await flushWarmups();
});

test('foreground navigation runs between warm reads and a newly opened course replaces the queued materials', async () => {
  const f = fixture(), started = gate(), finish = gate(); const steps: string[] = [];
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    courses: async () => ['10', '11'].map(id => ({ id, name: '합성 강좌', termId: '2', professors: null })),
    modules: async (id: string) => { steps.push(`course:${id}`); return warmModules(id === '10'
      ? [warmItem('40'), warmItem('41'), warmItem('42')] : [warmItem('50')]); },
    moduleActivityDetail: async (courseId: string, id: string) => {
      steps.push(`detail:${id}`); if (id === '40') { started.release(); await finish.promise; }
      return activityFixture({ courseId, moduleItemId: id });
    },
  }) }), async () => Buffer.from('%PDF-1.7\nsynthetic'));
  await reader.readCourse('owner-a', '10'); await started.promise;
  const next = reader.readCourse('owner-a', '11'); finish.release(); await next; await flushWarmups();
  assert.deepEqual(steps, ['course:10', 'detail:40', 'course:11', 'detail:50']);
});

test('material bytes are prewarmed, reused, and rechecked against current publication before being served', async t => {
  const f = fixture(); let loads = 0, opened = true, now = Date.now(); t.mock.method(Date, 'now', () => now);
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    modules: async () => warmModules([warmItem('40')]),
    moduleActivityDetail: async () => activityFixture({ moduleItemId: '40', opened }),
  }) }), async () => { loads++; return Buffer.from('%PDF-1.7\nsynthetic'); });
  await reader.readCourse('owner-a', '10'); await flushWarmups(); assert.equal(loads, 1);
  assert.match((await reader.readMaterial!('owner-a', '10', '40')).bytes.toString(), /^%PDF-/); assert.equal(loads, 1);
  opened = false; now += 30_001;
  await assert.rejects(reader.readMaterial!('owner-a', '10', '40'), error => error instanceof AppError && error.code === 'MATERIAL_UNAVAILABLE');
  assert.equal(loads, 1);
  await assert.rejects(reader.readMaterial!('owner-a', '99', '40'), error => error instanceof AppError && error.statusCode === 404);
});

test('material download cannot publish bytes when a new login arrives while it is in flight', async () => {
  const f = fixture(), started = gate(), finish = gate(); let loads = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async () => activityFixture(),
  }) }), async () => { loads++; started.release(); await finish.promise; return Buffer.from('%PDF-1.7\nsynthetic'); });
  const downloading = reader.readMaterial!('owner-a', '10', '30'); await started.promise;
  f.states.set('owner-a', f.makeState('owner-a', '90000001')); finish.release();
  await assert.rejects(downloading, error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  await reader.readMaterial!('owner-a', '10', '30'); assert.equal(loads, 2);
});

test('unpublished, unopened and non-PDF resources cannot request binary downloads', async () => {
  for (const overrides of [{ published: false }, { opened: false }, { resourceType: 'movie' }, { resourceType: 'file' }, { materialViewerUrl: 'https://foreign.test/private' }]) {
    const f = fixture(); let loads = 0;
    const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
      moduleActivityDetail: async () => activityFixture(overrides),
    }) }), async () => { loads++; return Buffer.from('%PDF-1.7\nsynthetic'); });
    await assert.rejects(reader.readMaterial!('owner-a', '10', '30'), error => error instanceof AppError && error.code === 'MATERIAL_UNAVAILABLE');
    assert.equal(loads, 0);
  }
});

test('PDF byte warmup starts when the front prefetches a selected-week activity, without opening the course head first', async () => {
  const f = fixture(); const loaded: string[] = [];
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async (_courseId: string, id: string) => activityFixture({ moduleItemId: id, materialViewerUrl: `https://commons.ssu.ac.kr/em/synthetic-${id}` }),
  }) }), async url => { loaded.push(url); return Buffer.from('%PDF-1.7\nsynthetic'); });
  await reader.readActivity!('owner-a', '10', '90'); await flushWarmups();
  assert.deepEqual(loaded, ['https://commons.ssu.ac.kr/em/synthetic-90']);
  await reader.readMaterial!('owner-a', '10', '90'); assert.equal(loaded.length, 1);
});

test('publication is checked again if the metadata expires while waiting for PDF bytes', async t => {
  const f = fixture(); let now = Date.now(), opened = true; t.mock.method(Date, 'now', () => now);
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async () => activityFixture({ opened }),
  }) }), async () => { now += 30_001; opened = false; return Buffer.from('%PDF-1.7\nsynthetic'); });
  await assert.rejects(reader.readMaterial!('owner-a', '10', '30'), error => error instanceof AppError && error.code === 'MATERIAL_UNAVAILABLE');
});

test('a fresh metadata update revoking a material while it downloads blocks the old PDF response', async t => {
  const f = fixture(), started = gate(), finish = gate(); let now = Date.now(), opened = true; t.mock.method(Date, 'now', () => now);
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async () => activityFixture({ opened }),
  }) }), async () => { started.release(); await finish.promise; return Buffer.from('%PDF-1.7\nsynthetic'); });
  const downloading = reader.readMaterial!('owner-a', '10', '30'); await started.promise;
  now += 30_001; opened = false; await reader.readActivity!('owner-a', '10', '30'); finish.release();
  await assert.rejects(downloading, error => error instanceof AppError && error.code === 'MATERIAL_UNAVAILABLE');
});

test('explicit PDF retry bypasses cached ownership, metadata and bytes while ordinary reads reuse them', async () => {
  const f = fixture(); let loads = 0, metadata = 0, catalogs = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    courses: async () => { catalogs++; return [{ id: '10', name: '합성 강좌', termId: '2', professors: null }]; },
    moduleActivityDetail: async () => { metadata++; return activityFixture(); },
  }) }), async () => Buffer.from(`%PDF-1.7\nsynthetic-${++loads}`));
  const first = await reader.readMaterial!('owner-a', '10', '30');
  assert.equal((await reader.readMaterial!('owner-a', '10', '30')).bytes, first.bytes);
  assert.deepEqual([loads, metadata, catalogs], [1, 1, 1]);
  const retried = await reader.readMaterial!('owner-a', '10', '30', { refresh: true });
  assert.notDeepEqual(retried.bytes, first.bytes); assert.deepEqual([loads, metadata, catalogs], [2, 2, 2]);
  assert.equal((await reader.readMaterial!('owner-a', '10', '30')).bytes, retried.bytes);
});

test('PDF retry immediately honors revoked publication and enrollment without using old bytes', async () => {
  for (const revoke of ['publication', 'enrollment']) {
    const f = fixture(); let revoked = false, loads = 0;
    const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
      courses: async () => revoked && revoke === 'enrollment' ? [] : [{ id: '10', name: '합성 강좌', termId: '2', professors: null }],
      moduleActivityDetail: async () => activityFixture({ opened: !revoked }),
    }) }), async () => { loads++; return Buffer.from('%PDF-1.7\nsynthetic'); });
    await reader.readMaterial!('owner-a', '10', '30'); revoked = true;
    await assert.rejects(reader.readMaterial!('owner-a', '10', '30', { refresh: true }), error => error instanceof AppError && error.statusCode === (revoke === 'enrollment' ? 404 : 503));
    assert.equal(loads, 1);
  }
});

test('PDF retry cancels an old download, preserves new bytes and never records a school view', async () => {
  const f = fixture(), started = gate(), finish = gate(); let loads = 0, reports = 0;
  const reader = makeLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async () => activityFixture(),
  }) }), async () => { const call = ++loads; if (call === 1) { started.release(); await finish.promise; } return Buffer.from(`%PDF-1.7\nsynthetic-${call}`); },
  undefined, undefined, async () => { reports++; throw new Error('must not write'); });
  const downloading = reader.readMaterial!('owner-a', '10', '30');
  const rejected = assert.rejects(downloading, error => error instanceof AppError && error.code === 'MATERIAL_REFRESHED');
  await started.promise;
  const fresh = await reader.readMaterial!('owner-a', '10', '30', { refresh: true });
  finish.release(); await rejected;
  assert.equal((await reader.readMaterial!('owner-a', '10', '30')).bytes, fresh.bytes);
  assert.equal(loads, 2); assert.equal(reports, 0);
});

test('PDF retry cannot return new bytes after school login is replaced during the download', async () => {
  const f = fixture(); let loads = 0;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({ cookies: [] }), client: schoolClient({
    moduleActivityDetail: async () => activityFixture(),
  }) }), async () => { if (++loads === 2) f.states.set('owner-a', f.makeState('owner-a', '90000001')); return Buffer.from('%PDF-1.7\nsynthetic'); });
  await reader.readMaterial!('owner-a', '10', '30');
  await assert.rejects(reader.readMaterial!('owner-a', '10', '30', { refresh: true }), error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
});


test('activity projection exposes verified seconds and percentage without raw video callbacks', async () => {
  const detail=activityFixture({resourceType:'movie',durationSeconds:120,attendance:{completed:false,status:'none',progressValue:30,lastPositionValue:20,progressSeconds:30,lastPositionSeconds:20,progressPercent:25}});
  const reader={readActivity:async()=>({course,detail,observedAt:'2026-10-01T00:00:00Z'})} as any;
  const result=await createLearningxReads(reader).activity!({userId:'owner'},'10','30') as any;
  assert.equal(result.durationSeconds,120);assert.equal(result.progressSeconds,30);assert.equal(result.progressPercent,25);
  assert.equal(result.completed,false);assert.equal(result.materialViewerUrl,null);assert.equal('viewerUrl' in result,false);
});
