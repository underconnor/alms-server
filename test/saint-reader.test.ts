import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSaintReader, type Schedule } from '../src/saint-reader.js';
import { createLearningxReader } from '../src/school-reader.js';
import { createCombinedDashboard, currentSchedule } from '../src/school-dashboard.js';
import { encryptSchoolSession, decryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';

const entry = { dayOfWeek: 4 as const, courseTitle: '합성 과목', startTime: '13:00', endTime: '14:15', room: '합성 강의실', professor: null };
const timetable = { selectedYear: 2026, selectedSemester: '092' as const, entries: [entry] };
function fixture() {
  const key = randomBytes(32), states = new Map<string, string>();
  const state = (owner: string) => encryptSchoolSession({ version: 1, identity: { studentId: owner === 'a' ? '90000001' : '90000002' }, jar: {}, lmsExchange: { status: 'failed' } }, key, owner, 'ssu');
  states.set('a', state('a')); states.set('b', state('b'));
  const store = {
    getEncryptedSchoolSession: async (owner: string) => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, previous: string, next: string) => {
      if (states.get(owner) !== previous) return false;
      states.set(owner, next); return true;
    },
  };
  return { key, states, state, store };
}
test('Saint restores only the owner session, coalesces reads, and preserves LMS metadata', async () => {
  const f = fixture(); const identities: string[] = [];
  const reader = createSaintReader(f.store, f.key, async session => {
    identities.push(session.identity.studentId); return { timetable, jar: {} };
  });
  const [a, duplicate, b] = await Promise.all([reader.timetable('a'), reader.timetable('a'), reader.timetable('b')]);
  assert.equal(a, duplicate); assert.equal(a.term, '2026년 2학기');
  assert.equal(a.entries[0]!.courseId, null); assert.equal(b.entries[0]!.courseTitle, entry.courseTitle);
  assert.deepEqual(identities.sort(), ['90000001', '90000002']);
  assert.deepEqual((decryptSchoolSession(f.states.get('a')!, f.key, 'a', 'ssu') as any).lmsExchange, { status: 'failed' });
  assert.equal(await reader.timetable('a'), a);
  f.states.delete('a');
  await assert.rejects(reader.timetable('a'), error => error instanceof AppError && error.statusCode === 401);
});
test('Saint rejects swapped encryption and prevents a concurrent login from being overwritten', async () => {
  const f = fixture(); let calls = 0;
  const reader = createSaintReader(f.store, f.key, async () => {
    calls++; f.states.set('a', f.state('a')); return { timetable, jar: {} };
  });
  f.states.set('b', f.states.get('a')!);
  await assert.rejects(reader.timetable('b'), error => error instanceof AppError && error.statusCode === 401);
  assert.equal(calls, 0);
  await assert.rejects(reader.timetable('a'), error => error instanceof AppError && error.code === 'SCHOOL_SESSION_CHANGED');
  assert.equal(calls, 1);
});
test('the dashboard retains Saint data after LMS failure and never invents a LMS course link', async () => {
  const slot: Schedule = { ...entry, id: 'synthetic', courseId: null };
  const provider = createCombinedDashboard({ timetable: async () => ({ term: '2026년 2학기', entries: [slot] }) },
    { catalog: async () => { throw new AppError(401, 'AUTH_REQUIRED', 'LMS expired'); } }, () => new Date('2026-10-01T04:30:00Z'));
  const result = await provider.dashboard!({ userId: 'a' }) as any;
  assert.deepEqual(result.timetable[0], { ...slot, courseMapping: { status: 'unmatched', method: null, candidateCourseIds: [] } }); assert.equal(result.currentSchedule.courseId, null);
  assert.equal(result.currentCourse, null); assert.equal(result.availability.courses, 'unavailable');
  assert.equal(result.availability.timetable, 'available');
});
test('failed Saint reads are not reported as an empty timetable and both failures propagate', async () => {
  const saint = { timetable: async () => { throw new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'unavailable'); } };
  const provider = createCombinedDashboard(saint, { catalog: async () => ({ term: '합성 학기', courses: [], termIds: [] }) });
  const result = await provider.dashboard!({ userId: 'a' }) as any;
  assert.equal(result.availability.timetable, 'unavailable'); assert.equal(result.availability.courses, 'available');
  await assert.rejects(createCombinedDashboard(saint).dashboard!({ userId: 'a' }), error => error instanceof AppError && error.statusCode === 502);
});
test('current class uses Seoul time with an inclusive start and exclusive finish', () => {
  const slot: Schedule = { ...entry, id: 'synthetic', courseId: null };
  assert.equal(currentSchedule([slot], new Date('2026-10-01T03:59:59Z')), null);
  assert.equal(currentSchedule([slot], new Date('2026-10-01T04:00:00Z')), slot);
  assert.equal(currentSchedule([slot], new Date('2026-10-01T05:14:59Z')), slot);
  assert.equal(currentSchedule([slot], new Date('2026-10-01T05:15:00Z')), null);
});
test('school readers serialize same-owner jar writes and release the lock after errors', async () => {
  const steps: string[] = [];
  const first = withSchoolSessionLock('synthetic-lock', async () => {
    steps.push('first-start'); await new Promise(resolve => setTimeout(resolve, 5)); steps.push('first-end'); throw new Error('synthetic');
  });
  const second = withSchoolSessionLock('synthetic-lock', async () => { steps.push('second'); });
  await Promise.allSettled([first, second]); assert.deepEqual(steps, ['first-start', 'first-end', 'second']);
});

