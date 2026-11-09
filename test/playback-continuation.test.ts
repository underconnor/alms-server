import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { createPlaybackAdmission, inspectPlaybackAdmission } from '../src/playback-authority.js';
import { hashToken, type Store, type JobContinuationResult } from '../src/store.js';
import type { Job, Session, SchoolResult } from '../src/domain.js';
import type { SchoolProvider } from '../src/provider.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { withPlaybackContinuationState } from '../src/playback-auth-wait.js';

const token = 'a'.repeat(43), baseHeaders = { cookie: '__Host-alms_session=' + token, origin: 'https://lms.flyjung.kr', accept: playbackClientAccept, 'x-csrf-token': 'synthetic-csrf' };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const copy = <T>(value: T): T => structuredClone(value);
function fixture() {
  const owner = randomUUID(), key = randomBytes(32), oldGeneration = randomUUID(); let generation = randomUUID(), ready = true, active = true;
  const id = randomUUID(), now = new Date().toISOString();
  const original: Job = { id, userId: owner, courseId: '10', lectureId: '20', status: 'queued', scheduledFor: now, createdAt: now, updatedAt: now,
    schoolResult: null, errorCode: null, executionOutcome: null, acceptedGeneration: oldGeneration, executionTokenHash: null,
    idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-original'), authenticationContinuationEligible: true,
    authWait: { waitingSince: now, reason: 'school_auth_required', canContinue: false, continuedAsJobId: null } };
  const jobs = new Map([[id, original]]), accepted = new Map<string, { requestHash: string; result: JobContinuationResult }>();
  const session: Session = { tokenHash: hashToken(token), csrfToken: baseHeaders['x-csrf-token'], clientId: null, analyticsSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: { id: owner, displayName: '합성 사용자', analyticsId: randomUUID(), analyticsEnabled: false } };
  let authorizations = 0, statusReads = 0, writes = 0, schoolCompleted = false;
  let onAuthorize = async () => {}, onStatus = async () => {}, afterCommit = async () => {};
  const schoolResult = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 0, attendance: 'unknown', recognized: null,
    evidence: { resourceType: 'movie', published: true, opened: true, useAttendance: true, omitProgress: false,
      completed: schoolCompleted, schoolAttendanceStatus: schoolCompleted ? 'attendance' : 'none', durationSeconds: 60, progressSeconds: 0, lastPositionSeconds: 0 } });
  const store = {
    getSession: async () => active ? copy(session) : null,
    getEncryptedSchoolSession: async (provided: string) => provided === owner ? encryptSchoolSession({ version: 1, generation, lmsExchange: { status: ready ? 'ready' : 'failed' }, jar: {} }, key, owner, 'ssu') : null,
    listJobs: async (provided: string) => provided === owner ? [...jobs.values()].map(copy) : [],
    getJob: async (provided: string, jobId: string) => provided === owner && jobs.has(jobId) ? copy(jobs.get(jobId)!) : null,
    findJobContinuation: async (_user: string, parent: string, idem: string, requestHash: string) => {
      const prior = accepted.get(idem); if (!prior) return null;
      if (prior.requestHash !== requestHash || prior.result.originalJob.id !== parent) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'fixed');
      return { originalJob: copy(jobs.get(id)!), job: copy(jobs.get(prior.result.job.id)!), continued: true as const };
    },
    continueJob: async (userId, parent, idem, requestHash, authorization) => {
      const admission = inspectPlaybackAdmission(authorization.admission, { userId, courseId: '10', lectureId: '20' });
      assert.equal(admission.generation, generation); assert.equal(authorization.csrfToken, session.csrfToken); assert.equal(authorization.clientId, session.clientId);
      assert.equal(authorization.almsTokenHash, session.tokenHash); assert.equal(parent, id);
      if (original.authWait?.continuedAsJobId) throw new AppError(409, 'PLAYBACK_ALREADY_CONTINUED', 'fixed');
      writes++;
      const child: Job = { ...copy(original), id: randomUUID(), status: 'queued', acceptedGeneration: generation, authWait: null,
        authenticationContinuationEligible: false, idempotencyKey: idem, requestHash };
      original.status = 'cancelled'; original.errorCode = 'PLAYBACK_CONTINUED'; original.authenticationContinuationEligible = false;
      original.authWait!.continuedAsJobId = child.id; original.authWait!.canContinue = false;
      jobs.set(child.id, child); const result = { originalJob: copy(original), job: copy(child), continued: true as const }; accepted.set(idem, { requestHash, result });
      await afterCommit(); return result;
    },
  } as Store;
  const provider: SchoolProvider = { capabilities: { schoolAuthentication: true, schoolRead: true, playback: true, pauseResume: false },
    learningStatus: async () => { statusReads++; await onStatus(); return schoolResult(); },
    authorizePlayback: async (context, target, options) => { authorizations++; await onAuthorize(); await options.validate(); options.signal.throwIfAborted();
      return createPlaybackAdmission({ userId: context.userId, ...target }, { generation, encryptedSession: 'synthetic-new-seal' }); },
  };
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent', SESSION_ENCRYPTION_KEY: key.toString('base64') });
  return { owner, key, original, store, provider, jobs, session, oldGeneration, config,
    headers: () => ({ ...baseHeaders, 'idempotency-key': randomUUID() }), url: '/v1/jobs/' + id + '/continue',
    app: () => buildApp(config, store, provider, undefined, undefined, { isReady: async () => true }),
    logout: () => { active = false; }, setGeneration: (v: string) => { generation = v; }, setReady: (v: boolean) => { ready = v; },
    completeSchool: () => { schoolCompleted = true; }, onAuthorize: (v: typeof onAuthorize) => { onAuthorize = v; }, onStatus: (v: typeof onStatus) => { onStatus = v; },
    afterCommit: (v: typeof afterCommit) => { afterCommit = v; }, counts: () => ({ authorizations, statusReads, writes }) };
}

