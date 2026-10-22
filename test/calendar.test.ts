import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarQuery, publicCalendar, calendarMatchesCatalog } from '../src/calendar.js';
import { SchoolError } from '@alms/ssu-api';
const query = { start: '2099-10-01', end: '2099-11-01' };
const course = { id: '10', title: '합성 강좌' };
const catalog = { courses: [{ ...course, professor: null, term: null, sourceUrl: null }], term: null, termIds: ['1'] };
const row = { id: 'assignment_90', type: 'assignment', courseId: '10', title: '합성 마감', startsAt: '2099-10-01T14:59:00.000Z',
  endsAt: '2099-10-01T14:59:00.000Z', allDay: true, allDayDate: '2099-10-01', dueAt: '2099-10-01T14:59:00.000Z', assignmentId: '90',
  sourceUrl: 'https://canvas.ssu.ac.kr/courses/10/assignments/90', userSubmitted: null };
const result = () => ({ ...query, timeZone: 'Asia/Seoul', courses: [course], items: [{ ...row }], complete: true });
test('calendar range accepts real dates and one month including leap year without caller identity or duplicated query', () => {
  assert.deepEqual(calendarQuery.parse(query), query);
  assert.ok(calendarQuery.safeParse({ start: '2100-02-01', end: '2100-03-01', courseId: '10' }).success);
  assert.ok(calendarQuery.safeParse({ start: '2096-02-29', end: '2096-03-01' }).success);
  for (const input of [{ ...query, end: '2099-11-02' }, { ...query, end: query.start }, { ...query, start: '2099-02-29' },
    { ...query, start: '2099-10-1' }, { start: '2101-01-01', end: '2101-02-01' }, { ...query, courseId: '0' }, { ...query, courseId: ['10','20'] }, { ...query, userId: 'other' }])
    assert.equal(calendarQuery.safeParse(input).success, false);
});
test('calendar projection strips raw/private fields and preserves school date versus exact assignment due time', () => {
  const value = result(); Object.assign(value, { html: 'private-top', token: 'private-token' });
  Object.assign(value.items[0]!, { descriptionText: 'private-description', description: '<b>private</b>', location: 'private-location', submitted: true });
  const data = publicCalendar(value, query, catalog);
  assert.deepEqual(data.items[0], row); assert.equal(data.complete, true);
  assert.doesNotMatch(JSON.stringify(data), /private|submitted|description|location|token/);
  assert.equal(data.items[0]!.allDayDate, '2099-10-01'); assert.equal(data.items[0]!.dueAt, '2099-10-01T14:59:00.000Z');
});
test('only the exact verified course assignment source may reach the browser', () => {
  for (const url of ['https://canvas.ssu.ac.kr/courses/11/assignments/90', 'https://canvas.ssu.ac.kr/courses/10/assignments/90?token=private',
    'https://canvas.ssu.ac.kr/courses/10/assignments/90#private', 'https://user:private@canvas.ssu.ac.kr/courses/10/assignments/90',
    'https://other.test/courses/10/assignments/90', 'https://canvas.ssu.ac.kr/calendar?event=private']) {
    const value = result(); value.items[0] = { ...row, sourceUrl: url };
    assert.equal(publicCalendar(value, query).items[0]!.sourceUrl, null);
  }
});
test('wrong range, incomplete coverage, foreign course, ambiguous IDs or missing date never become an empty success', () => {
  for (const value of [{ ...result(), end: '2099-10-31' }, { ...result(), complete: false },
    { ...result(), items: [{ ...row, courseId: '20' }] }, { ...result(), items: [row, row] },
    { ...result(), courses: [course,course] }, { ...result(), items: [{ ...row, allDayDate: null }] },
    { ...result(), items: [{ ...row, assignmentId: null }] }, { ...result(), items: [{ ...row, id: 'assignment_91' }] },
    { ...result(), items: [{ ...row, dueAt: '2099-10-02T14:59:00.000Z' }] },
    { ...result(), items: [{ ...row, allDayDate: '2099-11-01' }] }]) {
    assert.throws(() => publicCalendar(value, query, catalog), error => error instanceof SchoolError && error.code === 'unexpected_response');
  }
  assert.equal(calendarMatchesCatalog(result(), query, { ...catalog, courses: [] }), false);
  assert.equal(calendarMatchesCatalog(result(), query, catalog), true);
  assert.deepEqual(publicCalendar({ ...result(), items: [] }, query).items, []);
});
test('calendar DTOs exceeding the existing one-MiB cache entry limit fail explicitly before caching', () => {
  const value = { ...result(), items: Array.from({ length: 1500 }, (_value, index) => ({ ...row, id: `assignment_${index + 1}`, assignmentId: String(index + 1), title: 'x'.repeat(1000) })) };
  assert.throws(() => publicCalendar(value, query), error => error instanceof SchoolError && error.code === 'unsupported');
});

test('calendar submitted display uses the verified own-user flag and preserves unknown legacy values', () => {
  for (const flag of [true, false, null, undefined]) {
    const value = result(); Object.assign(value.items[0]!, { userSubmitted: flag });
    assert.equal(publicCalendar(value, query, catalog).items[0]!.userSubmitted, flag ?? null);
  }
  for (const flag of ['true', 'false', 1, 0, {}, []]) {
    const value = result(); Object.assign(value.items[0]!, { userSubmitted: flag });
    assert.throws(() => publicCalendar(value, query, catalog), error => error instanceof SchoolError && error.code === 'unexpected_response');
  }
  const event = { ...row, id: '1', type: 'event', assignmentId: null, dueAt: null, userSubmitted: true };
  assert.throws(() => publicCalendar({ ...result(), items: [event] }, query, catalog), error => error instanceof SchoolError);
});
