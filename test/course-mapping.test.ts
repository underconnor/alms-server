import test from 'node:test';
import assert from 'node:assert/strict';
import { mapScheduleCourses, courseTerm } from '../src/course-mapping.js';

const term = '2026년 2학기';
const slot = { id: 'period-1', courseId: null, courseTitle: '합성 프로그래밍 2', professor: '합성 교수', dayOfWeek: 2, startTime: '09:00', endTime: '09:50', room: '합성 강의실' };
const course = { id: 'course-1', title: slot.courseTitle, professor: slot.professor, term: '2026학년도 2학기', sourceUrl: null };

test('a unique same-term title and professor match links every period without changing the source entries', () => {
  const next = { ...slot, id: 'period-2', startTime: '10:00', endTime: '10:50', room: null };
  const result = mapScheduleCourses([slot, next], [course], term);
  assert.deepEqual(result.map(row => row.courseId), ['course-1', 'course-1']);
  assert.deepEqual(result[0]!.courseMapping, { status: 'matched', method: 'title_professor', candidateCourseIds: ['course-1'] });
  assert.equal(result[1]!.room, null); assert.equal(slot.courseId, null); assert.equal('courseMapping' in slot, false);
});

test('matching handles normalized whitespace and Unicode but does not remove meaningful title differences', () => {
  assert.equal(mapScheduleCourses([{ ...slot, courseTitle: '  합성 프로그래밍   ２ ', professor: ' 합성 교수 ' }], [course], term)[0]!.courseId, 'course-1');
  for (const title of ['합성 프로그래밍 1', '합성프로그래밍2', '합성 프로그래밍 2 (다른 분반)']) {
    assert.equal(mapScheduleCourses([{ ...slot, courseTitle: title }], [course], term)[0]!.courseId, null);
  }
});

test('duplicate title/professor sections stay ambiguous instead of choosing the first course', () => {
  const other = { ...course, id: 'course-2' };
  for (const catalog of [[course, other], [other, course]]) {
    const result = mapScheduleCourses([slot], catalog, term)[0]!;
    assert.equal(result.courseId, null);
    assert.deepEqual(result.courseMapping, { status: 'ambiguous', method: null, candidateCourseIds: ['course-1', 'course-2'] });
  }
});

test('an exact professor disambiguates a same-title course but missing or different professors never auto-link', () => {
  const other = { ...course, id: 'course-2', professor: '다른 교수' };
  assert.equal(mapScheduleCourses([slot], [other, course], term)[0]!.courseId, 'course-1');
  for (const professor of [null, '', '다른 교수']) {
    const result = mapScheduleCourses([{ ...slot, professor }], [course], term)[0]!;
    assert.equal(result.courseId, null); assert.deepEqual(result.courseMapping.candidateCourseIds, ['course-1']);
  }
});

test('prior terms and unknown term labels cannot provide automatic course identity', () => {
  for (const selected of [null, '', '지난 학기', '2026년 1학기']) assert.equal(mapScheduleCourses([slot], [course], selected)[0]!.courseId, null);
  assert.equal(mapScheduleCourses([slot], [{ ...course, term: '2025년 2학기' }], term)[0]!.courseId, null);
  assert.equal(courseTerm('2026 학년도 여름학기'), '2026:여름학기');
  assert.equal(courseTerm('2026년 3학기'), null);
});

test('verified course code and section take priority and an explicit mismatch does not fall back to a similar title', () => {
  const codedSlot = { ...slot, courseCode: 'ABC123', section: '02' };
  const one = { ...course, courseCode: 'ABC123', section: '01' };
  const two = { ...course, id: 'course-2', title: '다른 표시 제목', courseCode: 'ABC123', section: '02' };
  const mapped = mapScheduleCourses([codedSlot], [one, two], term)[0]!;
  assert.equal(mapped.courseId, 'course-2'); assert.equal(mapped.courseMapping.method, 'code_section');
  assert.equal(mapScheduleCourses([codedSlot], [one], term)[0]!.courseId, null);
});

test('absent catalog and untrusted existing links remain internal-selection cases', () => {
  const result = mapScheduleCourses([{ ...slot, courseId: 'unowned-course' }], [], term)[0]!;
  assert.equal(result.courseId, null);
  assert.deepEqual(result.courseMapping, { status: 'unmatched', method: null, candidateCourseIds: [] });
});

test('an observed ten-digit LMS registration suffix is display decoration, never a section identity', () => {
  const decorated = { ...course, title: `${course.title} (2150103438)` };
  assert.equal(mapScheduleCourses([slot], [decorated], term)[0]!.courseId, 'course-1');
  assert.equal(mapScheduleCourses([slot], [decorated, { ...decorated, id: 'course-2', title: `${course.title} (2150103439)` }], term)[0]!.courseMapping.status, 'ambiguous');
  for (const title of [`${course.title} (2026)`, `${course.title} (A분반)`]) assert.equal(mapScheduleCourses([slot], [{ ...course, title }], term)[0]!.courseId, null);
});

