import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { createPlaybackAdmission, inspectPlaybackAdmission } from '../src/playback-authority.js';
import { hashToken, type Store } from '../src/store.js';
import { publicReviewedPreplay, type Job, type Session, type SchoolResult } from '../src/domain.js';
import type { SchoolProvider } from '../src/provider.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { reviewedPreplayRequestHash } from '../src/reviewed-preplay-routes.js';

const token = 'b'.repeat(43), version = '2026-11-17T00:00:00.123456+00:00';
const baseHeaders = { cookie: '__Host-alms_session=' + token, origin: 'https://lms.flyjung.kr',
  accept: playbackClientAccept, 'x-csrf-token': 'synthetic-csrf', 'x-alms-client-id': 'alms-web' };
const clone = <T>(value: T): T => structuredClone(value);
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
type Result = { originalJob: Job; job: Job; retried: true };
function fixture() {
  const owner = randomUUID(), encryptionKey = randomBytes(32), parentId = randomUUID(), consentId = randomUUID();
  let generation = randomUUID(), active = true, eligible = true, ready = true, completed: boolean | null = false;
  const now = new Date().toISOString();
  const original: Job = { id: parentId, userId: owner, courseId: '10', lectureId: '20', status: 'needs_verification',
    scheduledFor: now, createdAt: now, updatedAt: now, errorCode: 'PLAYBACK_ADMISSION_FAILED', schoolResult: null,
    executionOutcome: 'not_started', acceptedGeneration: randomUUID(), executionTokenHash: null,
    idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-original'),
    recovery: { eligible: false, reason: 'not_interrupted', version } };
  const session: Session = { tokenHash: hashToken(token), csrfToken: baseHeaders['x-csrf-token'], clientId: 'alms-web',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), analyticsSessionId: randomUUID(),
    user: { id: owner, displayName: '합성 사용자', analyticsId: randomUUID(), analyticsEnabled: false } };
  const accepted = new Map<string, { hash: string; result: Result }>(), jobs = new Map([[parentId, original]]);
  let childId: string | null = null, reads = 0, authorizations = 0, writes = 0, eligibilityReads = 0;
  let onStatus = async () => {}, onAuthorize = async () => {}, afterCommit = async () => {};
  const authorizeSession = (user: string, auth: { almsTokenHash: string; csrfToken: string; clientId: string | null }) => {
    if (!active || user !== owner || auth.almsTokenHash !== session.tokenHash || auth.csrfToken !== session.csrfToken || auth.clientId !== session.clientId)
      throw new AppError(401, 'AUTH_REQUIRED', 'fixed');
  };
  const school = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 0, attendance: 'unknown', recognized: null,
    evidence: { resourceType: 'movie', published: true, opened: true, useAttendance: true, omitProgress: false, completed,
      schoolAttendanceStatus: 'none', durationSeconds: 60, progressSeconds: 0, lastPositionSeconds: 0 } });
  const store = {
    getSession: async (hash: string) => active && hash === session.tokenHash ? clone(session) : null,
    getEncryptedSchoolSession: async (user: string) => user === owner
      ? encryptSchoolSession({ version: 1, generation, lmsExchange: { status: 'ready' }, jar: {} }, encryptionKey, owner, 'ssu') : null,
    getJob: async (user: string, id: string) => user === owner && jobs.has(id) ? clone(jobs.get(id)!) : null,
    findReviewedPreplayRetry: async (user, id, requestKey, auth, _operation, requestHash) => {
      authorizeSession(user, auth);
      if (id !== parentId) return null;
      const found = accepted.get(requestKey); if (!found) return null;
      if (requestHash !== undefined && found.hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'fixed');
      return { originalJob: clone(original), job: clone(jobs.get(found.result.job.id)!), retried: true as const };
    },
    getReviewedPreplayEligibility: async (user, id, auth) => {
      authorizeSession(user, auth); eligibilityReads++;
      return id === parentId ? { eligible, version, retriedAsJobId: childId } : null;
    },
    retryReviewedPreplay: async (user, id, input, auth) => {
      authorizeSession(user, auth);
      assert.equal(id, parentId); assert.equal(input.expectedVersion, version); assert.equal(input.startConsentId, consentId);
      assert.equal(input.requestHash, reviewedPreplayRequestHash(id, { expectedVersion: version, startConsentId: consentId }));
      assert.equal(inspectPlaybackAdmission(auth.admission, { userId: owner, courseId: '10', lectureId: '20' }).generation, generation);
      assert.equal(auth.schoolResult.evidence?.completed, false);
      if (childId) throw new AppError(409, 'PLAYBACK_REVIEWED_PREPLAY_ALREADY_RETRIED', 'fixed');
      writes++;
      const child: Job = { ...clone(original), id: randomUUID(), status: 'queued', errorCode: null, executionOutcome: null,
        acceptedGeneration: generation, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
        startConsent: { id: consentId, expiresAt: new Date(Date.now() + 3600000).toISOString(), attempt: 'not_attempted' } };
      childId = child.id; jobs.set(child.id, child);
      const result: Result = { originalJob: clone(original), job: clone(child), retried: true };
      accepted.set(input.idempotencyKey, { hash: input.requestHash, result }); await afterCommit(); return result;
    },
  } as Store;
  const provider: SchoolProvider = { capabilities: { schoolAuthentication: true, schoolRead: true, playback: true, pauseResume: false },
    learningStatus: async () => { reads++; await onStatus(); return school(); },
    authorizePlayback: async (context, target, options) => {
      authorizations++; await onAuthorize(); await options.validate(); options.signal.throwIfAborted();
      return createPlaybackAdmission({ userId: context.userId, ...target }, { generation, encryptedSession: 'synthetic-school-seal' }, 60);
    } };
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent', SESSION_ENCRYPTION_KEY: encryptionKey.toString('base64') });
  const url = '/v1/jobs/' + parentId + '/retry-reviewed-preplay';
  return { original, session, store, provider, jobs, consentId, url, payload: { expectedVersion: version, startConsentId: consentId },
    headers: () => ({ ...baseHeaders, 'idempotency-key': randomUUID() }),
    app: () => buildApp(config, store, provider, undefined, undefined, { isReady: async () => ready }),
    counters: () => ({ reads, authorizations, writes, eligibilityReads }), setEligible: (v: boolean) => { eligible = v; },
    setReady: (v: boolean) => { ready = v; }, setCompleted: (v: boolean | null) => { completed = v; },
    logout: () => { active = false; }, newGeneration: () => { generation = randomUUID(); },
    useOriginalGeneration: () => { generation = original.acceptedGeneration!; },
    onStatus: (fn: typeof onStatus) => { onStatus = fn; }, onAuthorize: (fn: typeof onAuthorize) => { onAuthorize = fn; },
    afterCommit: (fn: typeof afterCommit) => { afterCommit = fn; } };
}

