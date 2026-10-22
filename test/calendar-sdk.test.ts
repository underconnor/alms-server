import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LearningxClient, SchoolHttpClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';

test('pinned SDK calendar flows through Backend ownership and minimum DTO using only synthetic HTTP responses', async () => {
  const key = randomBytes(32), owner = 'synthetic-owner';
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const calls: string[] = [];
  const http = new SchoolHttpClient(undefined, async (input, init) => {
    assert.equal(init?.method, 'GET');
    const url = new URL(String(input)); calls.push(url.pathname);
    let data: unknown;
    if (url.pathname.endsWith('/terms')) data = { enrollment_terms: [{ id: 1, name: '합성 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) data = [10,20].map(id => ({ id, name: '합성 강좌 ' + id, term_id: 1 }));
    else if (url.pathname === '/api/v1/users/self/profile') data = { id: 42, login_id: '90000001', name: 'private-name' };
    else if (url.pathname === '/api/v1/calendar_events') {
      assert.deepEqual(url.searchParams.getAll('context_codes[]'), ['course_10']);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      data = url.searchParams.get('type') === 'event' ? [{ id: 1, type: 'event', title: '합성 일정', context_code: 'course_10',
        start_at: '2099-10-02T09:00:00+09:00', end_at: '2099-10-02T10:00:00+09:00', all_day: false, all_day_date: null,
        description: '<p>private-description</p>', location_name: 'private-location', html_url: 'https://canvas.ssu.ac.kr/calendar?private=query' }] : [
        { id: 'assignment_90', type: 'assignment', title: '합성 과제', context_code: 'course_10', start_at: '2099-10-03T23:59:00+09:00',
          end_at: '2099-10-03T23:59:00+09:00', all_day: true, all_day_date: '2099-10-03', description: 'private-description',
          assignment: { id: 90, course_id: 10, due_at: '2099-10-03T23:59:00+09:00', published: true },
          html_url: 'https://canvas.ssu.ac.kr/courses/10/assignments/90' }];
    } else throw new Error('Unexpected synthetic school path');
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  await http.jar.setCookie('xn_api_token=synthetic; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await http.jar.setCookie('_canvas_session=synthetic; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const client = new LearningxClient(http, { userId: '42', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  const reader = createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } },
  key, async () => ({ client, serialize: () => http.jar.serialize() }), undefined, undefined, undefined, null);
  const result = await createLearningxReads(reader).calendar!({ userId: owner }, { start: '2099-10-01', end: '2099-11-01', courseId: '10' },
    { signal: new AbortController().signal, validate: async () => {} });
  assert.equal(result.complete, true); assert.equal(result.courses.length, 2); assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(value => value.id), ['1','assignment_90']);
  assert.equal(result.items[0]!.startsAt, '2099-10-02T00:00:00.000Z'); assert.equal(result.items[1]!.dueAt, '2099-10-03T14:59:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /private-|90000001|description|location|cookie|token|context_code|html_url/);
  assert.equal(calls.filter(path => path === '/api/v1/calendar_events').length, 2);
});
