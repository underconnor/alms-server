import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModules, type SchoolModule } from '@alms/ssu-api';
import { publicCourseContent, type CourseRead } from '../src/school-read.js';

// Synthetic, already-parsed metadata only; SDK identity and media proof are separate boundaries.
const now = Date.parse('2030-01-01T00:00:00Z');
const course = { id: '10', title: 'Synthetic course', professor: null, term: null, sourceUrl: null,
  schoolDefaultTerm: true, ended: false };
const module: SchoolModule = { id: '1', title: 'Synthetic week', week: 4,
  items: ['everlec', 'movie', 'readystream', 'Everlec', 'everlec '].map((resourceType, index) => ({
    id: String(20 + index), title: 'Synthetic video', contentType: 'attendance_item', itemContentType: 'commons', resourceType,
    activityDetailAvailable: true, published: true, completed: false, unlockAt: '2029-12-31T23:59:59Z',
  })) };
const read = (patch: Partial<CourseRead> = {}): CourseRead => ({ course, modules: [module], usePureCanvas: true,
  observedAt: '2030-01-01T00:00:00Z', ...patch });
const items = (patch: Partial<CourseRead> = {}, details = true, selectable = true) => publicCourseContent(read(patch), details, selectable, now).weeks[0]!.activities;

test('Everlec list projection retains exact type and independent completion without claiming school progress', () => {
  const values = items();
  assert.deepEqual(values.map(item => item.resourceType), ['everlec', 'movie', 'readystream', null, null]);
  assert.deepEqual(values.map(item => item.type), ['video', 'video', 'video', 'other', 'other']);
  assert.deepEqual(values.map(item => item.playbackAvailable), [true, true, true, false, false]);
  assert.ok(values.every(item => item.progressPercent === null && item.schoolStatus === null && item.sourceUrl === null));
  assert.doesNotMatch(JSON.stringify(publicCourseContent(read(), true, true, now)), /usePureCanvas|commonsMappingVersion/);
  const completed = items({ modules: [{ ...module, items: [{ ...module.items[0]!, completed: true }] }] })[0]!;
  assert.equal(completed.moduleCompleted, true); assert.equal(completed.progressPercent, null);
});

test('Everlec list selection requires confirmed course mode, installed adapter, current course and open detail metadata', () => {
  for (const usePureCanvas of [undefined, null, false]) {
    const values = items({ usePureCanvas });
    assert.equal(values[0]!.playbackAvailable, false); assert.equal(values[0]!.detailAvailable, true);
    assert.equal(values[1]!.playbackAvailable, true); assert.equal(values[2]!.playbackAvailable, false);
  }
  assert.equal(items({}, false)[0]!.playbackAvailable, false); assert.equal(items({}, true, false)[0]!.playbackAvailable, false);
  for (const changed of [{ ...course, schoolDefaultTerm: false }, { ...course, ended: true }])
    assert.equal(items({ course: changed })[0]!.playbackAvailable, false);
  for (const patch of [{ activityDetailAvailable: false }, { published: false }, { published: undefined }, { unlockAt: null },
    { unlockAt: '2030-01-01T00:00:00.001Z' }, { unlockAt: '2029-02-30T00:00:00Z' }])
    assert.equal(items({ modules: [{ ...module, items: [{ ...module.items[0]!, ...patch }] }] })[0]!.playbackAvailable, false);
});

test('packaged SDK Everlec modules become exact video DTOs without movie or Readystream aliases', () => {
  const modules = parseModules([{ module_id: 1, title: 'Synthetic week', week_position: 4,
    module_items: ['everlec','Everlec','movie','readystream'].map((content_type,index) => ({ module_item_id: 20 + index,
      title: 'Synthetic video', content_type: 'attendance_item', published: true, completion_determinable: true, completed: false,
      content_data: { course_id: 10, item_id: 30 + index, item_content_type: 'commons', unlock_at: '2029-12-31T23:59:59Z',
        item_content_data: { content_type, content_id: 'synthetic-video' } } })) }], '10');
  const values = items({ modules });
  assert.deepEqual(values.map(v => [v.resourceType,v.type,v.playbackAvailable]),
    [['everlec','video',true],[null,'other',false],['movie','video',true],['readystream','video',true]]);
});