test('one same-term title can link a complete professor item in the LMS comma list', () => {
  for (const professor of ['합성 교수, 합성 운영팀', '합성 운영팀, 합성 교수', '  합성   교수  ,  합성 운영팀  ']) {
    const listed = { ...course, title: `${course.title} (2150103438)`, professor };
    const result = mapScheduleCourses([{ ...slot, professor: '  합성   교수 ' }], [listed], term)[0]!;
    assert.equal(result.courseId, course.id);
    assert.deepEqual(result.courseMapping, { status: 'matched', method: 'title_professor', candidateCourseIds: [course.id] });
    assert.equal(listed.professor, professor); assert.equal(slot.courseId, null);
  }
});

test('professor list membership rejects incomplete names, empty items and unobserved delimiters', () => {
  for (const professor of [
    '다른 합성 교수, 합성 운영팀', '합성 교수님, 합성 운영팀', '합성 교수 외 1명',
    '합성 교수,', ',합성 교수', '합성 교수,,합성 운영팀', '합성 교수, 합성 교수',
    '합성 교수; 합성 운영팀', '합성 교수 / 합성 운영팀', '합성 교수 | 합성 운영팀',
    '합성 교수 · 합성 운영팀', '합성 교수、합성 운영팀', '합성 교수，합성 운영팀',
    '합성 교수\n합성 운영팀', '합성 교수, 합성 운영팀 / 다른 교수', '합성 교수, (합성 운영팀)',
  ]) {
    assert.equal(mapScheduleCourses([slot], [{ ...course, professor }], term)[0]!.courseId, null, professor);
  }
  const listed = { ...course, professor: '합성 교수, 합성 운영팀' };
  for (const delimiter of [';', '/', '|', '\u00b7', '\u3001', '\uff0c', '\n', '&', '+', '\\']) {
    const professor = `합성 교수, 합성 운영팀${delimiter}다른 교수`;
    assert.equal(mapScheduleCourses([slot], [{ ...course, professor }], term)[0]!.courseId, null, professor);
  }
  for (const professor of [null, '', '교수', '합성', '합성 교수, 다른 교수']) {
    assert.equal(mapScheduleCourses([{ ...slot, professor }], [listed], term)[0]!.courseId, null, String(professor));
  }
});

test('NFKC comma forms cannot turn multiple professors into one list member', () => {
  for (const delimiter of ['\ufe50', '\ufe10', '\uff0c']) {
    assert.equal(delimiter.normalize('NFKC'), ',');
    const professor = `합성 교수${delimiter} 다른 교수`;
    const combined = { ...course, professor: `${professor}, 합성 운영팀` };
    assert.equal(mapScheduleCourses([{ ...slot, professor }], [combined], term)[0]!.courseId, null);
    const mixed = { ...course, professor: `합성 교수, 합성 운영팀${delimiter} 다른 운영팀` };
    assert.equal(mapScheduleCourses([slot], [mixed], term)[0]!.courseId, null);
  }
});

test('professor list membership cannot resolve multiple same-title sections or override strict matches', () => {
  const listed = { ...course, professor: '합성 교수, 합성 운영팀' };
  const other = { ...listed, id: 'course-2', professor: '다른 교수' };
  for (const catalog of [[listed, other], [other, listed]]) {
    const result = mapScheduleCourses([slot], catalog, term)[0]!;
    assert.equal(result.courseId, null);
    assert.deepEqual(result.courseMapping, { status: 'ambiguous', method: null, candidateCourseIds: ['course-1', 'course-2'] });
  }
  for (const catalog of [[course, { ...listed, id: 'course-2' }], [{ ...listed, id: 'course-2' }, course]]) {
    assert.equal(mapScheduleCourses([slot], catalog, term)[0]!.courseId, course.id);
  }
  const duplicated = mapScheduleCourses([slot], [course, { ...course, id: 'course-2' }, { ...listed, id: 'course-3' }], term)[0]!;
  assert.equal(duplicated.courseId, null); assert.equal(duplicated.courseMapping.status, 'ambiguous');
});

test('professor list membership retains the exact title, selected term and code/section boundaries', () => {
  const listed = { ...course, professor: '합성 교수, 합성 운영팀' };
  for (const selected of [null, '', '학기 미확인', '2026년 1학기']) {
    assert.equal(mapScheduleCourses([slot], [listed], selected)[0]!.courseId, null);
  }
  for (const candidate of [
    { ...listed, term: null }, { ...listed, term: '2025년 2학기' }, { ...listed, title: '합성 프로그래밍 1' },
    { ...listed, title: '합성프로그래밍2' }, { ...listed, title: `${course.title} (다른 분반)` },
  ]) assert.equal(mapScheduleCourses([slot], [candidate], term)[0]!.courseId, null);
  const codedSlot = { ...slot, courseCode: 'ABC123', section: '02' };
  const mismatch = { ...listed, courseCode: 'ABC123', section: '01' };
  assert.equal(mapScheduleCourses([codedSlot], [mismatch], term)[0]!.courseId, null);
  const exactCode = { ...course, id: 'course-2', title: '다른 표시 제목', courseCode: 'ABC123', section: '02' };
  const result = mapScheduleCourses([codedSlot], [mismatch, exactCode], term)[0]!;
  assert.equal(result.courseId, exactCode.id); assert.equal(result.courseMapping.method, 'code_section');
  assert.equal(mapScheduleCourses([{ ...slot, courseId: 'unowned-course' }], [], term)[0]!.courseId, null);
});