test('LMS and Saint jar refreshes keep same-login caches valid; a fresh login invalidates both', async () => {
  const f = fixture(); let saintCalls = 0, lmsCalls = 0;
  const saint = createSaintReader(f.store, f.key, async () => { saintCalls++; return { timetable, jar: {} }; });
  const lms = createLearningxReader(f.store, f.key, async () => {
    lmsCalls++; return { serialize: async () => ({}), client: { terms: async () => [] } as any };
  });
  const dashboard = createCombinedDashboard(saint, lms);
  await dashboard.dashboard!({ userId: 'a' }); await dashboard.dashboard!({ userId: 'a' });
  assert.equal(saintCalls, 1); assert.equal(lmsCalls, 1);
  f.states.set('a', f.state('a'));
  await dashboard.dashboard!({ userId: 'a' });
  assert.equal(saintCalls, 2); assert.equal(lmsCalls, 2);
});

test('combined dashboard exposes successfully read school tasks and preserves timetable when TODO fails', async () => {
  let failed = false;
  const saint = { timetable: async () => ({ term: '합성 학기', entries: [] }) };
  const catalog = { courses: [{ id: '1', title: '합성 강좌', professor: null, term: '합성 학기', sourceUrl: null }], term: '합성 학기', termIds: ['1'] };
  const dashboard = createCombinedDashboard(saint, {
    catalog: async () => catalog,
    readTasks: async () => {
      if (failed) throw new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'unavailable');
      return { catalog, observedAt: '2099-01-01T00:00:00Z', groups: [{ courseId: '1', activities: {}, items: [{
        title: '합성 과제', componentType: 'assignment', commonsType: null, componentId: '2', assignmentId: '3',
        quizId: null, discussionId: null, sectionId: null, unitId: null, dueAt: '2099-01-02T00:00:00Z', sourceUrl: null,
      }] }] };
    },
  });
  const success = await dashboard.dashboard!({ userId: 'a' }) as any;
  assert.equal(success.upcomingTasks.length, 1); assert.equal(success.availability.tasks, 'available');
  assert.equal('completed' in success.upcomingTasks[0], false);
  failed = true;
  const partial = await dashboard.dashboard!({ userId: 'a' }) as any;
  assert.equal(partial.availability.tasks, 'unavailable'); assert.equal(partial.availability.courses, 'available');
  assert.equal(partial.availability.timetable, 'available'); assert.deepEqual(partial.upcomingTasks, []);
});
