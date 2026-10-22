import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LearningxClient, SchoolHttpClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';

test('pinned SDK list and fresh self-submission traverse Backend with safe metadata and no unposted grade', async () => {
  const key = randomBytes(32), owner = 'synthetic-assignment-owner';
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const calls: string[] = [];
  const submission = { assignment_id: 90, user_id: 42, workflow_state: 'submitted', attempt: 2, submission_type: 'online_upload',
    submitted_at: '2099-10-02T09:00:00+09:00', posted_at: null, score: 77, grade: 'private-unposted-grade', grade_matches_current_submission: true,
    body: '<p>내가 제출한 합성 내용</p>', url: 'https://example.org/submission', attachments: [{ id: 7, display_name: '합성 답안.pdf',
      'content-type': 'application/pdf', size: 1234, url: 'https://private.invalid/signed?token=secret' }],
    submission_comments: [{ id: 8, comment: '<p>합성 피드백</p>', author_name: 'private-author', author_id: 13 }] };
  const assignment = { id: 90, course_id: 10, name: '합성 과제', published: true, submission_types: ['online_upload'], allowed_attempts: -1,
    html_url: 'https://canvas.ssu.ac.kr/courses/10/assignments/90', description: '<p>첫 안내</p><p>두 번째 안내</p><script>private-script</script>',
    submission: { ...submission, attempt: 1 } };
  const http = new SchoolHttpClient(undefined, async (input, init) => {
    assert.equal(init?.method, 'GET'); const url = new URL(String(input)); calls.push(url.pathname);
    let data: unknown;
    if (url.pathname.endsWith('/terms')) data = { enrollment_terms: [{ id: 1, name: '합성 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) data = [{ id: 10, name: '합성 강좌', term_id: 1 }];
    else if (url.pathname === '/api/v1/users/self/profile') data = { id: 42, login_id: '90000001' };
    else if (url.pathname === '/api/v1/courses/10/assignments') data = [assignment];
    else if (url.pathname === '/api/v1/courses/10/assignments/90') data = assignment;
    else if (url.pathname === '/api/v1/courses/10/assignments/90/submissions/42') data = submission;
    else throw new Error('Unexpected synthetic school path');
    if (url.pathname.startsWith('/api/')) assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  await http.jar.setCookie('xn_api_token=synthetic; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await http.jar.setCookie('_canvas_session=synthetic; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const client = new LearningxClient(http, { userId: '42', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  const reader = createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } },
  key, async () => ({ client, serialize: () => http.jar.serialize() }), undefined, undefined, undefined, null);
  const provider = createLearningxReads(reader), options = { signal: new AbortController().signal, validate: async () => {} };
  const list = await provider.assignments!({ userId: owner }, '10', options);
  const detail = await provider.assignment!({ userId: owner }, '10', '90', options);
  assert.equal(list.complete, true); assert.equal(list.items.length, 1); assert.equal(list.items[0]!.submission?.attempt, 1);
  assert.equal(detail.submission?.attempt, 2); assert.equal(detail.submission?.resultVisibility, 'not_posted');
  assert.equal(detail.submission?.scoreState, 'withheld'); assert.equal(detail.submission?.score, null);
  assert.equal(detail.submission?.gradeState, 'withheld'); assert.equal(detail.submission?.grade, null);
  assert.equal(detail.descriptionText, '첫 안내\n두 번째 안내'); assert.equal(detail.submission?.feedback?.[0]?.text, '합성 피드백');
  assert.equal(detail.submission?.attachments?.[0]?.downloadAvailable, false); assert.equal(detail.moduleItemId, null);
  assert.deepEqual(detail.ownSubmittedContent, { text: '내가 제출한 합성 내용', url: 'https://example.org/submission' });
  assert.deepEqual(detail.descriptionAttachments, []);
  assert.equal(Object.hasOwn(list.items[0]!, 'ownSubmittedContent'), false);
  assert.doesNotMatch(JSON.stringify({ list, detail }), /private-|90000001|author_|user_id|assignment_id|token=|script>/);
  assert.equal(calls.filter(path => path.endsWith('/submissions/42')).length, 1);
});
