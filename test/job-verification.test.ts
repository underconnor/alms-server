import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { Job, SchoolResult } from '../src/domain.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { AppError } from '../src/errors.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const headers = { accept: 'application/json; alms-playback=2', cookie: '__Host-alms_session=' + 'a'.repeat(43) };
const fresh = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 100, attendance: 'unknown', recognized: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let job: Job | null = { id: randomUUID(), userId: 'owner', courseId: '10', lectureId: '90', status: 'needs_verification',
    scheduledFor: '2099-10-01T00:00:00Z', createdAt: '2099-10-01T00:00:00Z', updatedAt: '2099-10-01T00:00:00Z',
    acceptedGeneration: randomUUID(), executionTokenHash: 'e'.repeat(64), executionOutcome: null, schoolResult: null, errorCode: 'WORKER_INTERRUPTED', idempotencyKey: randomUUID(), requestHash: 'private-hash' };
  const session = { tokenHash: 'session', user: { id: 'owner' } }; let authenticated = true, writes = 0;
  const store = { getSession: async () => authenticated ? session : null,
    getJob: async (owner: string, id: string) => job?.userId === owner && job.id === id ? structuredClone(job) : null,
    transitionJob: async () => { writes++; throw new Error('No job writes'); }, createJob: async () => { writes++; throw new Error('No job writes'); },
  } as unknown as Store;
  return { store, path: '/v1/jobs/' + job.id + '/verify', job: () => job, update: (change: Partial<Job>) => { job = { ...job!, ...change }; },
    remove: () => { job = null; }, logout: () => { authenticated = false; }, writes: () => writes };
}
test('job verification reads fresh school results without changing the saved job, enabling playback or disclosing private fields', async () => {
  const f = fixture(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (context, target) => {
    calls++; assert.deepEqual(context, { userId: 'owner' }); assert.deepEqual(target, { courseId: '10', lectureId: '90' }); return fresh();
  } });
  try {
    for (let i = 0; i < 2; i++) { const response = await app.inject({ url: f.path, headers }); assert.equal(response.statusCode, 200);
      const body = response.json(); assert.equal(body.stateChanged, false); assert.equal(body.job.status, 'needs_verification');
      assert.equal(body.job.schoolResult, null); assert.equal(body.schoolResult.recognized, null); assert.equal(body.schoolResult.progressPercent, 100);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.doesNotMatch(response.body, /private-hash|userId|idempotencyKey|acceptedGeneration|executionTokenHash/); }
    assert.equal(calls, 2); assert.equal(f.writes(), 0); assert.equal(f.job()?.status, 'needs_verification');
  } finally { await app.close(); }
});
test('verification requires auth, owned existing job, strict query and numeric school targets', async () => {
  const f = fixture(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; return fresh(); } });
  try {
    assert.equal((await app.inject(f.path)).statusCode, 401);
    assert.equal((await app.inject({ url: f.path + '?courseId=other', headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/v1/jobs/' + randomUUID() + '/verify', headers })).statusCode, 404);
    f.update({ userId: 'other' }); assert.equal((await app.inject({ url: f.path, headers })).statusCode, 404);
    f.update({ userId: 'owner', lectureId: 'unconfirmed:target' }); assert.equal((await app.inject({ url: f.path, headers })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: f.path, headers })).statusCode, 404);
    assert.equal(calls, 0); assert.equal(f.writes(), 0);
  } finally { await app.close(); }
});
test('missing learning-status provider and unsupported recognition never produce job success', async () => {
  for (const mode of ['missing', 'recognized', 'wrong-shape']) {
    const f = fixture(); const app = await buildApp(config, f.store, { ...unavailableSchoolProvider,
      ...(mode === 'missing' ? {} : { learningStatus: async () => ({ ...fresh(), ...(mode === 'recognized' ? { recognized: true } : { progressPercent: 101 }) }) }),
    });
    try { const response = await app.inject({ url: f.path, headers }); assert.equal(response.statusCode, mode === 'missing' ? 503 : 502);
      assert.equal(response.json().schoolResult, undefined); assert.equal(f.writes(), 0); assert.equal(f.job()?.status, 'needs_verification');
    } finally { await app.close(); }
  }
});
test('changed job owner, target, state, updatedAt or removal rejects a late school result', async () => {
  for (const mutation of ['owner', 'course', 'lecture', 'status', 'updatedAt', 'removed']) {
    const f = fixture(), wait = gate();
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { await wait.promise; return fresh(); } });
    try {
      const request = app.inject({ url: f.path, headers }); await flush();
      if (mutation === 'removed') f.remove();
      else f.update(mutation === 'owner' ? { userId: 'other' } : mutation === 'course' ? { courseId: '20' }
        : mutation === 'lecture' ? { lectureId: '91' } : mutation === 'status' ? { status: 'cancelled' } : { updatedAt: '2099-10-02T00:00:00Z' });
      wait.release(); const response = await request;
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'JOB_CHANGED'); assert.equal(f.writes(), 0);
    } finally { wait.release(); await app.close(); }
  }
});
test('logout while reading withholds the result and a concurrent same-owner verification does not duplicate school reads', async () => {
  const f = fixture(), wait = gate(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; await wait.promise; return fresh(); } });
  try {
    const first = app.inject({ url: f.path, headers }); await flush();
    const duplicate = await app.inject({ url: f.path, headers }); assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'JOB_VERIFICATION_BUSY'); assert.equal(calls, 1);
    f.logout(); wait.release(); const response = await first; assert.equal(response.statusCode, 401); assert.equal(f.writes(), 0);
  } finally { wait.release(); await app.close(); }
});
test('explicit repeated verification is fresh and rate limited without starting more school reads', async () => {
  const f = fixture(); let calls = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; return fresh(); } });
  try {
    for (let i = 0; i < 12; i++) assert.equal((await app.inject({ url: f.path, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: f.path, headers })).statusCode, 429); assert.equal(calls, 12); assert.equal(f.writes(), 0);
  } finally { await app.close(); }
});
test('the verification deadline bounds initial auth, job queries, provider and final checks', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 25 : ms));
  for (const at of ['auth', 'first_job', 'provider', 'last_job', 'last_auth']) {
    const f = fixture(), wait = gate(); let auth = 0, jobs = 0, signal: AbortSignal | undefined;
    const getSession = f.store.getSession.bind(f.store), getJob = f.store.getJob.bind(f.store);
    f.store.getSession = async token => { auth++; if (at === 'auth' && auth === 1 || at === 'last_auth' && auth === 3) await wait.promise; return getSession(token); };
    f.store.getJob = async (owner, id) => { jobs++; if (at === 'first_job' && jobs === 1 || at === 'last_job' && jobs === 2) await wait.promise; return getJob(owner, id); };
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (_context, _target, value) => {
      signal = value; if (at === 'provider') await wait.promise; return fresh();
    } });
    const alive = setTimeout(() => {}, 200);
    try { const response = await app.inject({ url: f.path, headers }); assert.equal(response.statusCode, 503, at);
      assert.equal(response.json().error.code, 'SCHOOL_RESULT_UNAVAILABLE'); if (signal) assert.equal(signal.aborted, true);
      wait.release(); await flush(); assert.equal(f.writes(), 0);
    } finally { wait.release(); clearTimeout(alive); await app.close(); }
  }
});
test('client abort cancels the read and does not publish a later response', async () => {
  const f = fixture(), wait = gate(); let received: AbortSignal | undefined, stop!: () => void;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async (_context, _target, signal) => { received = signal; await wait.promise; return fresh(); } });
  app.addHook('preHandler', async request => { stop = () => request.raw.emit('aborted'); });
  try { const reading = app.inject({ url: f.path, headers }); await flush(); stop(); const response = await reading;
    assert.equal(response.statusCode, 503); assert.equal(received?.aborted, true); wait.release(); await flush(); assert.equal(f.writes(), 0);
  } finally { wait.release(); await app.close(); }
});
test('a job changed during the final ALMS session read is compared again before publishing', async () => {
  const f = fixture(), getSession = f.store.getSession.bind(f.store); let checks = 0;
  f.store.getSession = async token => { if (++checks === 4) f.update({ status: 'cancelled' }); return getSession(token); };
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => fresh() });
  try { const response = await app.inject({ url: f.path, headers }); assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'JOB_CHANGED'); assert.equal(f.writes(), 0);
  } finally { await app.close(); }
});
test('database waits are capped independently of the full school read deadline', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 5_000 ? 20 : ms));
  const f = fixture(), wait = gate(), original = f.store.getJob.bind(f.store);
  f.store.getJob = async (...args) => { await wait.promise; return original(...args); };
  let calls = 0; const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => { calls++; return fresh(); } });
  const alive = setTimeout(() => {}, 100);
  try { const response = await app.inject({ url: f.path, headers }); assert.equal(response.statusCode, 503);
    wait.release(); await flush(); assert.equal(calls, 0); assert.equal(f.writes(), 0);
  } finally { clearTimeout(alive); wait.release(); await app.close(); }
});

