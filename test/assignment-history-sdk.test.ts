import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { LearningxClient, SchoolHttpClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import type { Store } from '../src/store.js';

async function fixture() {
  const origin = 'https://canvas.ssu.ac.kr', owner = 'synthetic-history-owner', key = randomBytes(32), generation = randomUUID();
  let state = encryptSchoolSession({ version: 1, generation, identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const earlier = { assignment_id: 90, user_id: 42, attempt: 1, workflow_state: 'future_workflow', submission_type: 'online_upload',
    submitted_at: '2099-10-01T09:00:00+09:00', posted_at: '2099-10-02T09:00:00+09:00', score: 99, grade: 'private-history-grade',
    attachments: [{ id: 7, display_name: '합성 이전 답안.pdf', 'content-type': 'application/pdf', size: 8,
      url: origin + '/files/7/download?verifier=synthetic-private' }] };
  const latest = { assignment_id: 90, user_id: 42, attempt: 2, workflow_state: 'unsubmitted', submission_type: 'online_url',
    submitted_at: '2099-10-02T09:00:00+09:00', url: '', attachments: [] };
  let own: unknown = { ...latest, submission_history: [earlier, latest] };
  const calls: URL[] = [];
  const http = new SchoolHttpClient(undefined, async (input, init) => {
    assert.equal(init?.method, 'GET'); const url = new URL(String(input)), headers = new Headers(init?.headers); calls.push(url);
    assert.equal(url.origin, origin);
    if (!url.pathname.startsWith('/learningx/')) {
      assert.equal(headers.has('authorization'), false); assert.doesNotMatch(headers.get('cookie') ?? '', /xn_api_token|sToken|sIdno/);
    }
    let data: unknown;
    if (url.pathname.endsWith('/terms')) data = { enrollment_terms: [{ id: 1, name: '합성 현재 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) data = [{ id: 10, name: '합성 강좌', term_id: 1 }];
    else if (url.pathname === '/api/v1/users/self/profile') data = { id: 42, login_id: '90000001' };
    else if (url.pathname === '/api/v1/courses/10/assignments/90') data = { id: 90, course_id: 10, name: '합성 과제', submission_types: ['online_upload', 'online_url'] };
    else if (url.pathname === '/api/v1/courses/10/assignments/90/submissions/42') {
      assert.deepEqual([...url.searchParams], [['include[]', 'submission_history']]); data = own;
    } else if (url.pathname === '/files/7/download') return new Response('%PDF-one', { headers: { 'content-type': 'application/pdf', 'content-length': '8' } });
    else throw new Error('Unexpected synthetic school path');
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  for (const cookie of ['_canvas_session=synthetic', 'xn_api_token=synthetic', 'sToken=synthetic-private', 'sIdno=90000001'])
    await http.jar.setCookie(cookie + '; Secure; Path=/', origin);
  const client = new LearningxClient(http, { userId: '42', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  const reader = createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (state !== previous) return false; state = next; return true; } },
  key, async () => ({ client, serialize: () => http.jar.serialize() }), undefined, undefined, undefined, null);
  const provider = createLearningxReads(reader), options = { signal: new AbortController().signal, validate: async () => {} };
  return { reader, provider, options, calls, earlier, latest, setOwn: (value: unknown) => { own = value; },
    app: () => buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }),
      { getSession: async () => ({ user: { id: owner }, tokenHash: 'synthetic' }) } as unknown as Store, { ...unavailableSchoolProvider, ...provider }) };
}
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr' };
const path = '/v1/courses/10/assignments/90/submission-history';
test('pinned SDK own history and selected attempt bytes traverse authenticated Backend without grades or signed URLs', async () => {
  const f = await fixture(), app = await f.app();
  try {
    assert.equal(f.calls.length, 0);
    const response = await app.inject({ url: path, headers }); assert.equal(response.statusCode, 200);
    const value = response.json(); assert.equal(value.coverage, 'school_returned'); assert.equal(value.items.length, 2);
    assert.equal(value.items[0].attempt, 2); assert.deepEqual(value.items[0].content.url, { state: 'available', value: '' });
    assert.equal(value.items[0].workflowState, 'unsubmitted'); assert.equal(value.items[1].workflowState, 'unknown');
    assert.equal(value.items[1].attachments[0].downloadAvailable, true); assert.match(value.items[1].key, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(response.body, /private-|verifier|score|grade|user_id|90000001|a_[a-f0-9]{64}/);
    const historyReads = () => f.calls.filter(url => url.pathname.endsWith('/submissions/42')).length;
    const downloads = () => f.calls.filter(url => url.pathname.endsWith('/download')).length;
    const before = historyReads(), selected = path + '/' + value.items[1].key + '/files/7';
    const first = await app.inject({ url: selected, headers }); assert.equal(first.statusCode, 200); assert.equal(first.body, '%PDF-one');
    assert.equal(historyReads() - before, 2); assert.equal(downloads(), 1);
    const cached = await app.inject({ url: selected, headers }); assert.equal(cached.statusCode, 200); assert.equal(cached.body, '%PDF-one');
    assert.equal(historyReads() - before, 3); assert.equal(downloads(), 1);
    f.setOwn({ ...f.latest, submission_history: [f.latest] });
    const removed = await app.inject({ url: selected, headers }); assert.equal(removed.statusCode, 404); assert.doesNotMatch(removed.body, /%PDF-/);
    assert.equal(downloads(), 1); assert.equal(cached.headers['cache-control'], 'private, no-store');
  } finally { await app.close(); }
});
test('pinned SDK missing/null history remains distinct and a foreign history owner cannot become empty success', async () => {
  const f = await fixture();
  for (const [own, expected] of [[f.latest, 'missing'], [{ ...f.latest, submission_history: null }, 'null']] as const) {
    f.setOwn(own); const value = await f.provider.assignmentHistory!({ userId: 'synthetic-history-owner' }, '10', '90', { ...f.options, refresh: true });
    assert.equal(value.state, expected); assert.equal(value.items, null);
  }
  f.setOwn({ ...f.latest, submission_history: [{ ...f.earlier, user_id: 43 }] });
  await assert.rejects(f.provider.assignmentHistory!({ userId: 'synthetic-history-owner' }, '10', '90', { ...f.options, refresh: true }), { statusCode: 502 });
  assert.equal(f.calls.some(url => url.pathname.endsWith('/download')), false);
});
