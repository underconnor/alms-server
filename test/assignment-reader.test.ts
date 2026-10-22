import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient } from '@alms/ssu-api';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { schoolCacheTtl } from '../src/school-read-cache.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
const options = () => ({ signal: new AbortController().signal, validate: async () => {} });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
function fixture(hooks: { load?: () => Promise<void>; afterGet?: () => void; afterCas?: () => void } = {}) {
  const key = randomBytes(32), states = new Map<string, string>();
  const replace = (owner: string) => states.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b');
  let owned = true, lists = 0, details = 0, catalogs = 0, receivedSignal: AbortSignal | undefined;
  const reader = createLearningxReader({ getEncryptedSchoolSession: async owner => { const value = states.get(owner) ?? null; hooks.afterGet?.(); return value; },
    replaceEncryptedSchoolSession: async (owner, _provider, previous, next) => { if (states.get(owner) !== previous) return false; states.set(owner, next); hooks.afterCas?.(); return true; } }, key,
  async (_session, signal) => { receivedSignal = signal; return { client: {
    terms: async () => [{ id: '1', name: '합성 학기', default: true }],
    courses: async () => { catalogs++; return owned ? [{ id: '10', name: '합성 강좌', termId: '1' }] : []; },
    assignments: async () => { lists++; await hooks.load?.(); return assignmentListFixture(); },
    assignmentDetail: async () => { details++; await hooks.load?.(); return assignmentFixture(); },
  } as unknown as LearningxClient, serialize: async () => ({}) }; }, undefined, undefined, undefined, null);
  return { reader, states, replace, setOwned: (value: boolean) => { owned = value; }, counts: () => ({ lists, details, catalogs }), signal: () => receivedSignal };
}
test('assignment bounded hits recheck owner/generation/catalog proof without school bootstrap', async () => {
  const f = fixture();
  await f.reader.readAssignments!('a', '10', options()); await f.reader.readAssignments!('a', '10', options());
  await f.reader.readAssignment!('a', '10', '90', options()); await f.reader.readAssignment!('a', '10', '90', options());
  assert.deepEqual(f.counts(), { lists: 1, details: 1, catalogs: 1 });
  await f.reader.readAssignment!('b', '10', '90', options()); f.replace('a'); await f.reader.readAssignment!('a', '10', '90', options());
  assert.equal(f.counts().details, 3);
  f.setOwned(false); await assert.rejects(f.reader.readAssignment!('a', '10', '90', { ...options(), refresh: true }), error => error instanceof AppError && error.statusCode === 404);
  assert.equal(f.counts().details, 3);
});
test('explicit retry bypasses assignment cache and hits do not extend the original thirty-second expiry', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(); await f.reader.readAssignment!('a', '10', '90', options());
  now += 20_000; await f.reader.readAssignment!('a', '10', '90', options()); assert.equal(f.counts().details, 1);
  now += 11_000; await f.reader.readAssignment!('a', '10', '90', options()); assert.equal(f.counts().details, 2);
  await f.reader.readAssignment!('a', '10', '90', { ...options(), refresh: true }); assert.equal(f.counts().details, 3);
  assert.equal(schoolCacheTtl('assignments:10'), 30_000); assert.equal(schoolCacheTtl('assignment:10:90'), 30_000);
});
test('assignment expiry, unowned target and incomplete upstream failure never become an unsubmitted success', async () => {
  for (const code of ['authentication_required', 'unsupported', 'unexpected_response'] as const) {
    const f = fixture({ load: async () => { throw new SchoolError(code); } });
    await assert.rejects(f.reader.readAssignment!('a', '10', '90', options()), error => error instanceof AppError && error.statusCode === (code === 'authentication_required' ? 401 : code === 'unsupported' ? 503 : 502));
  }
});
test('new school generation, logout or revoked ALMS session during a read withholds the submission result', async () => {
  for (const mode of ['login', 'logout', 'alms']) {
    let active = true; const wait = gate(), f = fixture({ load: () => wait.promise });
    const reading = f.reader.readAssignment!('a', '10', '90', { ...options(), validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', '합성'); } });
    await flush(); if (mode === 'login') f.replace('a'); if (mode === 'logout') f.states.delete('a'); if (mode === 'alms') active = false;
    const updated = f.states.get('a'); wait.release();
    await assert.rejects(reading, error => error instanceof AppError && [401,409].includes(error.statusCode));
    if (mode !== 'alms') assert.equal(f.states.get('a'), updated);
  }
});
test('cancelled queued assignment starts no school request, and post-CAS cancellation withholds a result', async () => {
  const wait = gate(), f = fixture(), controller = new AbortController(), holding = withSchoolSessionLock('a', () => wait.promise);
  const reading = f.reader.readAssignment!('a', '10', '90', { ...options(), signal: controller.signal }); await flush();
  const rejected = assert.rejects(reading, error => error instanceof AppError && error.code === 'ASSIGNMENTS_UNAVAILABLE'); controller.abort(); await rejected;
  wait.release(); await holding; await flush(); assert.deepEqual(f.counts(), { lists: 0, details: 0, catalogs: 0 });
  const after = new AbortController(), other = fixture({ afterCas: () => after.abort() });
  await assert.rejects(other.reader.readAssignment!('a', '10', '90', { ...options(), signal: after.signal }));
});
test('assignment overall deadline propagates to the school client and prevents further publication', async t => {
  const timeout = AbortSignal.timeout; t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 90_000 ? 20 : ms));
  const wait = gate(), f = fixture({ load: () => wait.promise }), alive = setTimeout(() => {}, 100);
  try { await assert.rejects(f.reader.readAssignments!('a', '10', options()), error => error instanceof AppError && error.code === 'ASSIGNMENTS_UNAVAILABLE');
    assert.equal(f.signal()?.aborted, true); wait.release(); await flush();
  } finally { clearTimeout(alive); wait.release(); }
});
