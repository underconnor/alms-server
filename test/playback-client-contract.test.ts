import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken, type Store } from '../src/store.js';
import { createPlaybackAdmission } from '../src/playback-authority.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import type { Job } from '../src/domain.js';
import type { SchoolProvider } from '../src/provider.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const token = 'a'.repeat(43), owner = 'synthetic-owner';
const headers = { cookie: '__Host-alms_session=' + token, origin: 'https://lms.flyjung.kr',
  'x-csrf-token': 'synthetic-csrf', 'idempotency-key': randomUUID() };
function fixture(enabled: boolean, admitted: boolean) {
  const job: Job = { id: randomUUID(), userId: owner, courseId: '10', lectureId: '20', status: 'running',
    scheduledFor: null, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z',
    schoolResult: null, errorCode: null, idempotencyKey: randomUUID(), requestHash: 'private-hash',
    acceptedGeneration: admitted ? randomUUID() : null, executionTokenHash: admitted ? 'a'.repeat(64) : null, executionOutcome: null };
  let schoolReads = 0, jobWrites = 0, authenticated = true;
  const store = {
    getSession: async () => authenticated ? { tokenHash: hashToken(token), csrfToken: headers['x-csrf-token'], user: { id: owner } } : null,
    listJobs: async (user: string, courseId?: string) => user === owner && (!courseId || courseId === job.courseId) ? [{ ...job }] : [],
    getJob: async (user: string, id: string) => user === job.userId && id === job.id ? { ...job } : null,
    findJobRequest: async () => null,
    createJob: async () => { jobWrites++; return { ...job, status: 'queued' }; },
    cancelJob: async () => { jobWrites++; return { ...job, status: 'cancel_requested' }; },
  } as unknown as Store;
  const provider: SchoolProvider = { capabilities: { schoolAuthentication: false, schoolRead: true, playback: enabled, pauseResume: false },
    authorizePlayback: async (context, target) => {
      schoolReads++;
      return createPlaybackAdmission({ userId: context.userId, ...target }, { generation: randomUUID(), encryptedSession: 'synthetic-seal' });
    },
    learningStatus: async () => { schoolReads++; return { observedAt: new Date().toISOString(), progressPercent: 100, attendance: 'unknown', recognized: null }; },
  };
  return { job, store, provider, logout: () => { authenticated = false; }, counts: () => ({ schoolReads, jobWrites }) };
}
const actions = (id: string) => [
  { method: 'GET' as const, url: '/v1/jobs' },
  { method: 'GET' as const, url: '/v1/jobs?courseId=10' },
  { method: 'GET' as const, url: '/v1/jobs/' + id },
  { method: 'GET' as const, url: '/v1/jobs/' + id + '/verify' },
  ...['cancel', 'pause', 'resume'].map(action => ({ method: 'POST' as const, url: '/v1/jobs/' + id + '/' + action })),
];

for (const enabled of [true, false]) {
  test(`old clients cannot read or control admitted jobs when playback is ${enabled ? 'enabled' : 'disabled'}`, async () => {
    const f = fixture(enabled, true), app = await buildApp(config, f.store, f.provider, undefined, undefined, { isReady: async () => true });
    try {
      for (const accept of [undefined, 'application/json', 'application/json; alms-playback=1', 'application/json; alms-manual-video=untracked', 'application/json; alms-playback=2, */*']) {
        for (const action of actions(f.job.id)) {
          const response = await app.inject({ ...action, headers: { ...headers, ...(accept === undefined ? {} : { accept }) } });
          assert.equal(response.statusCode, 409, `${action.method} ${accept}`);
          assert.equal(response.json().error.code, 'CLIENT_UPDATE_REQUIRED');
          assert.match(response.json().error.message, /새로고침/);
          assert.equal(response.json().items, undefined); assert.equal(response.json().schoolResult, undefined);
          assert.doesNotMatch(response.body, /acceptedGeneration|executionTokenHash|private-hash/);
        }
      }
      assert.deepEqual(f.counts(), { schoolReads: 0, jobWrites: 0 });
    } finally { await app.close(); }
  });
}