test('reviewed pre-play creates a consent-bound child and preserves the full original history', async () => {
  const f = fixture(), before = clone(f.original), app = await f.app(), headers = f.headers();
  try {
    const accepted = await app.inject({ method: 'POST', url: f.url, headers, payload: f.payload });
    assert.equal(accepted.statusCode, 202, accepted.body); assert.equal(accepted.json().retried, true);
    assert.equal(accepted.json().job.startConsent.id, f.consentId); assert.deepEqual(f.original, before);
    f.jobs.get(accepted.json().job.id)!.status = 'completed';
    const replay = await app.inject({ method: 'POST', url: f.url, headers, payload: f.payload });
    assert.equal(replay.statusCode, 202); assert.equal(replay.json().job.id, accepted.json().job.id); assert.equal(replay.json().job.status, 'completed');
    assert.deepEqual(f.counters(), { reads: 1, authorizations: 1, writes: 1, eligibilityReads: 1 });
    assert.doesNotMatch(accepted.body, /acceptedGeneration|executionTokenHash|csrfToken|tokenHash|userId|synthetic-school-seal/);
  } finally { await app.close(); }
});

test('missing review, stale microsecond version and foreign parent stop before school calls', async () => {
  for (const mode of ['ineligible','version','foreign'] as const) {
    const f = fixture(); if (mode === 'ineligible') f.setEligible(false); const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: mode === 'foreign' ? f.url.replace(f.original.id, randomUUID()) : f.url,
        headers: f.headers(), payload: mode === 'version' ? { ...f.payload, expectedVersion: '2026-11-17T00:00:00.123Z' } : f.payload });
      assert.equal(response.statusCode, mode === 'foreign' ? 404 : 409, response.body);
      assert.equal(f.counters().reads, 0); assert.equal(f.counters().authorizations, 0); assert.equal(f.counters().writes, 0);
    } finally { await app.close(); }
  }
});

