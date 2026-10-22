import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Job, SchoolResult } from '../src/domain.js';
import type { Store } from '../src/store.js';
import type { SchoolProvider } from '../src/provider.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { createPlaybackAdmission } from '../src/playback-authority.js';
import { AppError } from '../src/errors.js';

const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const headers = { origin: config.frontendOrigin, 'x-csrf-token': 'synthetic-csrf',
  accept: 'application/json; alms-playback=2', cookie: '__Host-alms_session=' + 'a'.repeat(43) };
const fresh = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 5.7, attendance: 'unknown', recognized: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const owner = randomUUID(); let generation = randomUUID(), authenticated = true, writes = 0, reads = 0, admissions = 0;
  let job: Job = { id: randomUUID(), userId: owner, courseId: '10', lectureId: '20', status: 'needs_verification',
    scheduledFor: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00.123Z',
    acceptedGeneration: randomUUID(), executionTokenHash: null, executionOutcome: 'interrupted', schoolResult: null,
    errorCode: 'PLAYBACK_REPORT_UNKNOWN', idempotencyKey: randomUUID(), requestHash: 'private-hash', settledAt: null, settlement: null,
    recovery: { eligible: true, reason: 'eligible', version: '2026-10-01T00:00:00.123456Z' } };
  const session = { tokenHash: 'synthetic-session', csrfToken: headers['x-csrf-token'], user: { id: owner } };
  const store = { getSession: async () => authenticated ? session : null,
    getJob: async (userId: string, id: string) => userId === owner && id === job.id ? structuredClone(job) : null,
    settleJob: async (userId: string, id: string, version: string, authorization: any) => {
      writes++; assert.equal(userId, owner); assert.equal(id, job.id); assert.equal(authorization.tokenHash, session.tokenHash);
      assert.equal(authorization.csrfToken, session.csrfToken);
      if (version !== job.recovery?.version) throw new AppError(409, 'JOB_CHANGED', 'synthetic changed');
      if (!authenticated) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic logout');
      const settledAt = '2026-10-13T00:00:00.000Z'; job = { ...job, settledAt,
        settlement: { settledAt, schoolResult: authorization.schoolResult }, recovery: { ...job.recovery!, eligible: false, reason: 'already_settled' } };
      return structuredClone(job);
    },
    createJob: async () => assert.fail('No playback admission'), transitionJob: async () => assert.fail('No job state transition'),
  } as unknown as Store;
  const provider: SchoolProvider = { ...unavailableSchoolProvider,
    authorizePlayback: async (context, target, options) => { admissions++; assert.deepEqual(context, { userId: owner });
      assert.deepEqual(target, { courseId: job.courseId, lectureId: job.lectureId }); await options.validate();
      return createPlaybackAdmission({ userId: owner, ...target }, { generation, encryptedSession: 'synthetic-current-seal' }); },
    learningStatus: async () => { reads++; return fresh(); },
    preparePlayback: async () => assert.fail('No playback'),
  };
  return { store, provider, path: '/v1/jobs/' + job.id + '/settle', job: () => job,
    payload: () => ({ expectedUpdatedAt: job.recovery!.version, confirmed: true }),
    update: (change: Partial<Job>) => { job = { ...job, ...change }; }, logout: () => { authenticated = false; },
    rotate: () => { generation = randomUUID(); }, counts: () => ({ writes, reads, admissions }) };
}
test('explicit settlement preserves original failure and publishes separate normalized evidence with no playback', async () => {
  const f = fixture(), original = structuredClone(f.job()); const app = await buildApp(config, f.store, f.provider);
  try {
    const response = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); assert.equal(response.statusCode, 200);
    const body = response.json(); assert.equal(body.settlementRecorded, true); assert.equal(body.stateChanged, false);
    for (const key of ['id', 'courseId', 'lectureId', 'status', 'updatedAt', 'schoolResult', 'errorCode', 'executionOutcome']) assert.deepEqual(body.job[key], (original as any)[key]);
    assert.equal(body.job.settlement.schoolResult.recognized, null); assert.equal(body.job.settlement.schoolResult.progressPercent, 5.7);
    assert.equal(body.job.recovery.reason, 'already_settled'); assert.equal(body.job.settledAt, body.job.settlement.settledAt);
    assert.deepEqual(f.counts(), { writes: 1, reads: 1, admissions: 2 }); assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /private-hash|userId|acceptedGeneration|executionToken|current_generation|synthetic-current-seal/);
  } finally { await app.close(); }
});
test('settlement requires fresh auth, Origin, CSRF, exact microsecond version and explicit confirmation', async () => {
  const f = fixture(), app = await buildApp(config, f.store, f.provider);
  try {
    for (const request of [
      { headers: undefined, payload: f.payload(), status: 401 },
      { headers: { ...headers, origin: 'https://other.invalid' }, payload: f.payload(), status: 403 },
      { headers: { ...headers, 'x-csrf-token': 'wrong' }, payload: f.payload(), status: 403 },
      { headers, payload: { ...f.payload(), confirmed: false }, status: 400 },
      { headers, payload: { ...f.payload(), expectedUpdatedAt: f.job().updatedAt }, status: 409 },
      { headers, payload: { ...f.payload(), arbitrary: true }, status: 400 },
    ]) assert.equal((await app.inject({ method: 'POST', url: f.path, headers: request.headers, payload: request.payload })).statusCode, request.status);
    assert.equal((await app.inject({ method: 'POST', url: f.path + '?force=true', headers, payload: f.payload() })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/jobs/' + randomUUID() + '/settle', headers, payload: f.payload() })).statusCode, 404);
    assert.deepEqual(f.counts(), { writes: 0, reads: 0, admissions: 0 });
  } finally { await app.close(); }
});
test('unsafe or unsupported settlement cannot start a school read or fabricate old termination evidence', async () => {
  for (const reason of ['termination_unconfirmed', 'execution_active', 'lease_active', 'not_interrupted'] as const) {
    const f = fixture(); f.update({ recovery: { ...f.job().recovery!, eligible: false, reason } }); const app = await buildApp(config, f.store, f.provider);
    try { const response = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() });
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'JOB_SETTLEMENT_UNSAFE'); assert.deepEqual(f.counts(), { writes: 0, reads: 0, admissions: 0 });
    } finally { await app.close(); }
  }
  const f = fixture(); delete f.store.settleJob; const app = await buildApp(config, f.store, f.provider);
  try { const response = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); assert.equal(response.statusCode, 503); assert.equal(f.counts().reads, 0); }
  finally { await app.close(); }
});
test('logout, school generation replacement and CAS changes while reading prevent settlement', async () => {
  for (const mode of ['logout', 'generation', 'version'] as const) {
    const f = fixture(), hold = gate(), entered = gate();
    f.provider.learningStatus = async () => { entered.release(); await hold.promise; return fresh(); };
    const app = await buildApp(config, f.store, f.provider);
    try { const request = app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); await entered.promise;
      if (mode === 'logout') f.logout(); else if (mode === 'generation') f.rotate(); else f.update({ recovery: { ...f.job().recovery!, version: '2026-10-01T00:00:00.123457Z' } });
      hold.release(); const response = await request; assert.equal(response.statusCode, mode === 'logout' ? 401 : 409);
      assert.equal(response.json().error.code, mode === 'logout' ? 'AUTH_REQUIRED' : mode === 'generation' ? 'PLAYBACK_AUTHORITY_CHANGED' : 'JOB_CHANGED');
      assert.equal(f.job().settledAt, null); assert.equal(f.counts().writes, mode === 'version' ? 1 : 0);
    } finally { hold.release(); await app.close(); }
  }
});
test('concurrent same-owner confirmation makes one fresh school read and preserves the active operation', async () => {
  const f = fixture(), hold = gate(), entered = gate(); let calls = 0;
  f.provider.learningStatus = async () => { calls++; entered.release(); await hold.promise; return fresh(); };
  const app = await buildApp(config, f.store, f.provider);
  try { const first = app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); await entered.promise;
    const second = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'JOB_SETTLEMENT_BUSY'); assert.equal(calls, 1); hold.release(); assert.equal((await first).statusCode, 200); assert.equal(f.counts().writes, 1);
  } finally { hold.release(); await app.close(); }
});
test('school errors and invalid recognition preserve failure rather than becoming a successful job', async () => {
  for (const mode of ['auth', 'permission', 'invalid'] as const) {
    const f = fixture(); f.provider.learningStatus = async () => {
      if (mode === 'auth') throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', 'synthetic school logout');
      if (mode === 'permission') throw new AppError(403, 'SCHOOL_PERMISSION_DENIED', 'synthetic school permission');
      return { ...fresh(), recognized: true }; };
    const app = await buildApp(config, f.store, f.provider);
    try { const response = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() });
      assert.equal(response.statusCode, mode === 'auth' ? 401 : mode === 'permission' ? 403 : 502); assert.equal(f.counts().writes, 0); assert.equal(f.job().status, 'needs_verification');
    } finally { await app.close(); }
  }
});
test('client abort fences late provider completion without a DB write', async () => {
  const f = fixture(), hold = gate(), entered = gate(); let received: AbortSignal | undefined, abort!: () => void;
  f.provider.learningStatus = async (_context, _target, signal) => { received = signal; entered.release(); await hold.promise; return fresh(); };
  const app = await buildApp(config, f.store, f.provider); app.addHook('preHandler', async request => { abort = () => request.raw.emit('aborted'); });
  try { const request = app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); await entered.promise; abort();
    const response = await request; assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'JOB_SETTLEMENT_UNCONFIRMED'); assert.equal(received?.aborted, true);
    hold.release(); await flush(); assert.equal(f.counts().writes, 0); assert.equal(f.job().settledAt, null);
  } finally { hold.release(); await app.close(); }
});
test('uncertain database outcome instructs readback and does not retry the settlement write', async () => {
  const f = fixture(); let writes = 0; f.store.settleJob = async () => { writes++; throw new Error('synthetic unknown commit outcome'); };
  const app = await buildApp(config, f.store, f.provider);
  try { const response = await app.inject({ method: 'POST', url: f.path, headers, payload: f.payload() }); assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'JOB_SETTLEMENT_UNCONFIRMED'); assert.equal(writes, 1); await flush(); assert.equal(writes, 1); assert.equal(f.job().status, 'needs_verification');
  } finally { await app.close(); }
});
