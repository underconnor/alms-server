import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient, type SchoolActivityDetail } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads, normalizeSchoolReadError, readLmsDashboard } from '../src/school-read.js';
import type { LearningxReader } from '../src/school-read.js';
import { createCombinedDashboard } from '../src/school-dashboard.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import type { Store, PgStore } from '../src/store.js';
import { createAssignmentSubmissionSchool } from '../src/assignment-submission-school.js';
import { ManualVideoService } from '../src/manual-video-service.js';
import type { PlaybackLeaseRepository } from '../src/manual-video-lease.js';
import type { ManualVideoSchool } from '../src/manual-video-types.js';

function fixture() {
  const key = randomBytes(32), states = new Map<string, string>(), selected: Array<{ owner: string; ids: string[] }> = [];
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(),
    identity: { studentId: owner === 'a' ? '90000001' : '90000002' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b'); let termsReads = 0, modules = 0;
  const store = { getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, before: string, after: string) => {
      if (states.get(owner) !== before) return false; states.set(owner, after); return true;
    } };
  const reader = createLearningxReader(store, key, async session => ({ serialize: async () => ({}), client: {
    terms: async () => { termsReads++; return [{ id: '1', name: '2025년 2학기', default: false },
      { id: '2', name: '2026년 1학기', default: false }, { id: '3', name: '2026년 2학기', default: true }]; },
    courses: async (ids: string[]) => { selected.push({ owner: session.identity.studentId, ids });
      return ids.map(id => ({ id: `${session.identity.studentId}${id}`, name: `합성 강좌 ${id}`, termId: id,
        professors: null, ended: id !== '3' })); },
    modules: async () => { modules++; return []; },
  } as unknown as LearningxClient }), async () => Buffer.from('%PDF synthetic'));
  return { reader, key, states, replace, selected, store, counts: () => ({ termsReads, modules }) };
}

test('term list reflects school order/year/default and never fetches courses to populate the selector', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.readTerms!('a'), { items: [
    { id: '1', label: '2025년 2학기', year: 2025, current: false },
    { id: '2', label: '2026년 1학기', year: 2026, current: false },
    { id: '3', label: '2026년 2학기', year: 2026, current: true },
  ], defaultTermId: '3' });
  assert.deepEqual(f.selected, []); assert.equal(f.counts().termsReads, 1);
  await f.reader.readTerms!('a'); assert.equal(f.counts().termsReads, 1);
  f.replace('a'); await f.reader.readTerms!('a'); assert.equal(f.counts().termsReads, 2);
});

test('explicit past term selection preserves ended courses and leaves the dashboard default unchanged', async () => {
  const f = fixture(), provider = createLearningxReads(f.reader);
  const prior = await provider.courses!({ userId: 'a' }, { termId: '2' }) as any;
  assert.equal(prior.term, '2026년 1학기'); assert.equal(prior.selectedTermId, '2');
  assert.equal(prior.items[0].termId, '2'); assert.equal(prior.items[0].ended, true);
  const current = await provider.courses!({ userId: 'a' }) as any;
  assert.equal(current.selectedTermId, '3'); assert.equal(current.items[0].ended, false);
  assert.deepEqual(f.selected.map(value => value.ids), [['2'], ['3']]);
  await provider.courses!({ userId: 'a' }, { termId: '2' }); assert.equal(f.selected.length, 2);
});

test('unknown school term is rejected before course lookup; past course details use all owned terms only', async () => {
  const f = fixture();
  await assert.rejects(f.reader.catalog('a', { termId: '999' }), { code: 'NOT_FOUND' });
  assert.deepEqual(f.selected, []);
  const past = await f.reader.readCourse('a', '900000011');
  assert.equal(past.course.termId, '1'); assert.equal(past.course.ended, true);
  assert.deepEqual(f.selected[0]?.ids, ['1', '2', '3']);
  await assert.rejects(f.reader.readCourse('b', '900000011'), { code: 'NOT_FOUND' });
  assert.equal(f.counts().modules, 1);
});

test('a current course reuses the known dashboard catalog without an extra all-term school read', async () => {
  const f = fixture();
  await f.reader.catalog('a');
  await f.reader.readCourse('a', '900000013');
  assert.deepEqual(f.selected.map(value => value.ids), [['3']]);
  assert.equal(f.counts().termsReads, 1); assert.equal(f.counts().modules, 1);
});

