import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolError, type LearningxClient } from '@alms/ssu-api';
import { assignmentReadFailureDiagnostic, rememberAssignmentReadFailure } from '../src/assignment-read-diagnostics.js';
import { createLearningxReader } from '../src/school-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import type { SchoolReadCache } from '../src/school-read-cache.js';
import { assignmentFixture, assignmentListFixture } from './helpers/assignment-fixture.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';

test('assignment evidence copies only allowlisted operation/stage/code without error mutation or private values', () => {
  const error = Object.assign(new SchoolError('unexpected_response'), { url: 'https://private.test/token', body: 'private-body', userId: 'private-owner', cause: new Error('private-cause') });
  const before = JSON.stringify(error), diagnostic = assignmentReadFailureDiagnostic(error, 'detail', 'school_read');
  assert.deepEqual(diagnostic, { operation: 'detail', stage: 'school_read', code: 'unexpected_response' });
  const raw = { ...diagnostic, url: 'private-url' }; rememberAssignmentReadFailure(error, raw); raw.stage = 'projection';
  assert.deepEqual(assignmentReadFailureDiagnostic(error, 'list', 'final_session'), diagnostic);
  assert.equal(JSON.stringify(error), before); assert.equal(Object.isFrozen(diagnostic), true);
  assert.deepEqual(Object.keys(diagnostic), ['operation', 'stage', 'code']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-|url|token|body|user|cause|stack/);
});
test('invalid diagnostic values, untrusted error fields and throwing getters cannot affect error handling', () => {
  const error = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing');
  rememberAssignmentReadFailure(error, { operation: 'private-owner', stage: 'private-url', code: 'private-token' } as any);
  assert.deepEqual(assignmentReadFailureDiagnostic(error, 'detail'), { operation: 'unknown', stage: 'unknown', code: 'unknown' });
  assert.deepEqual(assignmentReadFailureDiagnostic(Object.assign(new Error('private-message'), { code: 'unexpected_response', stage: 'projection' }), 'list'),
    { operation: 'list', stage: 'unknown', code: 'unknown' });
  const throwing = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing');
  Object.defineProperty(throwing, 'code', { get() { throw new Error('private-getter'); } });
  assert.deepEqual(assignmentReadFailureDiagnostic(throwing, 'detail', 'projection'), { operation: 'detail', stage: 'projection', code: 'unknown' });
  assert.doesNotThrow(() => rememberAssignmentReadFailure(throwing, { get operation() { throw new Error('private-getter'); } } as any));
});

type Operation = 'list' | 'detail';
function fixture(mode?: 'school' | 'projection' | 'catalog' | 'cas') {
  const key = randomBytes(32), owner = randomUUID();
  const scope = async () => {};
  let state = encryptSchoolSession({ version: 1, generation: randomUUID(), identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu'), loads = 0;
  const values = new Map<string, { value: any; expiresAt: number }>();
  const durable: SchoolReadCache = { get: async scope => values.get(scope.resource) as any ?? null,
    put: async (scope, value, ttl) => { values.set(scope.resource, { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true; }, delete: async () => {} };
  const reader = () => createLearningxReader({ getEncryptedSchoolSession: async () => state,
    replaceEncryptedSchoolSession: async (_owner, _provider, previous, next) => { if (mode === 'cas' || previous !== state) return false; state = next; return true; } }, key,
    async () => ({ client: { terms: async () => { if (mode === 'catalog') throw new SchoolError('upstream_unavailable'); return [{ id: '1', name: 'Synthetic term', default: true }]; },
      courses: async () => [{ id: '10', name: 'Synthetic course', termId: '1' }],
      assignments: async () => { loads++; if (mode === 'school') throw new SchoolError('unexpected_response'); const value = assignmentListFixture(); if (mode === 'projection') value.courseId = '20'; return value; },
      assignmentDetail: async () => { loads++; if (mode === 'school') throw new SchoolError('unexpected_response'); const value = assignmentFixture(); if (mode === 'projection') value.courseId = '20'; return value; },
    } as unknown as LearningxClient, serialize: async () => ({}) }), undefined, durable, undefined, null);
  const read = (r: ReturnType<typeof reader>, operation: Operation) => operation === 'list' ? r.readAssignments!(owner, '10', { signal: AbortSignal.timeout(5000), validate: scope })
    : r.readAssignment!(owner, '10', '90', { signal: AbortSignal.timeout(5000), validate: scope });
  return { reader, read, values, scope, loads: () => loads };
}
test('both assignment operations preserve raw school and projection codes across public error normalization without retry', async () => {
  for (const operation of ['list', 'detail'] as const) for (const mode of ['school', 'projection'] as const) {
    const f = fixture(mode);
    await assert.rejects(f.read(f.reader(), operation), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, 502); assert.equal(error.code, 'SCHOOL_UPSTREAM_UNAVAILABLE');
      assert.deepEqual(assignmentReadFailureDiagnostic(error, operation, 'unknown', f.scope), { operation, stage: mode === 'school' ? 'school_read' : 'projection', code: 'unexpected_response' }); return true;
    }); assert.equal(f.loads(), 1);
  }
});
test('catalog and final school-session CAS failures retain their exact stages and existing response codes', async () => {
  for (const operation of ['list', 'detail'] as const) for (const mode of ['catalog', 'cas'] as const) {
    const f = fixture(mode);
    await assert.rejects(f.read(f.reader(), operation), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, mode === 'catalog' ? 502 : 409);
      assert.deepEqual(assignmentReadFailureDiagnostic(error, operation, 'unknown', f.scope), { operation, stage: mode === 'catalog' ? 'owned_catalog' : 'final_session', code: mode === 'catalog' ? 'upstream_unavailable' : 'SCHOOL_SESSION_CHANGED' }); return true;
    }); assert.equal(f.loads(), mode === 'catalog' ? 0 : 1);
  }
});
test('a rejecting cached catalog proof is distinguished before another school read while preserving authorization failure', async () => {
  for (const operation of ['list', 'detail'] as const) {
    const f = fixture(); await f.read(f.reader(), operation);
    f.values.get('catalog:all')!.value.courses = [];
    await assert.rejects(f.read(f.reader(), operation), error => {
      assert.ok(error instanceof AppError); assert.equal(error.statusCode, 404);
      assert.deepEqual(assignmentReadFailureDiagnostic(error, operation, 'unknown', f.scope), { operation, stage: 'cache_proof', code: 'NOT_FOUND' }); return true;
    }); assert.equal(f.loads(), 1);
  }
});

