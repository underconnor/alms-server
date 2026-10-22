import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SchoolError } from '@alms/ssu-api';
import { z } from 'zod';
import { AppError } from '../src/errors.js';
import { authFailureDiagnostic, rememberAuthFailure } from '../src/auth-diagnostics.js';
import { createSchoolProvider } from '../src/school-adapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';

test('auth diagnostics allow only fixed stage/code and preserve public errors without raw evidence', () => {
  const school = Object.assign(new SchoolError('authentication_required'), { url: 'private-url', cause: new Error('private-cause') });
  const normalized = new AppError(401, 'SCHOOL_AUTH_FAILED', 'Existing public message');
  const before = JSON.stringify(normalized);
  rememberAuthFailure(normalized, authFailureDiagnostic(school, 'school_identity'));
  assert.deepEqual(authFailureDiagnostic(normalized), { stage: 'school_identity', code: 'authentication_required' });
  assert.equal(JSON.stringify(normalized), before);
  assert.deepEqual(Object.keys(authFailureDiagnostic(normalized)), ['stage', 'code']);
  assert.doesNotMatch(JSON.stringify(authFailureDiagnostic(normalized)), /private-|url|cause/);
  const extra = { stage: 'lms_exchange', code: 'identity_mismatch', url: 'private-url', token: 'private-token' };
  rememberAuthFailure(normalized, extra as any); extra.stage = 'private-stage'; extra.code = 'private-code';
  assert.deepEqual(authFailureDiagnostic(normalized), { stage: 'lms_exchange', code: 'identity_mismatch' });
  assert.deepEqual(authFailureDiagnostic(Object.assign(new Error('private-error'), { stage: 'school_identity', code: 'authentication_required' })),
    { stage: 'unknown', code: 'unknown' });
  rememberAuthFailure(normalized, { stage: 'private-token', code: 'private-student' } as any);
  assert.deepEqual(authFailureDiagnostic(normalized), { stage: 'unknown', code: 'unknown' });
  const invalid = z.literal(true).safeParse('private-value');
  assert.deepEqual(authFailureDiagnostic(invalid.error, 'session_issue'), { stage: 'session_issue', code: 'invalid_request' });
});