test('a selected past term catalog is reused for its owned detail and invalidated by a fresh login', async () => {
  const f = fixture();
  await f.reader.catalog('a', { termId: '1' });
  await f.reader.readCourse('a', '900000011');
  assert.deepEqual(f.selected.map(value => value.ids), [['1']]);
  f.replace('a');
  await f.reader.readCourse('a', '900000011');
  assert.deepEqual(f.selected.map(value => value.ids), [['1'], ['1', '2', '3']]);
});

test('long enrolled histories above 100 courses still authorize only the school returned owner catalog', async () => {
  const f = fixture(); let requested: string[] = [];
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({}), client: {
    terms: async () => Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), name: `합성 학기 ${index}`, default: index === 29 })),
    courses: async (ids: string[]) => { requested = ids; return ids.flatMap(id => Array.from({ length: 100 }, (_, index) => ({
      id: String(Number(id) * 1000 + index), name: '합성 강좌', termId: id, professors: null, ended: true,
    }))); }, modules: async () => [],
  } as unknown as LearningxClient }));
  assert.equal((await reader.readCourse('a', '1000')).course.id, '1000');
  assert.equal(requested.length, 30);
  await assert.rejects(reader.readCourse('a', '999999'), { code: 'NOT_FOUND' });
});

test('deployment discards old cached catalogs and course DTOs that lack term authority and lesson dates', async () => {
  const f = fixture(); let courseReads = 0, moduleReads = 0;
  const oldCourse = { id: '10', title: '합성 강좌', professor: null, term: '합성 학기', sourceUrl: null };
  const values = new Map<string, unknown>([['catalog', { courses: [oldCourse], term: oldCourse.term, termIds: ['1'] }],
    ['course:10', { course: oldCourse, modules: [], observedAt: '2026-10-01T00:00:00Z' }]]);
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({}), client: {
    terms: async () => [{ id: '1', name: '2026년 2학기', default: true }],
    courses: async () => { courseReads++; return [{ id: '10', name: '합성 강좌', termId: '1', professors: null, ended: false }]; },
    modules: async () => { moduleReads++; return []; }, lessons: async () => [],
  } as unknown as LearningxClient }), undefined, {
    get: async scope => values.has(scope.resource) ? { value: values.get(scope.resource) as any, expiresAt: Date.now() + 60_000 } : null,
    put: async (scope, value) => { values.set(scope.resource, value); return true; },
    delete: async () => {},
  });
  const value = await reader.readCourse('a', '10');
  assert.equal(value.course.schoolDefaultTerm, true); assert.equal(value.course.ended, false);
  assert.deepEqual(value.lessons, []);
  assert.deepEqual([courseReads, moduleReads], [1, 1]);
  await reader.readCourse('a', '10'); assert.deepEqual([courseReads, moduleReads], [1, 1]);
});

test('deployment discards an old activity nested course before advertising attendance report support', async () => {
  const f = fixture(); let reads = 0;
  const oldCourse = { id: '10', title: '합성 강좌', professor: null, term: '합성 학기', sourceUrl: null };
  const detail = { courseId: '10', moduleItemId: '20', resourceType: 'movie', published: true, opened: true, useAttendance: true,
    attendance: { completed: true, status: 'none' }, unlockAt: null, dueAt: null, lateAt: null, lockAt: null } as SchoolActivityDetail;
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({}), client: {
    terms: async () => [{ id: '1', name: '2026년 2학기', default: true }],
    courses: async () => [{ id: '10', name: '합성 강좌', termId: '1', professors: null, ended: true }],
    moduleActivityDetail: async () => { reads++; return detail; },
  } as unknown as LearningxClient }), undefined, {
    get: async scope => scope.resource === 'activity:10:20' ? { value: { course: oldCourse, detail,
      observedAt: '2026-10-01T00:00:00Z' } as any, expiresAt: Date.now() + 30_000 } : null,
    put: async () => true, delete: async () => {},
  });
  const value = await createLearningxReads(reader).activity!({ userId: 'a' }, '10', '20') as any;
  assert.equal(reads, 1); assert.equal(value.manualVideoAvailable, true);
  assert.equal(value.manualVideoReportAvailable, false);
});

