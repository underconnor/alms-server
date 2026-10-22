import test from 'node:test';
import assert from 'node:assert/strict';
import { featureSupport, providerFeatures, submissionFeature } from '../src/feature-support.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { createLearningxReads, publicCourseContent, type LearningxReader } from '../src/school-read.js';
import type { SchoolOptions } from '../src/assignment-submission-types.js';
import type { SchoolActivityDetail } from '@alms/ssu-api';

const services = { assignmentSubmission: false, manualVideo: false, playbackStart: false, playbackReady: false };
const course = { id: '10', title: '합성 강좌', professor: null, term: null, sourceUrl: null };
const options = (): SchoolOptions => ({ supported: true, modes: ['online_upload'], blockedReason: null,
  allowedExtensions: ['pdf'], expectedAttempt: 2, pledge: { required: true, text: '합성 문구', digest: 'a'.repeat(64) }, generation: 'private-generation' });

test('implemented empty module collections remain available while unimplemented notices and quizzes are explicit', () => {
  const value = publicCourseContent({ course, modules: [] });
  assert.deepEqual(value.materials, []); assert.deepEqual(value.assignments, []); assert.deepEqual(value.notices, []);
  assert.equal(value.featureSupport.materials.availability, 'available');
  assert.equal(value.featureSupport.assignments.scope, 'module_collection');
  for (const section of ['notices', 'quizzes'] as const) {
    assert.equal(value.featureSupport[section].supported, false);
    assert.equal(value.featureSupport[section].reason, 'not_implemented');
    assert.deepEqual(value.featureSupport[section].permissions, { read: false, write: false });
  }
});

test('discovery distinguishes actual installed adapters from wrappers and never performs school reads', () => {
  let reads = 0;
  const reader = { catalog: async () => { reads++; throw new Error('must not read'); },
    readCourse: async () => { reads++; throw new Error('must not read'); },
    readTasks: async () => { reads++; throw new Error('must not read'); },
    readAttendance: async () => { reads++; throw new Error('must not read'); } } as LearningxReader;
  const provider = { ...unavailableSchoolProvider, ...createLearningxReads(reader) };
  const features = providerFeatures(provider, services);
  assert.equal(features.materials.supported, true); assert.equal(features.materials.availability, 'unknown');
  assert.equal(features.material_content.supported, false); assert.equal(features.manual_video.supported, false);
  assert.equal(features.assignment_detail.supported, false); assert.equal(features.syllabus.supported, false);
  assert.equal(features.courses.permissions.read, null); assert.equal(reads, 0);
  assert.equal(featureSupport(false, 'service', { availability: 'unknown', read: true, write: true }).availability, 'unavailable');
  assert.deepEqual(featureSupport(false, 'service', { read: true, write: true }).permissions, { read: false, write: false });
});

test('submission constraints reflect actual options and separate implementation from locked or unknown permission', () => {
  const allowed = submissionFeature(options());
  assert.equal(allowed.permissions.write, true); assert.equal(allowed.constraints!.maxFiles, 5);
  assert.deepEqual(allowed.constraints!.allowedExtensions, ['pdf']); assert.equal(allowed.constraints!.expectedAttempt, 2);
  assert.equal(allowed.constraints!.pledgeRequired, true);
  for (const reason of ['locked', 'attempts_exhausted', 'conditions_unknown', 'unsupported_mode', 'group_submission'] as const) {
    const value = submissionFeature({ ...options(), supported: false, blockedReason: reason });
    assert.equal(value.reason, reason); assert.equal(value.permissions.write, false);
    assert.equal(value.availability, reason === 'conditions_unknown' ? 'unknown' : 'unavailable');
    assert.equal(value.supported, !['unsupported_mode', 'group_submission'].includes(reason));
  }
  const pending = submissionFeature(options(), true);
  assert.equal(pending.reason, 'submission_in_progress'); assert.equal(pending.permissions.write, false);
  assert.doesNotMatch(JSON.stringify(allowed), /private-generation|合成|digest|text|auth|pledge.*a{64}/);
});

test('activity progress capabilities retain unknown course conditions and block confirmed read-only courses', async () => {
  const detail = { courseId: '10', moduleItemId: '30', resourceType: 'movie', published: true, opened: true,
    useAttendance: true, attendance: { completed: false, status: null }, unlockAt: null, dueAt: null, lateAt: null, lockAt: null } as SchoolActivityDetail;
  for (const [context, availability, write, reason] of [
    [{ ...course, schoolDefaultTerm: true, ended: false }, 'available', true, null],
    [course, 'unknown', null, 'conditions_unknown'],
    [{ ...course, schoolDefaultTerm: true, ended: true }, 'unavailable', false, 'course_read_only'],
  ] as const) {
    const reader = { readActivity: async () => ({ course: context, detail, observedAt: '2026-10-14T00:00:00Z' }),
      readVideo: async () => { throw new Error('must not read media'); } } as unknown as LearningxReader;
    const result = await createLearningxReads(reader).activity!({ userId: 'synthetic' }, '10', '30') as any;
    assert.equal(result.featureSupport.manual_video.permissions.read, true);
    assert.equal(result.featureSupport.manual_video_progress.availability, availability);
    assert.equal(result.featureSupport.manual_video_progress.permissions.write, write);
    assert.equal(result.featureSupport.manual_video_progress.reason, reason);
    assert.equal(result.featureSupport.material_content.supported, false);
  }
});