test('continue uses a fresh native admission, retains the old generation and returns a durable same-key child in any status', async () => {
  const f = fixture(), app = await f.app(), headers = f.headers();
  try {
    const before = await app.inject({ method: 'GET', url: '/v1/jobs/' + f.original.id, headers }); assert.equal(before.json().authWait.canContinue, true);
    const accepted = await app.inject({ method: 'POST', url: f.url, headers, payload: {} }); assert.equal(accepted.statusCode, 202);
    const value = accepted.json(); assert.equal(value.continued, true); assert.equal(value.originalJob.status, 'cancelled');
    assert.equal(value.originalJob.authWait.continuedAsJobId, value.job.id); assert.equal(f.original.acceptedGeneration, f.oldGeneration);
    f.jobs.get(value.job.id)!.status = 'completed';
    const replay = await app.inject({ method: 'POST', url: f.url, headers, payload: {} }); assert.equal(replay.statusCode, 202); assert.equal(replay.json().job.id, value.job.id); assert.equal(replay.json().job.status, 'completed');
    assert.deepEqual(f.counts(), { authorizations: 1, statusReads: 1, writes: 1 });
    assert.doesNotMatch(accepted.body, /acceptedGeneration|executionTokenHash|authenticationContinuationEligible|synthetic-new-seal|csrf|tokenHash|userId/);
  } finally { await app.close(); }
});
test('school authentication must be newly refreshed; known unstarted eligibility alone never enables continue', async () => {
  for (const mode of ['old','not-ready'] as const) {
    const f = fixture(); if (mode === 'old') f.setGeneration(f.oldGeneration); else f.setReady(false); const app = await f.app();
    try {
      const view = await app.inject({ method: 'GET', url: '/v1/jobs/' + f.original.id, headers: f.headers() }); assert.equal(view.json().authWait.canContinue, false);
      const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PLAYBACK_REAUTHENTICATION_REQUIRED');
      assert.deepEqual(f.counts(), { authorizations: 0, statusReads: 0, writes: 0 }); assert.equal(f.original.status, 'queued');
    } finally { await app.close(); }
  }
});
test('missing marker, unknown/interrupted history and another owner never reach school admission', async () => {
  for (const mode of ['unmarked','unsafe','foreign'] as const) {
    const f = fixture(); if (mode === 'unmarked') f.original.authWait = null; if (mode === 'unsafe') { f.original.authenticationContinuationEligible = false; f.original.executionOutcome = 'interrupted'; }
    const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: mode === 'foreign' ? '/v1/jobs/' + randomUUID() + '/continue' : f.url, headers: f.headers(), payload: {} });
      assert.equal(response.statusCode, mode === 'foreign' ? 404 : 409); assert.equal(f.counts().authorizations, 0); assert.equal(f.counts().writes, 0);
    } finally { await app.close(); }
  }
});
test('existing CSRF, exact registered origin/client, playback Accept, UUID key and strict body remain mandatory', async () => {
  for (const mode of ['csrf','origin','client','accept','key','body'] as const) {
    const f = fixture(), app = await f.app(), headers: Record<string, string> = f.headers();
    if (mode === 'csrf') headers['x-csrf-token'] = 'wrong'; if (mode === 'origin') headers.origin = 'https://wrong.invalid';
    if (mode === 'client') headers['x-alms-client-id'] = 'unregistered'; if (mode === 'accept') headers.accept = 'application/json'; if (mode === 'key') headers['idempotency-key'] = 'invalid';
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers, payload: mode === 'body' ? { acceptedGeneration: randomUUID() } : {} });
      assert.equal(response.statusCode, { csrf: 403, origin: 403, client: 401, accept: 409, key: 400, body: 400 }[mode], mode + ':' + response.body); assert.deepEqual(f.counts(), { authorizations: 0, statusReads: 0, writes: 0 });
    } finally { await app.close(); }
  }
});
test('already school-completed material is excluded and logout or a newer concurrent login withholds continuation', async () => {
  for (const mode of ['completed','logout','generation'] as const) {
    const f = fixture(); if (mode === 'completed') f.completeSchool(); if (mode === 'logout') f.onStatus(async () => f.logout()); if (mode === 'generation') f.onAuthorize(async () => f.setGeneration(randomUUID()));
    const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); assert.equal(response.statusCode, mode === 'logout' ? 401 : 409);
      assert.equal(f.counts().writes, 0); assert.equal(f.original.status, 'queued');
    } finally { await app.close(); }
  }
});
test('an ambiguous committed response is resolved by GET original pointer and exact child; no replacement key or second child', async () => {
  const f = fixture(), app = await f.app(), headers = f.headers(); f.afterCommit(async () => { throw new Error('synthetic response loss'); });
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers, payload: {} }); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_CONTINUATION_UNCONFIRMED');
    const old = await app.inject({ method: 'GET', url: '/v1/jobs/' + f.original.id, headers }); const childId = old.json().authWait.continuedAsJobId; assert.ok(childId);
    const child = await app.inject({ method: 'GET', url: '/v1/jobs/' + childId, headers }); assert.equal(child.json().courseId, f.original.courseId); assert.equal(child.json().lectureId, f.original.lectureId);
    const same = await app.inject({ method: 'POST', url: f.url, headers, payload: {} }); assert.equal(same.statusCode, 202); assert.equal(same.json().job.id, childId);
    const different = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); assert.equal(different.statusCode, 409); assert.equal(different.json().error.code, 'PLAYBACK_ALREADY_CONTINUED');
    assert.equal(f.counts().writes, 1); assert.equal(f.counts().authorizations, 1);
    f.logout(); const revokedReplay = await app.inject({ method: 'POST', url: f.url, headers, payload: {} }); assert.equal(revokedReplay.statusCode, 401);
  } finally { await app.close(); }
});
test('concurrent explicit requests do not start a second admission while the old intent is still in flight', async () => {
  const f = fixture(), wait = deferred(), entered = deferred(), app = await f.app(); f.onAuthorize(async () => { entered.release(); await wait.promise; });
  try {
    const first = app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); await entered.promise;
    const second = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); assert.equal(second.statusCode, 409); assert.equal(second.json().error.code, 'PLAYBACK_CONTINUATION_BUSY');
    wait.release(); assert.equal((await first).statusCode, 202); assert.equal(f.counts().authorizations, 1); assert.equal(f.counts().writes, 1);
  } finally { wait.release(); await app.close(); }
});
test('deadline cancellation after slow native admission never reaches the continuation transaction', async t => {
  const timeout = globalThis.setTimeout; t.mock.method(globalThis, 'setTimeout', ((fn: any, ms?: number, ...args: any[]) => timeout(fn, ms === 90_000 ? 20 : ms, ...args)) as typeof setTimeout);
  const f = fixture(), wait = deferred(), app = await f.app(); f.onAuthorize(async () => { await wait.promise; });
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} }); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_CONTINUATION_UNCONFIRMED');
    wait.release(); await new Promise(r => setImmediate(r)); assert.equal(f.counts().writes, 0); assert.equal(f.original.status, 'queued');
  } finally { wait.release(); await app.close(); }
});
test('display eligibility is owner scoped and rejects malformed or failed SSO seals', async () => {
  const f = fixture(); const view = await withPlaybackContinuationState(f.store, f.key, 'another-owner', [f.original]); assert.equal(view[0]!.authWait!.canContinue, false);
  assert.equal((await withPlaybackContinuationState(f.store, undefined, f.owner, [f.original]))[0]!.authWait!.canContinue, false);
});
test('raw verified school status reaches reverse-link cache refresh before completed rejection or new admission', async () => {
  for (const mode of ['completed','changed'] as const) {
    const f = fixture(), originalRead = f.provider.learningStatus!; let raw: SchoolResult | undefined, refreshed = 0;
    if (mode === 'completed') f.completeSchool();
    f.provider.learningStatus = async (...args) => { raw = await originalRead(...args); return raw; };
    f.provider.refreshLearningStatus = async (context, target, value, options) => {
      assert.equal(context.userId, f.owner); assert.deepEqual(target, { courseId: '10', lectureId: '20' }); assert.equal(value, raw);
      options.signal.throwIfAborted(); await options.validate(); refreshed++;
      if (mode === 'changed') throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'fixed');
    };
    const app = await f.app();
    try { const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: {} });
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, mode === 'completed' ? 'PLAYBACK_ALREADY_COMPLETED' : 'SCHOOL_SESSION_CHANGED');
      assert.equal(refreshed, 1); assert.equal(f.counts().authorizations, 0); assert.equal(f.counts().writes, 0);
    } finally { await app.close(); }
  }
});
test('an unavailable school-auth readiness hint preserves readable queue data with continuation disabled', async () => {
  const f = fixture(); f.store.getEncryptedSchoolSession = async () => { throw new Error('synthetic database unavailable'); };
  const values = await withPlaybackContinuationState(f.store, f.key, f.owner, [f.original]);
  assert.equal(values[0]!.id, f.original.id); assert.equal(values[0]!.status, 'queued'); assert.equal(values[0]!.authWait!.canContinue, false);
  assert.equal(f.original.status, 'queued'); assert.equal(f.counts().writes, 0);
});
test('explicit continuation carries exact new consent and hashes its body without changing legacy identity',async()=>{
 const f=fixture(),consentId=randomUUID(),original=f.store.continueJob!;let received=0;
 f.store.continueJob=async(owner,id,key,hash,authorization,operation)=>{assert.equal(authorization.startConsentId,consentId);assert.equal(hash,hashToken(JSON.stringify({operation:'continue_playback',originalJobId:id,startConsentId:consentId})));received++;return original(owner,id,key,hash,authorization,operation);};
 const app=await f.app();try{const r=await app.inject({method:'POST',url:f.url,headers:f.headers(),payload:{startConsentId:consentId}});assert.equal(r.statusCode,202,r.body);assert.equal(received,1);}finally{await app.close();}
});