test('school authentication failure has a distinct code and does not trigger a second LMS bootstrap', async () => {
  for (const code of ['authentication_required', 'identity_mismatch'] as const) {
    assert.throws(() => normalizeSchoolReadError(new SchoolError(code)), { statusCode: 401, code: 'SCHOOL_AUTH_REQUIRED' });
  }
  let catalogs = 0;
  await assert.rejects(readLmsDashboard({ catalog: async () => { catalogs++; throw new Error('must not retry'); },
    readTasks: async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'synthetic'); } }, 'a'), { code: 'SCHOOL_AUTH_REQUIRED' });
  assert.equal(catalogs, 0);
});

test('overview returns timetable/catalog without starting blocked TODO or current course reads', { timeout: 1000 }, async () => {
  const course = { id: '10', title: '합성 강좌', professor: '합성 교수', term: '2026년 2학기', sourceUrl: null };
  let todo = 0, modules = 0;
  const never = new Promise<never>(() => {});
  const dashboard = createCombinedDashboard({ timetable: async () => ({ term: '2026년 2학기', entries: [{ id: 'slot',
    courseId: '10', courseTitle: '합성 강좌', dayOfWeek: 3, startTime: '13:00', endTime: '14:00', room: null, professor: '합성 교수' }] }) }, {
    catalog: async () => ({ courses: [course], term: '2026년 2학기', termIds: ['3'] }),
    readTasks: async () => { todo++; return never; }, readCourse: async () => { modules++; return never; },
  }, () => new Date('2026-10-07T04:30:00Z'));
  const value = await dashboard.dashboard!({ userId: 'a' }, { detail: 'overview' }) as any;
  assert.equal(value.detail, 'overview'); assert.equal(value.currentCourse.id, '10');
  assert.equal(value.availability.timetable, 'available'); assert.equal(value.availability.courses, 'available');
  assert.equal(value.availability.tasks, 'unavailable'); assert.deepEqual(value.upcomingTasks, []);
  assert.deepEqual([todo, modules], [0, 0]);
});

test('dashboard exposes every current-week raw item and schedule times without additional reads or changing the legacy three-item view', async () => {
  let catalogReads = 0, moduleReads = 0;
  const course = { id: '10', title: '합성 강좌', professor: '합성 교수', term: '2026년 2학기', sourceUrl: null };
  const now = () => new Date('2026-10-07T04:30:00Z');
  const dashboard = createCombinedDashboard({ timetable: async () => ({ term: course.term, entries: [{ id: 'slot',
    courseId: '10', courseTitle: course.title, dayOfWeek: 3, startTime: '13:00', endTime: '14:00', room: null, professor: course.professor }] }) }, {
    catalog: async () => { catalogReads++; return { courses: [course], term: course.term, termIds: ['3'] }; },
    readCourse: async () => { moduleReads++; return { course, observedAt: now().toISOString(),
      lessons: [{ week: 4, lessons: [{ lesson: 1, classDate: '2026-10-07', displayClassDate: null,
        classStartTime: '13:00', makeupDate: null, makeupStartTime: null }] }],
      modules: [{ id: '40', title: '4주차', week: 4, items: Array.from({ length: 7 }, (_, index) => ({ id: String(30 + index),
        title: `합성 자료 ${index}`, contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'pdf',
        sourceUrl: null, activityDetailAvailable: true, published: index < 4 ? true : index === 6 ? null : false,
        completed: index === 0 ? true : index === 1 ? false : null,
        dueAt: null, unlockAt: index === 5 ? '2026-10-08T00:00:00Z' : index === 6 ? null : '2026-10-01T00:00:00Z' })) }] }; },
  }, now);
  const result = await dashboard.dashboard!({ userId: 'a' }) as any;
  assert.equal(result.currentActivities.length, 3); assert.equal(result.currentActivityItems.length, 7);
  assert.deepEqual([catalogReads, moduleReads], [1, 1]);
  assert.deepEqual([result.currentCourse.scheduleStartTime, result.currentCourse.scheduleEndTime, result.currentCourse.timeZone], ['13:00', '14:00', 'Asia/Seoul']);
  assert.equal(result.currentActivityItems[0].weekId, '40'); assert.equal(result.currentActivityItems[0].status.completion, 'completed');
  assert.equal(result.currentActivityItems[0].resourceType, 'pdf');
  assert.equal(result.currentActivityItems[1].status.completion, 'incomplete'); assert.equal(result.currentActivityItems[2].status.completion, 'unknown');
  assert.equal(result.currentActivityItems[4].status.publication, 'unpublished'); assert.equal(result.currentActivityItems[5].status.unlock, 'scheduled');
  assert.equal(result.currentActivityItems[6].status.publication, 'unknown'); assert.equal(result.currentActivityItems[6].status.unlock, 'unknown');
  assert.equal(result.currentActivityItems[0].status.unlock, 'elapsed'); assert.equal(Object.hasOwn(result.currentActivityItems[0].status, 'opened'), false);
  assert.equal(result.featureSupport.current_activities.availability, 'available');
  await dashboard.dashboard!({ userId: 'a' }, { detail: 'overview' }); assert.deepEqual([catalogReads, moduleReads], [2, 1]);
});