test('registered Origin/client, CSRF, playback Accept, strict body and UUID key remain mandatory', async () => {
  for (const mode of ['origin','csrf','client','accept','key','consent','extra'] as const) {
    const f = fixture(), app = await f.app(), headers: Record<string,string> = f.headers();
    if (mode === 'origin') headers.origin = 'https://foreign.invalid'; if (mode === 'csrf') headers['x-csrf-token'] = 'wrong';
    if (mode === 'client') headers['x-alms-client-id'] = 'foreign'; if (mode === 'accept') headers.accept = 'application/json';
    if (mode === 'key') headers['idempotency-key'] = 'invalid';
    const payload = mode === 'consent' ? { expectedVersion: version } : mode === 'extra' ? { ...f.payload, force: true } : f.payload;
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers, payload });
      assert.ok([400,401,403,409].includes(response.statusCode), response.body);
      assert.deepEqual(f.counters(), { reads: 0, authorizations: 0, writes: 0, eligibilityReads: 0 });
    } finally { await app.close(); }
  }
});

test('fresh completed or unknown school evidence cannot create a child', async () => {
  for (const completed of [true, null] as const) {
    const f = fixture(); f.setCompleted(completed); const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
      assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, completed ? 'PLAYBACK_ALREADY_COMPLETED' : 'PLAYBACK_REVIEWED_PREPLAY_STATUS_UNKNOWN');
      assert.equal(f.counters().reads, 1); assert.equal(f.counters().authorizations, 0); assert.equal(f.counters().writes, 0);
    } finally { await app.close(); }
  }
});

test('review metadata is additive, preserves exact version and rejects malformed privilege hints', async () => {
  const f = fixture(); f.original.reviewedPreplay = { eligible: true, version, retriedAsJobId: null };
  const app = await f.app();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/jobs/' + f.original.id, headers: f.headers() });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json().reviewedPreplay, f.original.reviewedPreplay);
    assert.equal(response.json().recovery.eligible, false);
    for (const value of [null, {}, { eligible: 'true', version, retriedAsJobId: null },
      { eligible: true, version, retriedAsJobId: randomUUID() }, { eligible: false, version: 'invalid', retriedAsJobId: null },
      { eligible: true, version, retriedAsJobId: null, evidence: 'private' }]) assert.equal(publicReviewedPreplay(value), null);
  } finally { await app.close(); }
});

test('a reviewed parent still requires a different current verified school generation', async () => {
  const f = fixture(); f.useOriginalGeneration(); const app = await f.app();
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PLAYBACK_REAUTHENTICATION_REQUIRED');
    assert.equal(f.counters().reads, 0); assert.equal(f.counters().writes, 0);
  } finally { await app.close(); }
});

test('logout, school generation change and readiness loss withhold mutation after fresh reads', async () => {
  for (const mode of ['logout','generation','ready'] as const) {
    const f = fixture();
    if (mode === 'logout') f.onStatus(async () => f.logout());
    if (mode === 'generation') f.onAuthorize(async () => f.newGeneration());
    if (mode === 'ready') f.onAuthorize(async () => f.setReady(false));
    const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
      assert.equal(response.statusCode, mode === 'logout' ? 401 : mode === 'generation' ? 409 : 503);
      assert.equal(f.counters().writes, 0);
    } finally { await app.close(); }
  }
});

