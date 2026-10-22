import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken, type Store } from '../src/store.js';
import { createPlaybackAdmission } from '../src/playback-authority.js';
import type { SchoolProvider } from '../src/provider.js';
import type { PlaybackReadinessReader } from '../src/playback-worker-readiness.js';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const token = 'r'.repeat(43), userId = randomUUID(), generation = randomUUID();
const headers = { accept: 'application/json; alms-playback=2', cookie: '__Host-alms_session=' + token, origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic', 'idempotency-key': randomUUID() };
function fixture() {
  let school = 0, writes = 0, ready = true, reads = 0, job: any = null;
  const store = { health: async () => {}, getSession: async () => ({ tokenHash: hashToken(token), csrfToken: 'synthetic', user: { id: userId } }),
    findJobRequest: async () => job, createJob: async (_owner, input) => { writes++; return job = { ...input, id: randomUUID(), userId, status: 'queued', schoolResult: null, errorCode: null }; },
    getJob: async () => job, cancelJob: async () => ({ ...job, status: 'cancelled' }), listJobs: async () => ({ items: job ? [job] : [], nextCursor: null }),
  } as Store;
  const provider: SchoolProvider = { capabilities: { schoolAuthentication: false, schoolRead: false, playback: true, pauseResume: false },
    authorizePlayback: async (context, target) => { school++; return createPlaybackAdmission({ userId: context.userId, ...target }, { generation, encryptedSession: 'synthetic-private' }); },
  };
  const readiness: PlaybackReadinessReader = { isReady: async () => { reads++; return ready; } };
  return { store, provider, readiness, setReady: (value: boolean) => { ready = value; }, counts: () => ({ school, writes, reads }) };
}
test('missing/expired/error readiness disables /me and reports unavailable while healthy API readyz stays 200', async () => {
  for (const mode of ['missing', 'expired', 'error'] as const) {
    const f = fixture(); f.setReady(false); if (mode === 'error') f.readiness.isReady = async () => { throw Error('private-marker'); };
    const app = await buildApp(config, f.store, f.provider, undefined, undefined, mode === 'missing' ? undefined : f.readiness);
    try {
      const me = await app.inject({ url: '/v1/me', headers }), ready = await app.inject('/readyz');
      assert.equal(me.statusCode, 200); assert.equal(me.json().capabilities.playback, false);
      assert.equal(ready.statusCode, 200); assert.equal(ready.json().status, 'ready'); assert.equal(ready.json().playback.state, 'unavailable');
      assert.doesNotMatch(me.body + ready.body, /private-marker|sdkSha256|instance_id|backend_commit/);
      const post = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
      assert.equal(post.statusCode, 503); assert.equal(post.json().error.code, 'PLAYBACK_UNAVAILABLE');
      assert.equal(f.counts().school, 0); assert.equal(f.counts().writes, 0);
    } finally { await app.close(); }
  }
});
test('ready worker permits admission with two fresh checks; replay and cancellation remain available after worker stops', async () => {
  const f = fixture(), app = await buildApp(config, f.store, f.provider, undefined, undefined, f.readiness);
  try {
    const post = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
    assert.equal(post.statusCode, 202); assert.deepEqual(f.counts(), { school: 1, writes: 1, reads: 2 });
    f.setReady(false);
    const replay = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().id, post.json().id);
    const cancel = await app.inject({ method: 'POST', url: `/v1/jobs/${post.json().id}/cancel`, headers });
    assert.equal(cancel.json().status, 'cancelled'); assert.deepEqual(f.counts(), { school: 1, writes: 1, reads: 2 });
  } finally { await app.close(); }
});
test('worker expiry during fresh school preparation prevents all job writes', async () => {
  const f = fixture(), authorize = f.provider.authorizePlayback!;
  f.provider.authorizePlayback = async (...args) => { const proof = await authorize(...args); f.setReady(false); return proof; };
  const app = await buildApp(config, f.store, f.provider, undefined, undefined, f.readiness);
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { courseId: '10', lectureId: '20' } });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_UNAVAILABLE');
    assert.deepEqual(f.counts(), { school: 1, writes: 0, reads: 2 });
  } finally { await app.close(); }
});
test('disabled provider does not query heartbeat and auth/CSRF/old-client denial precede readiness', async () => {
  const f = fixture(), app = await buildApp(config, f.store, f.provider, undefined, undefined, f.readiness);
  try {
    for (const [h, status] of [[{}, 401], [{ ...headers, 'x-csrf-token': 'wrong' }, 403], [{ ...headers, accept: 'application/json' }, 409]] as const)
      assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs', headers: h, payload: { courseId: '10', lectureId: '20' } })).statusCode, status);
    f.provider.capabilities.playback = false;
    assert.equal((await app.inject({ url: '/v1/me', headers })).json().capabilities.playback, false);
    assert.equal((await app.inject('/readyz')).json().playback.state, 'disabled');
    assert.deepEqual(f.counts(), { school: 0, writes: 0, reads: 0 });
  } finally { await app.close(); }
});
