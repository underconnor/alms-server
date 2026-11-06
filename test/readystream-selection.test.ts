import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModules, type SchoolModule } from '@alms/ssu-api';
import { publicCourseContent, type CourseRead } from '../src/school-read.js';

// Synthetic list metadata only. Media proof and school writes belong to admission/runtime tests.
const now = Date.parse('2030-01-01T00:00:00Z');
const course = { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: null,
  schoolDefaultTerm: true, ended: false };
const modules = parseModules([{ module_id: 1, title: '합성 주차', week_position: 1,
  module_items: ['readystream', 'movie', 'Readystream', 'pdf'].map((type, index) => ({
    module_item_id: 20 + index, title: '합성 활동', content_type: 'attendance_item',
    published: true, completion_determinable: true, completed: index === 0,
    content_data: { course_id: 10, item_id: 30 + index, item_content_type: 'commons',
      unlock_at: '2029-12-31T23:59:59Z', item_content_data: { content_type: type, content_id: 'private-synthetic' } },
  })),
}], '10');
const read = (change: Partial<CourseRead> = {}) => ({ course, modules, usePureCanvas: true, ...change });
const items = (change: Partial<CourseRead> = {}, details = true, selectable = true) =>
  publicCourseContent(read(change), details, selectable, now).weeks[0]!.activities;

test('confirmed pureCanvas canonical readystream is a server selection candidate without claiming progress or attendance', () => {
  const activities = items();
  assert.deepEqual(activities.map(item => item.playbackAvailable), [true, true, false, false]);
  assert.equal(activities[0]!.resourceType, 'readystream'); assert.equal(activities[0]!.detailAvailable, true);
  // School completion remains an independent observation; the Front excludes completed auto selections.
  assert.equal(activities[0]!.moduleCompleted, true);
  assert.ok(activities.every(item => item.schoolStatus === null && item.progressPercent === null && item.sourceUrl === null));
  assert.doesNotMatch(JSON.stringify(publicCourseContent(read(), true, true, now)), /usePureCanvas|private-synthetic|attendanceItemId/);
});

test('missing, unknown or legacy private course mode cannot enable a readystream candidate or alter movie eligibility', () => {
  for (const usePureCanvas of [undefined, null, false]) {
    const activities = items({ usePureCanvas });
    assert.equal(activities[0]!.playbackAvailable, false, String(usePureCanvas));
    assert.equal(activities[0]!.detailAvailable, true, 'The readable body remains supported.');
    assert.equal(activities[1]!.playbackAvailable, true, 'Existing movie selection does not require the new discriminator.');
  }
});

test('readystream selection retains explicit adapter opt-in and current-course guards', () => {
  assert.equal(items({}, false, true)[0]!.playbackAvailable, false);
  assert.equal(items({}, true, false)[0]!.playbackAvailable, false);
  for (const changed of [{ ...course, schoolDefaultTerm: false }, { ...course, ended: true }])
    assert.equal(items({ course: changed })[0]!.playbackAvailable, false);
});

test('readystream selection refuses unconfirmed detail, publication and unlock metadata before admission', () => {
  const base = modules[0]!.items[0]!;
  const variants = [base, { ...base, activityDetailAvailable: false }, { ...base, activityDetailAvailable: undefined },
    { ...base, published: false }, { ...base, published: null }, { ...base, published: undefined },
    { ...base, unlockAt: null }, { ...base, unlockAt: undefined }, { ...base, unlockAt: '2030-01-01T00:00:00.001Z' },
    { ...base, unlockAt: '2029-02-30T00:00:00Z' }, { ...base, unlockAt: '2029-12-31 23:59' }];
  const changedModules: SchoolModule[] = [{ ...modules[0]!, items: variants }];
  assert.deepEqual(items({ modules: changedModules }).map(item => item.playbackAvailable), [true, ...variants.slice(1).map(() => false)]);
});