test('uncertain commit is inspected by exact key without new school calls or a second child', async () => {
  const f = fixture(), app = await f.app(), headers = f.headers(); f.afterCommit(async () => { throw new Error('synthetic response loss'); });
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers, payload: f.payload });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_REVIEWED_PREPLAY_UNCONFIRMED');
    const observed = await app.inject({ method: 'GET', url: f.url + '/' + headers['idempotency-key'], headers });
    assert.equal(observed.statusCode, 200); assert.equal(observed.json().retried, true);
    const same = await app.inject({ method: 'POST', url: f.url, headers, payload: f.payload });
    assert.equal(same.statusCode, 202); assert.equal(same.json().job.id, observed.json().job.id);
    const another = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
    assert.equal(another.statusCode, 409); assert.equal(another.json().error.code, 'PLAYBACK_REVIEWED_PREPLAY_ALREADY_RETRIED');
    assert.equal(f.counters().reads, 1); assert.equal(f.counters().writes, 1);
    f.logout(); assert.equal((await app.inject({ method: 'GET', url: f.url + '/' + headers['idempotency-key'], headers })).statusCode, 401);
  } finally { await app.close(); }
});

test('definite consent rejections remain actionable conflicts without ambiguous-admission recovery or child writes', async () => {
  for (const code of ['PLAYBACK_START_CONSENT_EXPIRED','PLAYBACK_START_CONSENT_REVOKED','PLAYBACK_START_CONSENT_INVALID'] as const) {
    const f = fixture(), before = clone(f.original);
    f.store.retryReviewedPreplay = async () => { throw new AppError(409, code, 'fixed'); };
    const app = await f.app();
    try {
      const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, code);
      assert.equal(f.counters().writes, 0); assert.equal(f.jobs.size, 1); assert.deepEqual(f.original, before);
    } finally { await app.close(); }
  }
});

test('same-key changed body conflicts and absent GET never performs admission', async () => {
  const f = fixture(), app = await f.app(), headers = f.headers();
  try {
    assert.equal((await app.inject({ method: 'GET', url: f.url + '/' + headers['idempotency-key'], headers })).statusCode, 404);
    assert.equal(f.counters().reads, 0);
    assert.equal((await app.inject({ method: 'POST', url: f.url, headers, payload: f.payload })).statusCode, 202);
    const response = await app.inject({ method: 'POST', url: f.url, headers, payload: { ...f.payload, startConsentId: randomUUID() } });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.counters().reads, 1); assert.equal(f.counters().writes, 1);
  } finally { await app.close(); }
});

test('concurrent explicit requests admit at most one in-process school attempt', async () => {
  const f = fixture(), entered = deferred(), wait = deferred(), app = await f.app();
  f.onAuthorize(async () => { entered.release(); await wait.promise; });
  try {
    const first = app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload }); await entered.promise;
    const second = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
    assert.equal(second.statusCode, 409); assert.equal(second.json().error.code, 'PLAYBACK_REVIEWED_PREPLAY_BUSY');
    wait.release(); assert.equal((await first).statusCode, 202); assert.equal(f.counters().writes, 1);
  } finally { wait.release(); await app.close(); }
});

test('deadline during slow fresh admission never reaches the retry transaction', async t => {
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((fn: any, ms?: number, ...args: any[]) => timeout(fn, ms === 90_000 ? 20 : ms, ...args)) as typeof setTimeout);
  const f = fixture(), wait = deferred(), app = await f.app(); f.onAuthorize(async () => { await wait.promise; });
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PLAYBACK_REVIEWED_PREPLAY_UNCONFIRMED');
    wait.release(); await new Promise(r => setImmediate(r)); assert.equal(f.counters().writes, 0);
  } finally { wait.release(); await app.close(); }
});

test('raw school result refresh precedes completed rejection and admission', async () => {
  const f = fixture(), original = f.provider.learningStatus!; let raw: SchoolResult | undefined, refreshed = false;
  f.setCompleted(true);
  f.provider.learningStatus = async (...args) => { raw = await original(...args); return raw; };
  f.provider.refreshLearningStatus = async (_context, _target, value, options) => { assert.equal(value, raw); await options.validate(); refreshed = true; };
  const app = await f.app();
  try {
    const response = await app.inject({ method: 'POST', url: f.url, headers: f.headers(), payload: f.payload });
    assert.equal(response.statusCode, 409); assert.equal(refreshed, true); assert.equal(f.counters().writes, 0);
  } finally { await app.close(); }
});