test('adapter keeps the last fatal stage and original fixed school code through callback normalization', async () => {
  const studentId = '90000001', privateToken = 'synthetic-private-token';
  for (const accept of ['application/json', 'text/html']) for (const scenario of [
    { at: 'prepare', stage: 'lms_preparation', code: 'identity_mismatch', status: 401 },
    { at: 'exchange', stage: 'lms_exchange', code: 'identity_mismatch', status: 401 },
    { at: 'verify', stage: 'school_identity', code: 'authentication_required', status: 401 },
    { at: 'verify', stage: 'school_identity', code: 'identity_mismatch', status: 401 },
    { at: 'verify', stage: 'school_identity', code: 'upstream_unavailable', status: 502 },
    { at: 'verify', stage: 'school_identity', code: 'unexpected_response', status: 502 },
    { at: 'verify', stage: 'school_identity', code: 'forbidden_target', status: 502 },
    { at: 'verify', stage: 'school_identity', code: 'unsupported', status: 502 },
    { at: 'serialize', stage: 'provider_session', code: 'unknown', status: 502 },
  ] as const) {
    const steps: string[] = [], records: unknown[] = [], attempts = new Map<string, string>(); let issued = 0;
    const failure = Object.assign(scenario.code === 'unknown' ? new Error('private-raw-error') : new SchoolError(scenario.code),
      { url: 'https://private.test/token', studentId, cause: new Error('private-cause'), body: 'private-body' });
    const provider = createSchoolProvider(true, undefined, {
      prepare: async () => { steps.push('prepare'); if (scenario.at === 'prepare') throw failure; },
      exchange: async () => {
        steps.push('exchange'); if (scenario.at === 'exchange') throw failure;
        // This earlier nonfatal LMS failure must not replace a later portal/serialization failure.
        throw new SchoolError('unexpected_response');
      },
      verify: async http => {
        steps.push('verify'); if (scenario.at === 'verify') throw failure;
        Object.defineProperty(http.jar, 'serialize', { value: async () => { steps.push('serialize'); throw failure; } });
        return { studentId, displayName: 'Synthetic name', department: null, status: null };
      },
    });
    const store = { createLoginAttempt: async (state: string, binding: string) => { attempts.set(state, binding); },
      consumeLoginAttempt: async (state: string, binding: string) => { if (attempts.get(state) !== binding) return false; attempts.delete(state); return true; },
      issueVerifiedSession: async () => { issued++; throw new Error('session issuer must not run'); } } as unknown as Store;
    const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent',
      SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }), store, provider);
    app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
    try {
      const start = await app.inject('/v1/auth/login');
      const callback = new URL(new URL(start.json().url).searchParams.get('apiReturnUrl')!);
      const nonce = callback.pathname.split('/').at(-1)!;
      const cookie = String(start.headers['set-cookie']).split(';')[0]!;
      const response = await app.inject({ url: callback.pathname + '?' + new URLSearchParams({ sToken: privateToken, sIdno: studentId }), headers: { cookie, accept } });
      if (accept === 'text/html') {
        assert.equal(response.statusCode, 303);
        assert.equal(response.headers.location, 'https://lms.flyjung.kr/#/login?reason=' + (scenario.status === 401 ? 'school_auth_failed' : 'school_upstream_unavailable'));
      } else {
        assert.equal(response.statusCode, scenario.status);
        assert.equal(response.json().error.code, scenario.status === 401 ? 'SCHOOL_AUTH_FAILED' : 'SCHOOL_UPSTREAM_UNAVAILABLE');
      }
      assert.deepEqual(records, [{ event: 'auth_callback_failed', stage: scenario.stage, code: scenario.code,
        lmsExchange: {status: 'failed', stage: 'unknown', code: scenario.at === 'prepare' || scenario.at === 'exchange' ? 'identity_mismatch' : 'unexpected_response'},
        schoolTrace: [], fetchDestination: 'unknown', tokenParsedSpace: false, tokenQueryLiteralPlus: false,
        tokenQueryEncodedPlus: false, tokenInQuery: true }]);
      for (const value of [nonce, cookie, studentId, privateToken, 'private-', 'cause', 'url', 'body']) assert.equal(JSON.stringify(records).includes(value), false);
      assert.doesNotMatch(response.body + JSON.stringify(response.headers), /private-|auth_callback_failed|school_identity|provider_session/);
      assert.doesNotMatch(String(response.headers['set-cookie']), /__Host-alms_session=/);
      assert.equal(issued, 0); assert.equal(attempts.size, 0);
      assert.deepEqual(steps, scenario.at === 'prepare' ? ['prepare'] : scenario.at === 'exchange' ? ['prepare', 'exchange']
        : scenario.at === 'serialize' ? ['prepare', 'exchange', 'verify', 'serialize'] : ['prepare', 'exchange', 'verify']);
    } finally { await app.close(); }
  }
});

test('recoverable LMS exchange failure followed by verified portal identity has no fatal auth evidence', async () => {
  const provider = createSchoolProvider(true, undefined, {
    prepare: async () => {}, exchange: async () => { throw new SchoolError('upstream_unavailable'); },
    verify: async () => ({ studentId: '90000001', displayName: 'Synthetic', department: null, status: null }),
  });
  const result = await provider.auth!.verifyCallback({ sIdno: '90000001', sToken: 'private-token' });
  assert.equal(result.subject, '90000001');
  assert.deepEqual((result.schoolSession as any).lmsExchange, { status: 'failed', stage: 'unknown', code: 'upstream_unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /auth_callback_failed|callback_binding|school_identity|private-token/);
  const records: unknown[] = []; let issued = 0;
  const store = { consumeLoginAttempt: async () => true,
    issueVerifiedSession: async () => { issued++; return { token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60_000).toISOString() }; } } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }), store, provider);
  app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
  try {
    const response = await app.inject({ url: '/v1/auth/callback/' + 'a'.repeat(43) + '?sIdno=90000001&sToken=private-token',
      headers: { accept: 'text/html', cookie: '__Host-alms_login=' + 'b'.repeat(43) } });
    assert.equal(response.statusCode, 303); assert.equal(response.headers.location, 'https://lms.flyjung.kr/');
    assert.match(String(response.headers['set-cookie']), /__Host-alms_session=/);
    assert.equal(issued, 1); assert.deepEqual(records, []);
  } finally { await app.close(); }
});