test('partial dashboard explains expired school authentication while preserving verified timetable', async () => {
  const dashboard = createCombinedDashboard({ timetable: async () => ({ term: '2026년 2학기', entries: [] }) }, {
    catalog: async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'private school response'); },
  });
  const value = await dashboard.dashboard!({ userId: 'a' }, { detail: 'overview' }) as any;
  assert.equal(value.sourceErrors.courses, 'SCHOOL_AUTH_REQUIRED');
  assert.equal(value.availability.timetable, 'available');
  assert.doesNotMatch(JSON.stringify(value), /private school response/);
});

test('partial dashboard preserves school courses when the independent Saint authentication expires', async () => {
  const dashboard = createCombinedDashboard({ timetable: async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'synthetic'); } }, {
    catalog: async () => ({ courses: [], term: '합성 학기', termIds: ['1'] }),
  });
  const value = await dashboard.dashboard!({ userId: 'a' }, { detail: 'overview' }) as any;
  assert.equal(value.sourceErrors.timetable, 'SCHOOL_AUTH_REQUIRED');
  assert.equal(value.availability.courses, 'available');
  assert.equal(value.sourceErrors.courses, null);
});

test('when both dashboard sources fail a confirmed school authentication error keeps the login recovery path', async () => {
  for (const saintAuth of [true, false]) {
    const auth = new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'private school response');
    const unavailable = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'synthetic outage');
    const dashboard = createCombinedDashboard({ timetable: async () => { throw saintAuth ? auth : unavailable; } }, {
      catalog: async () => { throw saintAuth ? unavailable : auth; },
    });
    await assert.rejects(dashboard.dashboard!({ userId: 'a' }, { detail: 'overview' }), error => error instanceof AppError
      && error.code === 'SCHOOL_AUTH_REQUIRED' && !error.message.includes('private school response'));
  }
});

test('history and overview routes bind the authenticated owner and reject arbitrary/duplicate query fields', async () => {
  const calls: unknown[] = [], headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
  const store = { getSession: async () => ({ user: { id: 'authenticated-owner' } }) } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider, courses: async (context, options) => { calls.push({ context, options }); return { items: [] }; },
    courseTerms: async context => { calls.push(context); return { items: [] }; },
    dashboard: async (context, options) => { calls.push({ context, options }); return { detail: options?.detail }; },
  });
  try {
    assert.equal((await app.inject('/v1/course-terms')).statusCode, 401);
    for (const url of ['/v1/courses?termId=2&userId=other', '/v1/courses?termId=2&termId=3',
      '/v1/courses?termId=..%2F2', '/v1/course-terms?userId=other', '/v1/dashboard?detail=all', '/v1/dashboard?detail=overview&userId=other']) {
      assert.equal((await app.inject({ url, headers })).statusCode, 400);
    }
    assert.deepEqual(calls, []);
    assert.equal((await app.inject({ url: '/v1/courses?termId=2', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/v1/course-terms', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/v1/dashboard?detail=overview', headers })).statusCode, 200);
    assert.deepEqual(calls, [{ context: { userId: 'authenticated-owner' }, options: { termId: '2' } },
      { userId: 'authenticated-owner' }, { context: { userId: 'authenticated-owner' }, options: { detail: 'overview' } }]);
  } finally { await app.close(); }
});

