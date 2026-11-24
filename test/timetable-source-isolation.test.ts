import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';
import { createCombinedDashboard } from '../src/school-dashboard.js';
import type { Catalog } from '../src/school-read.js';
import type { Schedule } from '../src/saint-reader.js';

const term = '2026년 2학기';
const slot: Schedule = { id: 'fake', courseId: null, courseTitle: '합성 과목', dayOfWeek: 2, startTime: '13:30', endTime: '14:30', room: null, professor: '합성 교수' };
const schedule = { term, entries: [slot] };
const catalog: Catalog = { term, termIds: ['1'], courses: [{ id: '42', title: slot.courseTitle, professor: slot.professor, term, sourceUrl: null }] };
const context = { userId: 'test-owner' };
const now = () => new Date('2026-11-24T04:45:00Z');
const waits = { optionalCatalogMs: 5, overviewSourceMs: 5 };

test('standalone timetable returns school slots without waiting for LMS mapping; a quick catalog still enriches them', { timeout: 1000 }, async () => {
  const saint = { timetable: async () => schedule };
  const slow = createCombinedDashboard(saint, { catalog: () => new Promise(() => {}) }, now, waits);
  const quick = createCombinedDashboard(saint, { catalog: async () => catalog }, now, waits);
  const unmapped = await slow.timetable!(context) as { items: Schedule[]; term: string };
  assert.equal(unmapped.term, term);
  assert.equal(unmapped.items[0]?.startTime, slot.startTime);
  assert.equal(unmapped.items[0]?.courseId, null);
  const matched = await quick.timetable!(context) as { items: Schedule[] };
  assert.equal(matched.items[0]?.courseId, '42');
});

test('standalone timetable does not start a catalog refresh when Saint fails or confirms it is empty', async () => {
  let catalogCalls = 0;
  const lms = { catalog: async () => { catalogCalls++; return catalog; } };
  const denied = new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'synthetic');
  const failed = createCombinedDashboard({ timetable: async () => { throw denied; } }, lms, now, waits);
  await assert.rejects(failed.timetable!(context), error => error === denied);
  const empty = createCombinedDashboard({ timetable: async () => ({ term, entries: [] }) }, lms, now, waits);
  assert.deepEqual(await empty.timetable!(context), { term, items: [] });
  assert.equal(catalogCalls, 0);
});

test('dashboard overview preserves each usable source when only the other is late', { timeout: 1000 }, async () => {
  const slowSaint = Promise.withResolvers<typeof schedule>();
  const slowLms = Promise.withResolvers<Catalog>();
  const timetableFirst = createCombinedDashboard({ timetable: async () => schedule }, { catalog: () => slowLms.promise }, now, waits);
  const coursesFirst = createCombinedDashboard({ timetable: () => slowSaint.promise }, { catalog: async () => catalog }, now, waits);
  const [tt, courses] = await Promise.all([timetableFirst.dashboard!(context, { detail: 'overview' }), coursesFirst.dashboard!(context, { detail: 'overview' })]) as any[];
  assert.equal(tt.availability.timetable, 'available');
  assert.equal(tt.sourceErrors.timetable, null);
  assert.equal(tt.sourceErrors.courses, 'SCHOOL_UPSTREAM_UNAVAILABLE');
  assert.equal(tt.currentSchedule.id, slot.id);
  assert.equal(tt.currentCourse, null);
  assert.equal(courses.availability.courses, 'available');
  assert.equal(courses.sourceErrors.courses, null);
  assert.equal(courses.availability.timetable, 'unavailable');
  assert.equal(courses.sourceErrors.timetable, 'SCHOOL_UPSTREAM_UNAVAILABLE');
  assert.deepEqual(courses.timetable, []);
  slowLms.reject(new Error('late synthetic rejection'));
  slowSaint.resolve(schedule);
});

test('a confirmed school authentication error is preserved if both overview sources fail', async () => {
  const provider = createCombinedDashboard({ timetable: async () => { throw new Error('synthetic network failure'); } },
    { catalog: async () => { throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'synthetic'); } }, now, waits);
  await assert.rejects(provider.dashboard!(context, { detail: 'overview' }), { statusCode: 401, code: 'SCHOOL_AUTH_REQUIRED' });
});