test('job verification awaits its saved exact target cache refresh without changing the job result or status', async () => {
  const f = fixture(), held = gate(), entered = gate(), raw = { ...fresh(), progressPercent: null }; let resolved = false, refreshes = 0;
  const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => raw,
    refreshLearningStatus: async (context, target, result, options) => {
      refreshes++; assert.deepEqual(context, { userId: 'owner' }); assert.deepEqual(target, { courseId: '10', lectureId: '90' });
      assert.equal(result, raw); await options.validate(); entered.release(); await held.promise; await options.validate();
    },
  });
  try {
    const request = app.inject({ url: f.path, headers }).then(value => { resolved = true; return value; });
    await entered.promise; assert.equal(resolved, false); held.release(); const response = await request;
    assert.equal(response.statusCode, 200); assert.equal(refreshes, 1); assert.equal(response.json().stateChanged, false);
    assert.equal(response.json().schoolResult.recognized, null); assert.equal(response.json().job.schoolResult, null);
    assert.equal(response.json().job.status, 'needs_verification'); assert.equal(f.writes(), 0);
    assert.doesNotMatch(response.body, /generation|userId|private-hash|executionToken/);
  } finally { held.release(); await app.close(); }
});

test('failed or invalid job verification does not refresh caches; invalidation failure remains unconfirmed', async () => {
  for (const mode of ['read-error', 'invalid', 'changed', 'refresh-error']) {
    const f = fixture(); let refreshes = 0;
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider,
      learningStatus: async () => { if (mode === 'read-error') throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '조회 실패');
        if (mode === 'changed') f.update({ status: 'cancelled' });
        return { ...fresh(), ...(mode === 'invalid' ? { recognized: true as unknown as null } : {}) }; },
      refreshLearningStatus: async () => { refreshes++; throw new AppError(503, 'SCHOOL_RESULT_UNAVAILABLE', '갱신 실패'); },
    });
    try { const response = await app.inject({ url: f.path, headers });
      assert.equal(response.statusCode, mode === 'invalid' ? 502 : mode === 'changed' ? 409 : 503);
      assert.equal(response.json().schoolResult, undefined); assert.equal(refreshes, mode === 'refresh-error' ? 1 : 0);
      assert.equal(f.writes(), 0);
    } finally { await app.close(); }
  }
});

test('cache-refresh waits cannot publish a job changed or an ALMS session revoked during the wait', async () => {
  for (const mode of ['job', 'logout']) {
    const f = fixture(), held = gate(), entered = gate();
    const app = await buildApp(config, f.store, { ...unavailableSchoolProvider, learningStatus: async () => fresh(),
      refreshLearningStatus: async (_context, _target, _result, options) => { entered.release(); await held.promise; await options.validate(); },
    });
    try { const request = app.inject({ url: f.path, headers }); await entered.promise;
      if (mode === 'job') f.update({ lectureId: '91' }); else f.logout(); held.release();
      const response = await request; assert.equal(response.statusCode, mode === 'job' ? 409 : 401);
      assert.equal(response.json().schoolResult, undefined); assert.equal(f.writes(), 0);
    } finally { held.release(); await app.close(); }
  }
});