test('assignment options distinguish a missing/corrupt school session from browser authorization', async () => {
  for (const raw of [null, 'synthetic-corrupt-ciphertext']) {
    const school = createAssignmentSubmissionSchool({ getEncryptedSchoolSession: async () => raw } as unknown as PgStore,
      randomBytes(32), async () => {});
    await assert.rejects(school.options('a', '10', '20', async () => {}, AbortSignal.timeout(1000)), { code: 'SCHOOL_AUTH_REQUIRED' });
  }
});

test('manual preparation separates SDK school expiry from ALMS validation failure', async () => {
  const school = { prepare: async () => { throw new SchoolError('authentication_required'); } } as unknown as ManualVideoSchool;
  const service = new ManualVideoService({} as PlaybackLeaseRepository, school);
  const context = { owner: 'a', sessionHash: 'a'.repeat(64), courseId: '10', moduleItemId: '20' };
  try {
    await assert.rejects(service.start(context, async () => {}, AbortSignal.timeout(1000)), { code: 'SCHOOL_AUTH_REQUIRED' });
    await assert.rejects(service.start(context, async () => { throw new AppError(401, 'AUTH_REQUIRED', 'synthetic logout'); },
      AbortSignal.timeout(1000)), { code: 'AUTH_REQUIRED' });
  } finally { await service.close(); }
});

test('an opened old-term video remains readable while attendance-report preparation is explicitly unavailable', async () => {
  const course = { id: '10', title: '합성 이전 강좌', professor: null, term: '2025년 2학기', sourceUrl: null,
    schoolDefaultTerm: false, ended: true };
  const detail = { courseId: '10', moduleItemId: '20', resourceType: 'movie', published: true, opened: true, useAttendance: true,
    attendance: { completed: true, status: 'none' }, unlockAt: null, dueAt: null, lateAt: null, lockAt: null } as SchoolActivityDetail;
  const reader = { readActivity: async () => ({ course, detail, observedAt: '2026-10-07T06:00:00Z' }),
    readVideo: async () => { throw new Error('metadata projection must not read bytes'); } } as unknown as LearningxReader;
  const value = await createLearningxReads(reader).activity!({ userId: 'a' }, '10', '20') as any;
  assert.equal(value.manualVideoAvailable, true);
  assert.equal(value.manualVideoReportAvailable, false);
  assert.equal(value.manualVideoProgressMode, 'untracked');
});

test('history read ownership cannot expand a school PDF progress write beyond the existing default term', async () => {
  const f = fixture(); let reports = 0;
  const detail = { courseId: '11', moduleItemId: '20', itemContentType: 'commons', resourceType: 'pdf',
    published: true, opened: true, omitProgress: false, materialViewerUrl: 'https://commons.ssu.ac.kr/em/synthetic',
    attendance: { completed: false, status: 'none' }, unlockAt: null, dueAt: null, lateAt: null, lockAt: null } as SchoolActivityDetail;
  const selected: string[][] = [];
  const reader = createLearningxReader(f.store, f.key, async () => ({ serialize: async () => ({}), client: {
    terms: async () => [{ id: '1', name: '2025년 2학기', default: false }, { id: '2', name: '2026년 2학기', default: true }],
    courses: async (ids: string[]) => { selected.push(ids); return ids.map(id => ({ id: id === '1' ? '11' : '12',
      name: '합성 강좌', termId: id, professors: null, ended: id === '1' })); },
    moduleActivityDetail: async () => detail,
  } as unknown as LearningxClient }), async () => Buffer.from('%PDF synthetic'), undefined, undefined,
    async () => { reports++; throw new Error('history must not report'); });
  const value = await createLearningxReads(reader).activity!({ userId: 'a' }, '11', '20') as any;
  assert.equal(value.materialContentAvailable, true); assert.equal(value.materialViewAvailable, false);
  await assert.rejects(reader.recordMaterialView!('a', '11', '20', { event: 'opened', page: 1, totalPages: 1, viewedPages: [1] },
    async () => {}), { code: 'NOT_FOUND' });
  assert.equal(reports, 0); assert.deepEqual(selected, [['1', '2'], ['2']]);
});
