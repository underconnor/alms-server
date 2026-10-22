import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, SchoolMaterialViewError } from '@alms/ssu-api';
import { z } from 'zod';
import { AppError } from '../src/errors.js';
import { materialViewFailureDiagnostic, rememberMaterialViewFailure } from '../src/material-view-diagnostics.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';

test('material failure evidence copies only fixed stages and error codes without mutating the error', () => {
  for (const stage of ['validation', 'callback', 'refresh'] as const) {
    const error = Object.assign(new SchoolMaterialViewError('unexpected_response', stage), {
      url: 'https://private.test/private-token', studentId: 'private-student', body: 'private-body', cause: new Error('private-cause'),
    });
    assert.deepEqual(materialViewFailureDiagnostic(error), { stage, code: 'unexpected_response' });
  }
  const error = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing public error');
  const before = JSON.stringify(error);
  const raw = { stage: 'callback', code: 'upstream_unavailable', url: 'private-url' };
  rememberMaterialViewFailure(error, raw as any); raw.stage = 'private-stage';
  assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'callback', code: 'upstream_unavailable' });
  assert.equal(JSON.stringify(error), before);
  assert.deepEqual(Object.keys(materialViewFailureDiagnostic(error)), ['stage', 'code']);
});

test('unverified error properties and invalid enum values cannot become material diagnostics', () => {
  assert.deepEqual(materialViewFailureDiagnostic(Object.assign(new Error('private-message'), { stage: 'callback', code: 'unexpected_response' })),
    { stage: 'unknown', code: 'unknown' });
  const error = Object.assign(new SchoolMaterialViewError('unexpected_response', 'callback'), { stage: 'private-stage', code: 'private-token' });
  assert.deepEqual(materialViewFailureDiagnostic(error), { stage: 'unknown', code: 'unknown' });
  const normalized = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'existing');
  rememberMaterialViewFailure(normalized, { stage: 'private-stage', code: 'private-token' } as any);
  assert.deepEqual(materialViewFailureDiagnostic(normalized), { stage: 'unknown', code: 'unknown' });
  assert.deepEqual(materialViewFailureDiagnostic(new SchoolError('upstream_unavailable')),
    { stage: 'unknown', code: 'upstream_unavailable' });
  const invalid = z.object({ only: z.literal(true) }).safeParse({ only: 'private-value' });
  assert.equal(invalid.success, false);
  assert.deepEqual(materialViewFailureDiagnostic(invalid.error), { stage: 'validation', code: 'invalid_request' });
  assert.deepEqual(materialViewFailureDiagnostic(invalid.error, 'finalization'), { stage: 'finalization', code: 'invalid_request' });
  assert.deepEqual(materialViewFailureDiagnostic(invalid.error, 'unknown'), { stage: 'unknown', code: 'invalid_request' });
});

test('material-view logging is restricted to fixed evidence and leaves HTTP failures and success unchanged', async () => {
  const records: unknown[] = [];
  const store = { getSession: async () => ({ user: { id: 'private-owner' }, csrfToken: 'private-csrf', tokenHash: 'private-hash' }) } as unknown as Store;
  let failure: unknown = new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'public normalized message');
  rememberMaterialViewFailure(failure, { stage: 'refresh', code: 'upstream_unavailable' });
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }), store, {
    ...unavailableSchoolProvider,
    recordMaterialView: async () => { if (failure) throw failure; return { report: 'recorded', activity: { completed: false } }; },
    activity: async () => { throw new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'public normalized message'); },
  });
  app.addHook('onRequest', async request => { request.log.warn = ((value: unknown) => records.push(value)) as typeof request.log.warn; });
  const url = '/v1/courses/private-course/activities/private-activity/view';
  const headers = { origin: 'https://lms.flyjung.kr', cookie: '__Host-alms_session=' + 'a'.repeat(43), 'x-csrf-token': 'private-csrf' };
  const payload = { event: 'opened', page: 1, totalPages: 3, viewedPages: [1] };
  try {
    const response = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'SCHOOL_UPSTREAM_UNAVAILABLE');
    assert.equal(response.json().error.message, 'public normalized message');
    assert.doesNotMatch(response.body, /stage|refresh|material_view_failed/);
    assert.deepEqual(records, [{ event: 'material_view_failed', stage: 'refresh', code: 'upstream_unavailable' }]);
    assert.doesNotMatch(JSON.stringify(records), /private-|url|token|student|body|cause|page|totalPages|course|activity/);
    const invalid = await app.inject({ method: 'POST', url, headers, payload: { ...payload, url: 'private-url' } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(records.at(-1), { event: 'material_view_failed', stage: 'validation', code: 'invalid_request' });
    const anonymous = await app.inject({ method: 'POST', url, payload });
    assert.equal(anonymous.statusCode, 401);
    assert.deepEqual(records.at(-1), { event: 'material_view_failed', stage: 'validation', code: 'auth_required' });
    const csrf = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf-token': 'wrong' }, payload });
    assert.equal(csrf.statusCode, 403);
    assert.deepEqual(records.at(-1), { event: 'material_view_failed', stage: 'validation', code: 'csrf_invalid' });
    const count = records.length;
    await app.inject({ url: '/v1/courses/private-course/activities/private-activity', headers });
    assert.equal(records.length, count);
    failure = null;
    const success = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(success.statusCode, 200); assert.equal(success.json().activity.completed, false);
    assert.equal(records.length, count);
  } finally { await app.close(); }
});