test('only list/detail failures log sanitized evidence and a throwing logger preserves original responses', async () => {
  const records: unknown[] = [], failure = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing normalized message');
  let throwLogger = false, success = false;
  const session = { user: { id: 'private-owner' }, tokenHash: 'private-hash' }, headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43) };
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), { getSession: async () => session } as unknown as Store,
    { ...unavailableSchoolProvider, assignments: async () => { if (!success) throw new AppError(503, 'ASSIGNMENTS_UNAVAILABLE', 'existing list message'); return assignmentListFixture(); },
      assignment: async (_context, _course, _id, options) => { if (!success) { rememberAssignmentReadFailure(failure, { operation: 'detail', stage: 'projection', code: 'unexpected_response' }, options.validate); throw failure; } return assignmentFixture(); }, assignmentFile: async () => { throw failure; } });
  app.addHook('onRequest', async request => { request.log.warn = ((value: unknown) => { if (throwLogger) throw new Error('private-logger'); records.push(value); }) as typeof request.log.warn; });
  try {
    const response = await app.inject({ url: '/v1/courses/10/assignments/90', headers });
    assert.equal(response.statusCode, 502); assert.equal(response.json().error.message, 'existing normalized message');
    assert.doesNotMatch(response.body, /projection|assignment_read_failed|operation|stage/);
    assert.deepEqual(records, [{ event: 'assignment_read_failed', operation: 'detail', stage: 'projection', code: 'unexpected_response' }]);
    await app.inject({ url: '/v1/courses/10/assignments', headers });
    assert.deepEqual(records.at(-1), { event: 'assignment_read_failed', operation: 'list', stage: 'school_read', code: 'ASSIGNMENTS_UNAVAILABLE' });
    const count = records.length; await app.inject({ url: '/v1/courses/10/assignments/90/files/7', headers }); assert.equal(records.length, count);
    assert.doesNotMatch(JSON.stringify(records), /private-|url|token|body|user|cause|stack/);
    throwLogger = true; const loggingFailed = await app.inject({ url: '/v1/courses/10/assignments/90', headers });
    assert.equal(loggingFailed.statusCode, 502); assert.equal(loggingFailed.json().error.code, 'SCHOOL_UPSTREAM_UNAVAILABLE');
    assert.equal(loggingFailed.json().error.message, 'existing normalized message');
    throwLogger = false; success = true; const completed = await app.inject({ url: '/v1/courses/10/assignments/90', headers });
    assert.equal(completed.statusCode, 200); assert.equal(records.length, count);
  } finally { await app.close(); }
});
test('shared provider errors cannot leak another request operation or stage in either request order', async () => {
  const failure = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing'), records: unknown[] = [];
  let phase: 'school_read' | 'projection' = 'school_read';
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), { getSession: async () => ({ user: { id: 'private-owner' }, tokenHash: 'private-hash' }) } as unknown as Store,
    { ...unavailableSchoolProvider,
      assignments: async (_context, _course, options) => { rememberAssignmentReadFailure(failure, { operation: 'list', stage: phase, code: 'SCHOOL_UPSTREAM_UNAVAILABLE' }, options.validate); throw failure; },
      assignment: async (_context, _course, _id, options) => { rememberAssignmentReadFailure(failure, { operation: 'detail', stage: phase, code: 'SCHOOL_UPSTREAM_UNAVAILABLE' }, options.validate); throw failure; } });
  app.addHook('onRequest', async request => { request.log.warn = ((value: unknown) => records.push(value)) as typeof request.log.warn; });
  try { for (const operation of ['list', 'detail', 'detail', 'list'] as const) {
    phase = phase === 'school_read' ? 'projection' : 'school_read';
    const result = await app.inject({ url: '/v1/courses/10/assignments' + (operation === 'detail' ? '/90' : ''), headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) } });
    assert.equal(result.statusCode, 502); assert.deepEqual(records.at(-1), { event: 'assignment_read_failed', operation, stage: phase, code: 'SCHOOL_UPSTREAM_UNAVAILABLE' });
  } } finally { await app.close(); }
});
test('route-level final ALMS authorization failure records final_session without changing the 401 response', async () => {
  let checks = 0; const records: unknown[] = [];
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), { getSession: async () => ++checks === 3 ? null : { user: { id: 'private-owner' }, tokenHash: 'private-hash' } } as unknown as Store,
    { ...unavailableSchoolProvider, assignment: async () => assignmentFixture() });
  app.addHook('onRequest', async request => { request.log.warn = ((value: unknown) => records.push(value)) as typeof request.log.warn; });
  try { const response = await app.inject({ url: '/v1/courses/10/assignments/90', headers: { cookie: '__Host-alms_session=' + 'a'.repeat(43) } });
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'AUTH_REQUIRED');
    assert.deepEqual(records, [{ event: 'assignment_read_failed', operation: 'detail', stage: 'final_session', code: 'AUTH_REQUIRED' }]);
  } finally { await app.close(); }
});
