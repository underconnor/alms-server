import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LearningxClient, SchoolHttpClient, SchoolError } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
test('pinned SDK all-term reads reach past list/detail context while existing default-term submission options remain forbidden', async () => {
  const owner = 'synthetic-past-sdk-owner', key = randomBytes(32);
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const own = { user_id: 42, assignment_id: 90, workflow_state: 'unsubmitted', attempt: 0, submitted_at: null, attachments: [] };
  const assignment = { id: 90, course_id: 20, name: 'Synthetic past assignment', submission_types: ['online_upload'], description: '<p>Synthetic instructions</p>', submission: own };
  const calls: URL[] = [];
  const http = new SchoolHttpClient(undefined, async (input, init) => {
    assert.equal(init?.method, 'GET'); const url = new URL(String(input)); calls.push(url); let data: unknown;
    if (url.pathname.endsWith('/terms')) data = { enrollment_terms: [{ id: 1, name: '2099 Current', default: true }, { id: 2, name: '2098 Past', default: false }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) data = [
      { id: 10, name: 'Synthetic current', term_id: 1 }, { id: 20, name: 'Synthetic past', term_id: 2, ended: true },
    ].filter(course => url.searchParams.getAll('term_ids[]').includes(String(course.term_id)));
    else if (url.pathname === '/api/v1/users/self/profile') data = { id: 42, login_id: '90000001' };
    else if (url.pathname === '/api/v1/courses/20/assignments') data = [assignment];
    else if (url.pathname === '/api/v1/courses/20/assignments/90') data = assignment;
    else if (url.pathname === '/api/v1/courses/20/assignments/90/submissions/42') data = own;
    else throw new Error('Unexpected synthetic school path');
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  await http.jar.setCookie('xn_api_token=synthetic; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await http.jar.setCookie('_canvas_session=synthetic; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const client = new LearningxClient(http, { userId: '42', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  const reader = createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } }, key,
    async () => ({ client, serialize: () => http.jar.serialize() }), undefined, undefined, undefined, null);
  const provider = createLearningxReads(reader), options = { signal: new AbortController().signal, validate: async () => {} };
  const list = await provider.assignments!({ userId: owner }, '20', options), detail = await provider.assignment!({ userId: owner }, '20', '90', options);
  const context = { id: '20', title: 'Synthetic past', term: '2098 Past', termId: '2', schoolDefaultTerm: false, ended: true };
  assert.deepEqual(list.course, context); assert.deepEqual(detail.course, context); assert.equal(detail.descriptionText, 'Synthetic instructions');
  assert.equal(detail.submission?.workflowState, 'unsubmitted'); assert.equal(detail.submission?.attempt, 0);
  calls.filter(url => url.pathname.endsWith('/learn_activities/courses')).forEach(url => assert.deepEqual(url.searchParams.getAll('term_ids[]'), ['1', '2']));
  const before = calls.length;
  await assert.rejects(client.assignmentSubmissionOptions('20', '90', { signal: options.signal }), error => error instanceof SchoolError && error.code === 'forbidden_target');
  const rejected = calls.slice(before); assert.equal(rejected.length, 3);
  assert.deepEqual(rejected.at(-1)!.searchParams.getAll('term_ids[]'), ['1']);
  assert.equal(rejected.some(url => url.pathname.includes('/assignments')), false);
});