import { createCombinedDashboard } from '../src/school-dashboard.js';

test('combined dashboard links the current period to an owned course and includes completed published current-week activities', async () => {
  const current = { ...slot, dayOfWeek: 4, startTime: '13:00', endTime: '14:00' };
  const catalog = { courses: [course], term, termIds: ['term'] };
  const calls: string[] = [];
  const item = (id: string, overrides = {}) => ({ id, title: id, contentType: 'attendance_item', type: 'commons', subtype: 'pdf', activityDetailAvailable: true, published: true, completed: false, ...overrides });
  const provider = createCombinedDashboard({ timetable: async owner => { assert.equal(owner, 'owner'); return { term, entries: [current] }; } }, {
    catalog: async owner => { assert.equal(owner, 'owner'); return catalog; },
    readCourse: async (owner, id) => { calls.push(`${owner}:${id}`); return { course, observedAt: '2026-10-01T04:30:00Z',
      lessons: [{ week: 1, lessons: [{ classDate: '2026-10-01', makeupDate: null }] }], modules: [{ id: 'week', week: 1, title: 'week', items: [
      item('public'), item('hidden', { published: false }), item('unknown', { published: null }), item('done', { completed: true }), item('locked', { unlockAt: '2099-01-01T00:00:00Z' }), item('due', { dueAt: '2026-10-02T00:00:00Z' }),
    ] }] } as any; },
  }, () => new Date('2026-10-01T04:30:00Z'));
  const result = await provider.dashboard!({ userId: 'owner' }) as any;
  assert.equal(result.currentCourse.id, course.id); assert.equal(result.currentCourse.room, current.room);
  assert.equal(result.currentCourse.scheduleLabel, '13:00–14:00');
  assert.deepEqual(calls, ['owner:course-1']); assert.deepEqual(result.currentActivities.map((item: any) => item.id), ['due', 'public', 'done']);
  assert.equal(result.availability.currentActivities, 'available');
  const schedule = await provider.timetable!({ userId: 'owner' }) as any;
  assert.equal(schedule.items[0].courseId, course.id);
});

test('combined dashboard and timetable share the same unique co-teaching match', async () => {
  const current = { ...slot, dayOfWeek: 4, startTime: '13:00', endTime: '14:00' };
  const listed = { ...course, title: `${course.title} (2150103438)`, professor: '합성 교수, 합성 운영팀' };
  const calls: string[] = [];
  const provider = createCombinedDashboard({ timetable: async owner => { assert.equal(owner, 'owner'); return { term, entries: [current] }; } }, {
    catalog: async owner => { assert.equal(owner, 'owner'); return { courses: [listed], term, termIds: ['term'] }; },
    readCourse: async (owner, id) => { calls.push(`${owner}:${id}`); return { course: listed, observedAt: '2026-10-01T04:30:00Z',
      lessons: [], modules: [] }; },
  }, () => new Date('2026-10-01T04:30:00Z'));
  const result = await provider.dashboard!({ userId: 'owner' }) as any;
  assert.equal(result.currentCourse.id, course.id);
  assert.equal(result.currentSchedule.courseId, course.id);
  assert.deepEqual(calls, ['owner:course-1']);
  const schedule = await provider.timetable!({ userId: 'owner' }) as any;
  assert.equal(schedule.items[0].courseId, course.id);
  assert.equal(schedule.items[0].courseMapping.method, 'title_professor');
});

test('unmapped and ambiguous periods never request another course, and a detail failure retains a correct mapping', async () => {
  let reads = 0;
  const saint = { timetable: async () => ({ term, entries: [{ ...slot, dayOfWeek: 4, startTime: '13:00', endTime: '14:00' }] }) };
  const run = async (courses: typeof course[]) => createCombinedDashboard(saint, {
    catalog: async () => ({ courses, term, termIds: ['term'] }),
    readCourse: async () => { reads++; throw new Error('upstream'); },
  }, () => new Date('2026-10-01T04:30:00Z')).dashboard!({ userId: 'owner' }) as Promise<any>;
  assert.equal((await run([])).currentCourse, null);
  assert.equal((await run([course, { ...course, id: 'course-2' }])).currentCourse, null);
  assert.equal(reads, 0);
  const result = await run([course]); assert.equal(result.currentCourse.id, course.id);
  assert.equal(result.availability.currentActivities, 'unavailable'); assert.equal(result.availability.timetable, 'available');
  assert.equal(reads, 1);
});
