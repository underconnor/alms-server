import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import type { SchoolReadCache, SchoolCacheScope } from '../src/school-read-cache.js';
import { assignmentCatalogFixture } from './helpers/assignment-catalog-fixture.js';

const options = () => ({ signal: AbortSignal.timeout(5000), validate: async () => {} });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const key = randomBytes(32), sessions = new Map<string, string>(), values = new Map<string, { value: unknown; expiresAt: number }>();
  const replace = (owner: string) => sessions.set(owner, encryptSchoolSession({ version: 1, generation: randomUUID(),
    identity: { studentId: owner === 'a' ? '90000001' : '90000002' }, jar: {} }, key, owner, 'ssu'));
  replace('a'); replace('b');
  const resourceKey = (scope: SchoolCacheScope) => JSON.stringify([scope.owner, scope.generation, scope.resource]);
  const durable: SchoolReadCache = {
    get: async <T>(scope: SchoolCacheScope) => { const item = values.get(resourceKey(scope)); return item && sessions.get(scope.owner) === scope.encryptedSession
      ? { ...item, value: structuredClone(item.value) as T } : null; },
    put: async (scope, value, ttl) => { values.set(resourceKey(scope), { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true; },
    delete: async (owner, _provider, resource) => { for (const id of values.keys()) { const [a, , r] = JSON.parse(id); if (owner === a && (!resource || resource === r)) values.delete(id); } },
  };
  const store = { getEncryptedSchoolSession: async (owner: string) => sessions.get(owner) ?? null,
    replaceEncryptedSchoolSession: async (owner: string, _provider: string, previous: string, next: string) => {
      if (sessions.get(owner) !== previous) return false; sessions.set(owner, next); return true;
    } };
  return { ...assignmentCatalogFixture(store, key, durable), sessions, replace, values };
}

test('cold list/detail/history reuse exact current catalog but each runs real SDK fresh native self and all-term enrollment', async () => {
  const f = fixture(), reader = f.reader(); await reader.catalog('a');
  await reader.readAssignments!('a', '10', options()); await reader.readAssignment!('a', '10', '90', options());
  const history = await reader.readAssignmentHistory!('a', '10', '90', options());
  assert.equal(history.state, 'available'); assert.equal(f.count('bootstrap'), 4);
  assert.equal(f.count('backend_terms'), 1); assert.deepEqual(f.backendSelections, [['1']]);
  assert.equal(f.count('sdk_self'), 3); assert.equal(f.count('sdk_terms'), 3); assert.equal(f.count('sdk_courses'), 3);
  assert.equal(f.count('sdk_list'), 1); assert.equal(f.count('sdk_detail'), 2); assert.equal(f.count('sdk_submission'), 2);
  const before = [...f.trace]; await reader.readAssignments!('a', '10', options());
  await reader.readAssignment!('a', '10', '90', options()); await reader.readAssignmentHistory!('a', '10', '90', options());
  assert.deepEqual(f.trace, before);
});
test('an exact all-term catalog also serves later cold bodies without duplicate planning reads', async () => {
  const f = fixture(), reader = f.reader(); await reader.readAssignments!('a', '10', options());
  await reader.readAssignment!('a', '10', '90', options());
  assert.equal(f.count('backend_terms'), 1); assert.deepEqual(f.backendSelections, [['1', '2']]); assert.equal(f.count('sdk_self'), 2);
});
test('encrypted current catalog and body proof survive reader restart without extending original thirty-second body expiry', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(); await f.reader().catalog('a'); const result = await f.reader().readAssignment!('a', '10', '90', options());
  const body = [...f.values.entries()].find(([id]) => JSON.parse(id)[2] === 'assignment:10:90')![1]; const expiresAt = body.expiresAt;
  const before = [...f.trace]; now += 20_000; assert.deepEqual(await f.reader().readAssignment!('a', '10', '90', options()), result);
  assert.deepEqual(f.trace, before); assert.equal(body.expiresAt, expiresAt);
  now += 11_000; await f.reader().readAssignment!('a', '10', '90', options());
  assert.equal(f.count('backend_terms'), 1); assert.equal(f.count('sdk_self'), 2);
});
test('an all-term proof missing the exact target falls back to a newer current or selected-term proof', async () => {
  for (const selected of [undefined, { termId: '1' }]) {
    const f = fixture(), reader = f.reader(); f.state.backendCurrent = false;
    await reader.readAssignment!('a', '20', '90', options()); f.state.backendCurrent = true;
    await reader.catalog('a', selected); await reader.readAssignment!('a', '10', '90', options());
    assert.deepEqual(f.backendSelections, [['1', '2'], ['1']]); assert.equal(f.count('sdk_self'), 2);
  }
});
test('current proof cannot authorize a past target; past falls back to all terms and fresh SDK enrollment', async () => {
  const f = fixture(), reader = f.reader(); await reader.catalog('a');
  const past = await reader.readAssignment!('a', '20', '90', options());
  assert.deepEqual(f.backendSelections, [['1'], ['1', '2']]); assert.equal(past.course?.ended, true);
  assert.equal(past.course?.schoolDefaultTerm, false); assert.equal(f.count('sdk_self'), 1);
});
test('expired, another owner and new generation planning proofs all require a fresh catalog', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const mode of ['expired', 'owner', 'generation']) {
    const f = fixture(), reader = f.reader(); await reader.catalog('a');
    if (mode === 'expired') now += 300_001; if (mode === 'generation') f.replace('a');
    await reader.readAssignment!(mode === 'owner' ? 'b' : 'a', '10', '90', options());
    assert.equal(f.count('backend_terms'), 2); assert.equal(f.backendSelections.at(-1)?.length, 2);
  }
});
test('real SDK revocation and native identity mismatch reject a cold body despite a still-valid planning proof', async () => {
  for (const mode of ['enrollment', 'identity']) {
    const f = fixture(), reader = f.reader(); await reader.catalog('a');
    if (mode === 'enrollment') f.state.sdkCurrent = false; else f.state.identity = false;
    await assert.rejects(reader.readAssignment!('a', '10', '90', options()), error => error instanceof AppError && error.statusCode === (mode === 'identity' ? 401 : 502));
    assert.equal(f.count('backend_terms'), 1); assert.equal(f.count('sdk_self'), 1); assert.equal(f.count('sdk_detail'), 0);
  }
});
test('a narrow cached current catalog cannot bypass the SDK full-enrollment one-hundred-course bound', async () => {
  const f = fixture(), reader = f.reader(); await reader.catalog('a'); f.state.sdkExtra = 99;
  await assert.rejects(reader.readAssignment!('a', '10', '90', options()), { statusCode: 503 });
  assert.equal(f.count('backend_terms'), 1); assert.equal(f.count('sdk_self'), 1); assert.equal(f.count('sdk_detail'), 0);
});
test('a duplicate exact target in a persisted planner catalog fails closed into fresh planning before body lookup', async () => {
  const f = fixture(); await f.reader().catalog('a');
  const proof = [...f.values.entries()].find(([id]) => JSON.parse(id)[2] === 'catalog')![1].value as { courses: unknown[] };
  proof.courses.push(structuredClone(proof.courses[0]));
  await f.reader().readAssignment!('a', '10', '90', options());
  assert.equal(f.count('backend_terms'), 2); assert.equal(f.count('sdk_self'), 1);
});
test('concurrent cold list/detail/history keep separate fresh SDK authorization and serialize the same owner jar', async () => {
  const f = fixture(), reader = f.reader(); await reader.catalog('a'); const wait = gate(); let first = true;
  f.state.load = async () => { if (first) { first = false; await wait.promise; } };
  const reading = Promise.all([reader.readAssignments!('a', '10', options()), reader.readAssignment!('a', '10', '90', options()),
    reader.readAssignmentHistory!('a', '10', '90', options())]);
  await flush(); assert.equal(f.count('sdk_self'), 1); wait.release(); await reading;
  assert.equal(f.count('bootstrap'), 4); assert.equal(f.count('backend_terms'), 1); assert.equal(f.count('sdk_self'), 3);
});
test('explicit refresh obtains a fresh planning catalog and rejects revoked ownership before reading a body', async () => {
  const f = fixture(), reader = f.reader(); await reader.catalog('a');
  await reader.readAssignment!('a', '10', '90', { ...options(), refresh: true });
  assert.equal(f.count('backend_terms'), 2); f.state.backendCurrent = false;
  await assert.rejects(reader.readAssignment!('a', '10', '91', { ...options(), refresh: true }), { statusCode: 404 });
  assert.equal(f.count('backend_terms'), 3); assert.equal(f.count('sdk_self'), 1);
});
test('generation replacement and ALMS revocation during real SDK load withhold the result and do not replace a newer jar', async () => {
  for (const mode of ['generation', 'logout', 'alms']) {
    const f = fixture(), reader = f.reader(); await reader.catalog('a'); const wait = gate(); f.state.load = () => wait.promise;
    let active = true; const reading = reader.readAssignment!('a', '10', '90', { ...options(), validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'Synthetic revoked session'); } });
    await flush(); if (mode === 'generation') f.replace('a'); if (mode === 'logout') f.sessions.delete('a'); if (mode === 'alms') active = false;
    const latest = f.sessions.get('a'); wait.release(); await assert.rejects(reading, error => error instanceof AppError && [401, 409].includes(error.statusCode));
    if (mode !== 'alms') assert.equal(f.sessions.get('a'), latest);
  }
});