test('enabled playback rejects old job admission before school preparation or DB writes', async () => {
  const f = fixture(true, false), app = await buildApp(config, f.store, f.provider, undefined, undefined, { isReady: async () => true });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'CLIENT_UPDATE_REQUIRED');
    assert.deepEqual(f.counts(), { schoolReads: 0, jobWrites: 0 });
    for (const action of actions(f.job.id)) {
      const blocked = await app.inject({ ...action, headers });
      assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().error.code, 'CLIENT_UPDATE_REQUIRED');
    }
    assert.deepEqual(f.counts(), { schoolReads: 0, jobWrites: 0 });
  } finally { await app.close(); }
});

test('new clients preserve completed as a separate state and retain normal admission, cancellation and verification', async () => {
  const f = fixture(true, true), app = await buildApp(config, f.store, f.provider, undefined, undefined, { isReady: async () => true }), modern = { ...headers, accept: playbackClientAccept };
  try {
    f.job.status = 'completed'; f.job.executionOutcome = 'ended';
    for (const path of ['/v1/jobs', '/v1/jobs/' + f.job.id, '/v1/jobs/' + f.job.id + '/verify']) {
      const response = await app.inject({ url: path, headers: modern });
      assert.equal(response.statusCode, 200);
      const body = response.json(), value = body.items?.[0] ?? body.job ?? body;
      assert.equal(value.status, 'completed'); assert.equal(value.executionOutcome, 'ended');
      assert.doesNotMatch(response.body, /acceptedGeneration|executionTokenHash|private-hash/);
    }
    f.job.status = 'running';
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs/' + f.job.id + '/cancel', headers: modern })).statusCode, 200);
    for (const action of ['pause', 'resume']) {
      const response = await app.inject({ method: 'POST', url: '/v1/jobs/' + f.job.id + '/' + action, headers: modern });
      assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_CONTROL_UNAVAILABLE');
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: modern, payload: { courseId: '10', lectureId: '20' } })).statusCode, 202);
    assert.deepEqual(f.counts(), { schoolReads: 2, jobWrites: 2 });
  } finally { await app.close(); }
});

test('disabled playback keeps legacy-only reads and controls compatible without a new contract', async () => {
  const f = fixture(false, false), app = await buildApp(config, f.store, f.provider, undefined, undefined, { isReady: async () => true });
  try {
    for (const action of actions(f.job.id)) {
      const response = await app.inject({ ...action, headers });
      assert.equal(response.statusCode, /\/(pause|resume)$/.test(action.url) ? 503 : 200);
      assert.notEqual(response.json().error?.code, 'CLIENT_UPDATE_REQUIRED');
    }
    const create = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
    assert.equal(create.statusCode, 503); assert.equal(create.json().error.code, 'PLAYBACK_UNAVAILABLE');
    assert.deepEqual(f.counts(), { schoolReads: 1, jobWrites: 1 });
  } finally { await app.close(); }
});

test('contract declaration never bypasses authentication, CSRF, target ownership or unrelated routes', async () => {
  const f = fixture(true, true), app = await buildApp(config, f.store, f.provider, undefined, undefined, { isReady: async () => true });
  try {
    assert.equal((await app.inject('/v1/jobs')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs/' + f.job.id + '/cancel', headers: { ...headers, 'x-csrf-token': 'wrong' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/jobs/' + randomUUID(), headers })).statusCode, 404);
    f.job.userId = 'another-owner';
    assert.equal((await app.inject({ url: '/v1/jobs/' + f.job.id + '/verify', headers })).statusCode, 404);
    assert.equal((await app.inject({ url: '/v1/me', headers })).statusCode, 200);
    f.logout();
    assert.equal((await app.inject({ url: '/v1/jobs', headers: { ...headers, accept: playbackClientAccept } })).statusCode, 401);
    assert.deepEqual(f.counts(), { schoolReads: 0, jobWrites: 0 });
  } finally { await app.close(); }
});
