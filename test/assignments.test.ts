import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError } from '@alms/ssu-api';
import { assignmentCourseContext, publicAssignments, publicAssignmentDetail } from '../src/assignments.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
const bad = (fn: () => unknown) => assert.throws(fn, error => error instanceof SchoolError && error.code === 'unexpected_response');
test('catalog-derived assignment context is target bound, nullable and top-level only with legacy compatibility', () => {
  const course = { id: '10', title: 'Synthetic course', term: null };
  const context = { ...course, termId: null, schoolDefaultTerm: null, ended: null };
  assert.deepEqual(assignmentCourseContext(course, '10'), context);
  const list = publicAssignments(assignmentListFixture(), '10', course), detail = publicAssignmentDetail(assignmentFixture(), '10', '90', course);
  assert.deepEqual(list.course, context); assert.deepEqual(detail.course, context);
  assert.equal(Object.hasOwn(list.items[0]!, 'course'), false); assert.equal(Object.hasOwn(publicAssignments(assignmentListFixture(), '10'), 'course'), false);
  assert.deepEqual(publicAssignmentDetail(detail, '10', '90').course, context);
  bad(() => publicAssignments({ ...list, course: { ...context, id: '20' } }, '10'));
  bad(() => publicAssignmentDetail({ ...detail, course: { ...context, id: '20' } }, '10', '90'));
  bad(() => assignmentCourseContext({ ...course, id: '20' }, '10'));
  bad(() => publicAssignmentDetail({ ...detail, course: { ...context, ended: 'unknown' } }, '10', '90'));
});
test('assignment projection returns only required content and safe metadata, with no student, submitted body, or signed URLs', () => {
  const input = assignmentFixture();
  Object.assign(input, { raw_html: '<script>private</script>', quiz_id: 'private-quiz', moduleItemId: null });
  Object.assign(input.submission!, { user_id: 'private-user', body: 'private-body', preview_url: 'https://private.test/signed' });
  Object.assign(input.submission!.attachments![0]!, { url: 'https://private.test/signed?token=private', thumbnail_url: 'private-thumb' });
  const value = publicAssignmentDetail(input, '10', '90');
  assert.equal(value.descriptionText, '합성 과제 안내\n두 번째 문단'); assert.equal(value.moduleItemId, null);
  assert.equal(value.submission?.scoreState, 'missing'); assert.equal(Object.hasOwn(value.submission!, 'score'), false);
  assert.equal(value.submission?.attachments?.[0]?.downloadAvailable, false);
  assert.doesNotMatch(JSON.stringify(value), /private-|raw_html|quiz_id|user_id|preview_url|thumbnail|token/);
});
test('missing and null submission, attachment, feedback, grade and score values remain distinct', () => {
  for (const state of ['missing', 'null'] as const) {
    const input = assignmentListFixture(); input.items[0]!.submissionState = state; input.items[0]!.submission = null;
    assert.equal(publicAssignments(input, '10').items[0]!.submissionState, state);
  }
  const input = assignmentFixture(); input.submission!.attachments = null; input.submission!.feedback = null;
  input.submission!.score = null; input.submission!.scoreState = 'null';
  const value = publicAssignmentDetail(input, '10', '90');
  assert.equal(value.submission!.score, null); assert.equal(value.submission!.scoreState, 'null');
  assert.equal(Object.hasOwn(value.submission!, 'grade'), false);
  assert.equal(value.submission!.attachments, null); assert.equal(value.submission!.feedback, null);
});
test('only posted grades matching the current attempt can carry values, including a real zero score', () => {
  const input = assignmentFixture(), own = input.submission!;
  own.postedAt = '2099-10-04T00:00:00.000Z'; own.resultVisibility = 'available'; own.scoreState = 'available'; own.gradeState = 'available'; own.score = 0; own.grade = '0';
  const output = publicAssignmentDetail(input, '10', '90'); assert.equal(output.submission?.score, 0);
  for (const mutate of [() => { own.postedAt = null; }, () => { delete own.postedAt; }, () => { own.gradeMatchesCurrentSubmission = false; }, () => { own.gradeMatchesCurrentSubmission = null; }]) {
    const snapshot = structuredClone(own); mutate(); bad(() => publicAssignmentDetail(input, '10', '90')); Object.assign(own, snapshot);
  }
});
test('stale takes precedence, not-posted differs from unknown, and withheld is not an invented null result', () => {
  for (const mode of ['stale', 'not_posted', 'unknown'] as const) {
    const input = assignmentFixture(), own = input.submission!;
    if (mode === 'stale') own.gradeMatchesCurrentSubmission = false;
    if (mode === 'unknown') delete own.postedAt;
    own.resultVisibility = mode; own.scoreState = 'withheld'; own.score = null;
    const result = publicAssignmentDetail(input, '10', '90'); assert.equal(result.submission?.resultVisibility, mode);
    assert.equal(result.submission?.score, null); assert.equal(result.submission?.scoreState, 'withheld');
    own.score = 0; bad(() => publicAssignmentDetail(input, '10', '90'));
  }
});
test('wrong IDs, grade presence, duplicate metadata or incomplete lists are not successful assignment reads', () => {
  for (const mutate of [
    (input: ReturnType<typeof assignmentFixture>) => { input.id = '91'; },
    input => { input.courseId = '20'; }, input => { input.submission = null; },
    input => { input.submission = null; input.submissionState = 'null'; },
    input => { input.submission = null; input.submissionState = 'missing'; },
    input => { input.submission!.score = null; }, input => { input.submission!.gradeState = 'null'; },
    input => { input.submission!.attachments!.push(input.submission!.attachments![0]!); },
  ]) { const input = assignmentFixture(); mutate(input); bad(() => publicAssignmentDetail(input, '10', '90')); }
  const list = assignmentListFixture(); bad(() => publicAssignments({ ...list, complete: false }, '10'));
  bad(() => publicAssignments({ ...list, items: [...list.items, ...list.items] }, '10'));
  const input = assignmentFixture(); input.sourceUrl += '?token=private'; assert.equal(publicAssignmentDetail(input, '10', '90').sourceUrl, null);
  const published = assignmentFixture(); Object.assign(published.submission!, { postedAt: '2099-10-04T00:00:00.000Z', resultVisibility: 'available', gradeState: 'available' });
  for (const grade of ['', ' ', '\n', 'A\u0000']) { published.submission!.grade = grade; bad(() => publicAssignmentDetail(published, '10', '90')); }
});
test('oversized assignment projection fails explicitly before entering the shared one-MiB cache', () => {
  const input = assignmentListFixture(); input.items = Array.from({ length: 150 }, (_value, i) => ({ ...input.items[0]!, id: String(i + 1), title: 'x'.repeat(10000) }));
  assert.throws(() => publicAssignments(input, '10'), error => error instanceof SchoolError && error.code === 'unsupported');
});
test('detail exposes bound instructions and own submitted content while list stays summary-only', () => {
  const input = assignmentFixture();
  input.descriptionAttachments = [{ id: '8', fileName: '안내.pdf', contentType: 'application/pdf', sizeBytes: 12, downloadAvailable: true }];
  input.submission!.attachments![0]!.downloadAvailable = true;
  input.ownSubmittedContent = { text: '내가 제출한 내용', url: 'https://example.org/answer' }; input.moduleItemId = '17';
  const detail = publicAssignmentDetail(input, '10', '90'); assert.equal(detail.descriptionAttachments[0]!.downloadAvailable, true);
  assert.equal(detail.submission!.attachments![0]!.downloadAvailable, true); assert.equal(detail.ownSubmittedContent!.text, '내가 제출한 내용');
  const list = publicAssignments({ courseId: '10', items: [input], complete: true }, '10');
  assert.equal(list.items[0]!.submission!.attachments![0]!.downloadAvailable, false);
  assert.equal(Object.hasOwn(list.items[0]!, 'ownSubmittedContent'), false); assert.equal(Object.hasOwn(list.items[0]!, 'descriptionAttachments'), false);
  input.descriptionAttachments.push(input.descriptionAttachments[0]!); bad(() => publicAssignmentDetail(input, '10', '90'));
});
test('unsubmitted/unknown content and unsafe submitted URL are not accepted as own submitted content', () => {
  for (const state of ['unsubmitted', 'unknown'] as const) {
    const input = assignmentFixture(); input.submission!.workflowState = state; input.ownSubmittedContent = { text: '내용', url: null };
    bad(() => publicAssignmentDetail(input, '10', '90'));
  }
  for (const url of ['javascript:alert(1)', 'https://name:secret@example.org/', 'https://example.org/\nother']) {
    const input = assignmentFixture(); input.ownSubmittedContent = { text: null, url }; bad(() => publicAssignmentDetail(input, '10', '90'));
  }
});
