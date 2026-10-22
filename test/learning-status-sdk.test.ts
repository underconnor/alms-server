import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LearningxClient, SchoolHttpClient } from '@alms/ssu-api';
import { encryptSchoolSession } from '../src/crypto.js';
import { createLearningxReader } from '../src/school-reader.js';
import { createSchoolProvider } from '../src/school-adapter.js';

test('pinned fresh-status SDK integrates with Backend using exact owned module detail without recognition or playback', async () => {
  const owner = 'synthetic-owner', key = randomBytes(32);
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const calls: string[] = [], resource = { content_type: 'movie', content_id: 'synthetic-content', duration: 600 };
  const http = new SchoolHttpClient(undefined, async (input, init) => {
    assert.equal(init?.method, 'GET'); const url = new URL(String(input)); calls.push(url.pathname); let data: unknown;
    if (url.pathname.endsWith('/terms')) data = { enrollment_terms: [{ id: 1, name: '합성 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) data = [{ id: 10, name: '합성 강좌', term_id: 1 }];
    else if (url.pathname === '/api/v1/users/self/profile') data = { id: 42, login_id: '90000001' };
    else if (url.pathname === '/learningx/api/v1/courses/10/modules') data = [{ module_items: [{ module_item_id: 90, content_type: 'attendance_item',
      content_data: { course_id: 10, item_id: 900, item_content_type: 'commons', item_content_data: resource } }] }];
    else if (url.pathname === '/learningx/api/v1/courses/10/attendance_items/900') {
      assert.equal(init?.cache, 'no-store'); data = { course_id: 10, item_id: 900, item_content_type: 'commons', item_content_data: resource,
        published: true, opened: true, use_attendance: true, omit_progress: false,
        attendance_data: { completed: true, attendance_status: 'attendance', progress: 600, last_at: 610 },
        title: 'private-title', description: 'private-description', view_url: 'https://private.invalid?token=secret' };
    } else throw new Error('Unexpected synthetic school path');
    if (url.pathname.startsWith('/api/')) assert.equal(new Headers(init?.headers).get('authorization'), null);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  await http.jar.setCookie('xn_api_token=synthetic; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await http.jar.setCookie('_canvas_session=synthetic; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const client = new LearningxClient(http, { userId: '42', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  const reader = createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } },
  key, async () => ({ client, serialize: () => http.jar.serialize() }), undefined, undefined, undefined, null);
  const provider = createSchoolProvider(true, reader); assert.equal(provider.capabilities.playback, false);
  for (let i = 0; i < 2; i++) {
    const result = await provider.learningStatus!({ userId: owner }, { courseId: '10', lectureId: '90' });
    assert.equal(result.recognized, null); assert.equal(result.attendance, 'unknown'); assert.equal(result.progressPercent, 100);
    assert.equal(result.evidence?.completed, true); assert.equal(result.evidence?.schoolAttendanceStatus, 'attendance');
    assert.equal(result.evidence?.progressSeconds, 600); assert.equal(result.evidence?.lastPositionSeconds, 610);
    assert.doesNotMatch(JSON.stringify(result), /private-|90000001|moduleItemId|itemId|token=|description/);
  }
  assert.equal(calls.filter(path => path.endsWith('/attendance_items/900')).length, 2);
  assert.equal(calls.filter(path => path === '/api/v1/users/self/profile').length, 2);
});
