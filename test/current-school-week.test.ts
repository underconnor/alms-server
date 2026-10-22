import test from 'node:test';
import assert from 'node:assert/strict';
import type { SchoolLessonWeek, SchoolModule } from '@alms/ssu-api';
import { currentSchoolWeek } from '../src/current-school-week.js';
import { publicCourseContent } from '../src/school-read.js';
import { createCombinedDashboard } from '../src/school-dashboard.js';

const observedAt = '2026-10-07T06:55:27Z';
const course = { id: '10', title: '합성 강좌', professor: '합성 교수', term: '2026년 2학기', sourceUrl: null };
const lesson = (classDate: string | null, makeupDate: string | null = null) => ({ classDate, makeupDate,
  lesson: 1, displayClassDate: null, classStartTime: null, makeupStartTime: null });
const dates = (week: number, classDate: string | null, makeupDate: string | null = null): SchoolLessonWeek => ({ week, lessons: [lesson(classDate, makeupDate)] });
const modules = [5, 6].map(week => ({ id: String(week), title: `${week}주차`, week, items: [{ id: String(week * 10),
  title: '이미 읽은 합성 자료', contentType: 'attendance_item', itemContentType: 'commons', resourceType: 'pdf',
  completed: true, published: true, unlockAt: '2026-09-01T00:00:00+09:00', activityDetailAvailable: true }] })) as SchoolModule[];

test('current school week changes at Seoul Monday midnight and includes the preceding Sunday only before that boundary', () => {
  const lessons = [dates(5, '2026-10-04'), dates(6, '2026-10-05'), dates(7, '2026-10-12')];
  assert.deepEqual(currentSchoolWeek(lessons, observedAt, new Date('2026-10-04T14:59:59Z')).numbers, [5]);
  assert.deepEqual(currentSchoolWeek(lessons, observedAt, new Date('2026-10-04T15:00:00Z')).numbers, [6]);
  assert.deepEqual(currentSchoolWeek(lessons, observedAt, new Date('2026-10-11T14:59:59Z')).numbers, [6]);
  assert.deepEqual(currentSchoolWeek(lessons, observedAt, new Date('2026-10-11T15:00:00Z')).numbers, [7]);
});

test('makeup dates replace the original lesson date and exact distinct school weeks can coexist', () => {
  const value = currentSchoolWeek([dates(4, '2026-10-07', '2026-10-15'), dates(5, '2026-09-30', '2026-10-07'),
    dates(6, '2026-10-09'), dates(6, '2026-10-10')], observedAt, new Date('2026-10-07T06:00:00Z'));
  assert.deepEqual(value, { source: 'school_lesson_dates', numbers: [5, 6], observedAt });
});

test('absent and invalid school dates remain unknown; verified dates outside this week remain a known empty current week', () => {
  for (const rows of [null, [], [dates(1, '2026-02-30')], [dates(1, '2026-10-07T00:00:00Z')], [dates(0, '2026-10-07')]]) {
    assert.deepEqual(currentSchoolWeek(rows, observedAt, new Date('2026-10-07T06:00:00Z')),
      { source: 'unavailable', numbers: [], observedAt });
  }
  assert.equal(currentSchoolWeek([dates(1, '2026-09-01')], observedAt, new Date('2026-10-07T06:00:00Z')).source, 'school_lesson_dates');
  assert.deepEqual(currentSchoolWeek([dates(1, '2026-09-01')], observedAt, new Date('2026-10-07T06:00:00Z')).numbers, []);
});

test('exact current module projection keeps completed materials and does not mark another week current', () => {
  const value = publicCourseContent({ course, modules, lessons: [dates(6, '2026-10-07')], observedAt }, true, true,
    new Date('2026-10-07T06:00:00Z').getTime());
  assert.deepEqual(value.weeks.map(week => week.isCurrent), [false, true]);
  assert.equal(value.weeks[1]!.activities[0]!.moduleCompleted, true);
  assert.equal(value.materials.length, 2);
  assert.equal(value.currentWeek.source, 'school_lesson_dates');
});

test('full dashboard uses real current dates and still exposes already read current-week materials', async () => {
  const now = () => new Date('2026-10-07T04:30:00Z');
  const dashboard = createCombinedDashboard({ timetable: async () => ({ term: course.term, entries: [{ id: 'slot', courseId: course.id,
    courseTitle: course.title, dayOfWeek: 3, startTime: '13:00', endTime: '14:00', room: null, professor: course.professor }] }) }, {
    catalog: async () => ({ courses: [course], term: course.term, termIds: ['1'] }),
    readCourse: async () => ({ course, modules, lessons: [dates(6, '2026-10-07')], observedAt }),
  }, now);
  const value = await dashboard.dashboard!({ userId: 'a' }) as any;
  assert.equal(value.availability.currentActivities, 'available');
  assert.deepEqual(value.currentActivities.map((activity: any) => activity.id), ['60']);
  assert.equal(value.currentActivities[0].moduleCompleted, true);
});

test('ended and non-default-term courses do not advertise automatic playback admission', () => {
  const videoModules = [{ ...modules[0]!, items: [{ ...modules[0]!.items[0]!, resourceType: 'movie' }] }];
  for (const boundary of [{ ended: true }, { schoolDefaultTerm: false }]) {
    const value = publicCourseContent({ course: { ...course, ...boundary }, modules: videoModules }, true, true);
    assert.equal(value.weeks[0]!.activities[0]!.playbackAvailable, false);
  }
});
