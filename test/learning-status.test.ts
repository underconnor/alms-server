import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient } from '@alms/ssu-api';
import { projectLearningStatus } from '../src/learning-status.js';
import { createLearningxReader } from '../src/school-reader.js';
import { createLearningxReads } from '../src/school-read.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import type { SchoolReadCache } from '../src/school-read-cache.js';

export const statusFixture = () => ({ courseId: '10', moduleItemId: '90', itemId: '900', observedAt: new Date().toISOString(),
  resourceType: 'movie', published: true, opened: true, useAttendance: true, omitProgress: false, completed: true,
  schoolAttendanceStatus: 'attendance', progressSeconds: 95, lastPositionSeconds: 100, durationSeconds: 100,
  progressPercent: 95, attendance: 'unknown', recognized: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(load?: () => Promise<unknown>, hooks: { afterCas?: () => void } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b'); let calls = 0, catalogs = 0, owned = true; const cacheReads: string[] = [], cacheWrites: string[] = [];
  const durable: SchoolReadCache = { get: async scope => { cacheReads.push(scope.resource); throw new Error('Status must not use durable cache'); },
    put: async (scope) => { cacheWrites.push(scope.resource); return true; }, delete: async () => {}, prune: async () => 0 } as unknown as SchoolReadCache;
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => states.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => {
      if (states.get(owner) !== previous) return false; states.set(owner, next); hooks.afterCas?.(); return true;
    } }, key, async () => ({ client: {
      terms: async () => [{ id: '1', name: '합성 학기', default: true }],
      courses: async () => { catalogs++; return owned ? [{ id: '10', name: '합성 강좌', termId: '1' }] : []; },
      moduleLearningStatus: async () => { calls++; return load ? await load() : statusFixture(); },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, durable, undefined, null);
  return { reader, states, replace, counts: () => ({ calls, catalogs }), cacheReads, cacheWrites, setOwned: (value: boolean) => { owned = value; } };
}
test('explicit completion, school status and ninety-five-percent progress remain evidence rather than recognition', () => {
  const value = projectLearningStatus({ ...statusFixture(), callbackTargetUrl: 'private-url', userId: 'private-id' }, '10', '90');
  assert.equal(value.progressPercent, 95); assert.equal(value.recognized, null); assert.equal(value.attendance, 'unknown');
  assert.equal(value.evidence?.completed, true); assert.equal(value.evidence?.schoolAttendanceStatus, 'attendance');
  assert.doesNotMatch(JSON.stringify(value), /private-|courseId|moduleItemId|itemId|callback/);
  const nonattendance = projectLearningStatus({ ...statusFixture(), useAttendance: false, attendance: 'not_applicable' }, '10', '90');
  assert.equal(nonattendance.recognized, null); assert.equal(nonattendance.attendance, 'not_applicable');
});
test('missing values and non-video completion do not invent progress or recognized attendance', () => {
  const value = { ...statusFixture(), resourceType: 'pdf', published: null, opened: null, useAttendance: null, omitProgress: null,
    schoolAttendanceStatus: null, completed: null, progressSeconds: null, lastPositionSeconds: null, durationSeconds: null, progressPercent: null };
  const result = projectLearningStatus(value, '10', '90'); assert.equal(result.progressPercent, null); assert.equal(result.evidence?.completed, null);
  for (const changed of [{ ...value, progressPercent: 0 }, { ...value, recognized: true }, { ...value, attendance: 'present' },
    { ...value, progressSeconds: 0 }, { ...value, completed: 'true' }, { ...value, courseId: '20' }, { ...value, moduleItemId: '91' }])
    assert.throws(() => projectLearningStatus(changed, '10', '90'), error => error instanceof SchoolError);
});
test('every verification bypasses cached result and catalog, rechecks ownership and keeps independent owners', async () => {
  const f = fixture();
  await f.reader.readLearningStatus!('a', '10', '90'); await f.reader.readLearningStatus!('a', '10', '90');
  await f.reader.readLearningStatus!('b', '10', '90');
  assert.deepEqual(f.counts(), { calls: 3, catalogs: 3 }); assert.deepEqual(f.cacheReads, []);
  assert.deepEqual(f.cacheWrites, ['catalog:all', 'catalog:all', 'catalog:all']);
  f.setOwned(false); await assert.rejects(f.reader.readLearningStatus!('a', '10', '90'), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(f.counts().calls, 3);
});
test('new generation, logout or post-CAS abort prevents publication of a fresh result', async () => {
  for (const mode of ['login', 'logout']) {
    const wait = gate(), f = fixture(async () => { await wait.promise; return statusFixture(); });
    const reading = f.reader.readLearningStatus!('a', '10', '90'); await flush();
    if (mode === 'login') f.replace('a'); else f.states.delete('a'); const updated = f.states.get('a'); wait.release();
    await assert.rejects(reading, error => error instanceof AppError && error.statusCode === 409); assert.equal(f.states.get('a'), updated);
  }
  const controller = new AbortController(), f = fixture(undefined, { afterCas: () => controller.abort() });
  await assert.rejects(f.reader.readLearningStatus!('a', '10', '90', controller.signal), error => error instanceof AppError && error.code === 'SCHOOL_RESULT_UNAVAILABLE');
});
test('queued cancellation starts no school read, and a late response after cancellation is withheld', async () => {
  const lock = gate(), holding = withSchoolSessionLock('a', () => lock.promise), controller = new AbortController(), f = fixture();
  const queued = f.reader.readLearningStatus!('a', '10', '90', controller.signal); await flush();
  const rejected = assert.rejects(queued, error => error instanceof AppError && error.code === 'SCHOOL_RESULT_UNAVAILABLE'); controller.abort(); await rejected;
  lock.release(); await holding; await flush(); assert.deepEqual(f.counts(), { calls: 0, catalogs: 0 });
  const wait = gate(), other = new AbortController(), late = fixture(async () => { await wait.promise; return statusFixture(); });
  const pending = late.reader.readLearningStatus!('a', '10', '90', other.signal); await flush();
  const failure = assert.rejects(pending, error => error instanceof AppError && error.code === 'SCHOOL_RESULT_UNAVAILABLE'); other.abort(); await failure;
  wait.release(); await flush(); assert.deepEqual(late.cacheWrites, []);
});
test('known SDK failures are normalized without fake progress or success and overall deadline is bounded', async t => {
  for (const code of ['authentication_required', 'unexpected_response', 'unsupported'] as const) {
    const f = fixture(async () => { throw new SchoolError(code); });
    await assert.rejects(createLearningxReads(f.reader).learningStatus!({ userId: 'a' }, { courseId: '10', lectureId: '90' }),
      error => error instanceof AppError && error.statusCode === (code === 'authentication_required' ? 401 : code === 'unsupported' ? 503 : 502));
  }
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const wait = gate(), f = fixture(async () => { await wait.promise; return statusFixture(); }), alive = setTimeout(() => {}, 200);
  try { await assert.rejects(f.reader.readLearningStatus!('a', '10', '90'), error => error instanceof AppError && error.code === 'SCHOOL_RESULT_UNAVAILABLE');
    wait.release(); await flush(); assert.deepEqual(f.cacheWrites, []);
  } finally { wait.release(); clearTimeout(alive); }
});

test('canonical readystream preserves measured seconds and original school status without claiming recognition', () => {
  const value = { ...statusFixture(), resourceType: 'readystream', durationSeconds: 1158.14, progressSeconds: 943.53,
    lastPositionSeconds: 943.539, progressPercent: 943.53 / 1158.14 * 100, completed: false, schoolAttendanceStatus: 'none' };
  const result = projectLearningStatus(value, '10', '90');
  assert.equal(result.evidence?.resourceType, 'readystream'); assert.equal(result.evidence?.progressSeconds, 943.53);
  assert.equal(result.evidence?.lastPositionSeconds, 943.539); assert.equal(result.evidence?.schoolAttendanceStatus, 'none');
  assert.equal(result.recognized, null); assert.equal(result.attendance, 'unknown');
  for (const patch of [{progressPercent: 94.353}, {resourceType: 'Readystream'}, {recognized: true}])
    assert.throws(() => projectLearningStatus({...value, ...patch}, '10', '90'));
});
