import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {SchoolError, SchoolSsoVerificationError, LmsExchangeError, verifySchoolSso, type LearningxClient} from '@alms/ssu-api';
import {authFailureDiagnostic, rememberAuthFailure, authFetchDestination, createAuthHttpTrace,
  rememberAuthContext, authCallbackContext} from '../src/auth-diagnostics.js';
import {createSchoolProvider} from '../src/school-adapter.js';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import type {Store} from '../src/store.js';

test('verification fields require the SDK class and a fixed stage/code/shape combination', () => {
  const known = Object.assign(new SchoolSsoVerificationError('authentication_required', 'identity_parse', false, 'missing_student'),
    {body: 'private-body', cause: new Error('private-cause'), studentId: '90000001'});
  assert.deepEqual(authFailureDiagnostic(known, 'school_identity'), {stage: 'school_identity', code: 'authentication_required',
    verificationStage: 'identity_parse', identityShape: 'missing_student'});
  for (const value of [new Error('private-error'), new SchoolError('authentication_required')]) {
    Object.assign(value, {verificationStage: 'identity_parse', identityShape: 'missing_both'});
    assert.equal(authFailureDiagnostic(value).verificationStage, undefined);
  }
  Object.assign(known, {verificationStage: 'private-stage', identityShape: 'private-shape'});
  assert.deepEqual(authFailureDiagnostic(known, 'school_identity'), {stage: 'school_identity', code: 'authentication_required'});
  Object.assign(known, {verificationStage: 'identity_parse', identityShape: 'id_mismatch'});
  assert.equal(authFailureDiagnostic(known).identityShape, undefined);
});

test('same-attempt context is bounded, copied and stripped rather than serialized as arbitrary objects', () => {
  const row = {method: 'GET', origin: 'saint', pathRole: 'saint_identity_page', status: 200,
    url: 'private-url', cookie: 'private-cookie', studentId: '90000001'};
  const raw = {stage: 'school_identity', code: 'authentication_required', lmsExchange: {
    status: 'failed', stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: 'csrf_shape', body: 'private-body'},
    schoolTrace: Array(25).fill(row), url: 'private-url'};
  const error = new Error('private-error'); rememberAuthFailure(error, raw as any);
  const evidence = authFailureDiagnostic(error);
  assert.equal(evidence.schoolTrace?.length, 20); assert.ok(Object.isFrozen(evidence.schoolTrace));
  assert.deepEqual(evidence.lmsExchange, {status: 'failed', stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: 'csrf_shape'});
  row.status = 500; raw.lmsExchange.canvasParseReason = 'private-value';
  assert.equal(evidence.schoolTrace?.[0]?.status, 200); assert.ok(Object.isFrozen(evidence.schoolTrace?.[0]));
  assert.doesNotMatch(JSON.stringify(evidence), /private-|90000001|url|cookie|body/);
  rememberAuthFailure(error, {stage: 'unknown', code: 'unknown', lmsExchange: {status: 'failed', stage: 'private-stage', code: 'private-code'},
    schoolTrace: [null, {...row, origin: 'private-origin'}, {...row, method: 'DELETE'}, {...row, status: 999}]} as any);
  assert.deepEqual(authFailureDiagnostic(error), {stage: 'unknown', code: 'unknown', schoolTrace: []});
  const result = {}; rememberAuthContext(result, {lmsExchange: {status: 'ready'}, schoolTrace: []});
  assert.deepEqual(authCallbackContext(result), {lmsExchange: {status: 'ready'}, schoolTrace: []});
  assert.deepEqual(result, {}); assert.deepEqual(authCallbackContext({...result}), {});
});

test('fetch destination has only five fixed values and never retains the raw header', () => {
  for (const value of ['document', 'iframe', 'empty'] as const) assert.equal(authFetchDestination(value), value);
  for (const value of ['private-header', ['document', 'iframe'], null, 5]) assert.equal(authFetchDestination(value), 'other');
  assert.equal(authFetchDestination(undefined), 'unknown'); assert.equal(authFetchDestination(''), 'unknown');
});

test('HTTP observation keeps exact arguments, response and errors while bounding only its metadata', async () => {
  const response = new Response('private-body', {status: 201, headers: {'set-cookie': 'private-cookie'}});
  const init: RequestInit = {method: 'POST', body: 'private-body', headers: {authorization: 'private-token'}, redirect: 'manual'};
  const input = 'https://canvas.ssu.ac.kr/login/canvas?private=query'; let requests = 0;
  const trace = createAuthHttpTrace(async (actualInput, actualInit) => {
    requests++; assert.equal(actualInput, input); assert.equal(actualInit, init); return response;
  });
  for (let i = 0; i < 25; i++) assert.equal(await trace.fetch(input, init), response);
  assert.equal(requests, 25); assert.equal(response.bodyUsed, false); assert.equal(trace.snapshot().length, 20);
  assert.deepEqual(trace.snapshot()[0], {method: 'POST', origin: 'canvas', pathRole: 'canvas_login', status: 201});
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /private|query|body|cookie|authorization|https/);
  const original = new Error('private-network-error'), failed = createAuthHttpTrace(async () => {throw original;});
  await assert.rejects(failed.fetch(input, init), error => error === original); assert.deepEqual(failed.snapshot(), []);
});

const studentId = '90000001', artifact = {sIdno: studentId, sToken: 'private-callback-token'};
const emptyPortalMarkup = {identityContainerPresent: false, studentRowPresent: false, studentValuePresent: false,
  nameValuePresent: false, passwordFormPresent: false};
const identityHtml = `<div class="main_box09"><span>Synthetic님</span></div><ul class="main_box09_con"><li><dt>학번</dt><strong>${studentId}</strong></li></ul>`;
async function callbackFixture(options: {exchangeFails?: boolean; identitySucceeds?: boolean; issueFails?: boolean; ssoStatus?: number; portalHtml?: string} = {}) {
  const calls: Array<{path: string; method: string}> = [], records: any[] = []; let issued = 0, consumed = false;
  const provider = createSchoolProvider(true, undefined, {
    prepare: async http => {await http.get('https://lms.ssu.ac.kr/mypage');},
    exchange: async http => {
      if (options.exchangeFails) throw new LmsExchangeError('unexpected_response', 'canvas_form', false, undefined, 'csrf_shape');
      await http.submitCanvasLogin({studentId, issuedPassword: 'private-issued-value', authenticityToken: null});
      return {} as LearningxClient;
    },
    verify: verifySchoolSso,
  }, undefined, async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push({path, method: init?.method ?? 'GET'});
    const status = path === '/webSSO/sso.jsp' ? options.ssoStatus ?? 200 : 200;
    return new Response(path === '/webSSUMain/main_student.jsp' ? options.identitySucceeds ? identityHtml : options.portalHtml ?? 'private-school-body' : 'private-school-body',
      {status, headers: {'content-type': 'text/html'}});
  });
  const store = {consumeLoginAttempt: async () => {if (consumed) return false; consumed = true; return true;},
    issueVerifiedSession: async () => {issued++; if (options.issueFails) throw new Error('private-database-error');
      return {token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60000).toISOString()};}} as unknown as Store;
  const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64')}), store, provider);
  app.addHook('onRequest', async request => {request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn;});
  const callback = (accept: string, destination: string) => app.inject({url: '/v1/auth/callback/' + 'a'.repeat(43) + '?' + new URLSearchParams(artifact),
    headers: {accept, cookie: '__Host-alms_login=' + 'b'.repeat(43), 'sec-fetch-dest': destination}});
  return {app, calls, records, callback, issued: () => issued};
}

test('final JSON/HTML failures retain current exchange and real synthetic response trace exactly once', async () => {
  for (const accept of ['text/html', 'application/json']) for (const exchangeFails of [false, true]) {
    const f = await callbackFixture({exchangeFails});
    try {
      const response = await f.callback(accept, 'iframe');
      assert.equal(response.statusCode, accept === 'text/html' ? 303 : 401); assert.equal(f.records.length, 1); assert.equal(f.issued(), 0);
      assert.deepEqual(f.records[0], {event: 'auth_callback_failed', stage: 'school_identity', code: 'authentication_required',
        verificationStage: 'identity_parse', identityShape: 'missing_both', fetchDestination: 'iframe',
        tokenParsedSpace: false, tokenQueryLiteralPlus: false, tokenQueryEncodedPlus: false, tokenInQuery: true,
        portalShape: 'unknown', portalMarkup: emptyPortalMarkup,
        portalNavigation: {scriptPlacement: 'none', scriptTarget: 'none', formTarget: 'none', metaRefreshTarget: 'none'},
        lmsExchange: exchangeFails ? {status: 'failed', stage: 'canvas_form', code: 'unexpected_response', canvasParseReason: 'csrf_shape'} : {status: 'ready'},
        schoolTrace: [{method: 'GET', origin: 'lms', pathRole: 'lms_home', status: 200},
          ...(!exchangeFails ? [{method: 'POST', origin: 'canvas', pathRole: 'canvas_login', status: 200}] : []),
          {method: 'GET', origin: 'saint', pathRole: 'saint_sso_entry', status: 200},
          {method: 'GET', origin: 'saint', pathRole: 'saint_identity_page', status: 200}]});
      assert.deepEqual(f.calls.map(row => row.path), ['/mypage', ...(!exchangeFails ? ['/login/canvas'] : []), '/webSSO/sso.jsp', '/webSSUMain/main_student.jsp']);
      assert.doesNotMatch(JSON.stringify(f.records) + response.body, /private-|90000001|Synthetic|verificationStage.*private|sToken|sIdno/);
      if (accept === 'text/html') assert.equal(response.headers.location, 'https://lms.flyjung.kr/#/login?reason=school_auth_failed');
      else assert.equal(response.json().error.code, 'SCHOOL_AUTH_FAILED');
      const count = f.calls.length; await f.callback(accept, 'document');
      assert.equal(f.calls.length, count); assert.equal(f.records.length, 2);
      assert.deepEqual(f.records[1], {event: 'auth_callback_failed', stage: 'callback_binding', code: 'invalid_callback', fetchDestination: 'document',
        tokenParsedSpace: false, tokenQueryLiteralPlus: false, tokenQueryEncodedPlus: false, tokenInQuery: true,
        bindingFailure: 'attempt_rejected', sameAttemptPreviouslyIssuedSession: false});
    } finally {await f.app.close();}
  }
});

test('portal shape is log-only for final JSON and HTML failures with the same request sequence and cookie behavior', async () => {
  for (const accept of ['application/json', 'text/html']) {
    const f = await callbackFixture({portalHtml: '<script>top.location.href="/private-location?token=private-value";</script>'});
    try {
      const response = await f.callback(accept, 'document');
      assert.equal(response.statusCode, accept === 'text/html' ? 303 : 401);
      assert.equal(f.issued(), 0); assert.equal(f.records.length, 1);
      assert.equal(f.records[0].stage, 'school_identity'); assert.equal(f.records[0].code, 'authentication_required');
      assert.equal(f.records[0].verificationStage, 'identity_parse'); assert.equal(f.records[0].identityShape, 'missing_both');
      assert.equal(f.records[0].portalShape, 'literal_navigation'); assert.deepEqual(f.records[0].portalMarkup, emptyPortalMarkup);
      assert.deepEqual(f.records[0].portalNavigation, {scriptPlacement: 'outer_statement', scriptTarget: 'other', formTarget: 'none', metaRefreshTarget: 'none'});
      assert.deepEqual(f.records[0].lmsExchange, {status: 'ready'});
      assert.deepEqual(f.calls.map(row => row.path), ['/mypage', '/login/canvas', '/webSSO/sso.jsp', '/webSSUMain/main_student.jsp']);
      assert.doesNotMatch(JSON.stringify(f.records), /private-|90000001|sToken|sIdno|href|https/);
      assert.doesNotMatch(response.body + JSON.stringify(response.headers), /portalShape|portalMarkup|literal_navigation|private-/);
      assert.doesNotMatch(String(response.headers['set-cookie']), /__Host-alms_session=/);
      if (accept === 'text/html') assert.equal(response.headers.location, 'https://lms.flyjung.kr/#/login?reason=school_auth_failed');
      else assert.equal(response.json().error.code, 'SCHOOL_AUTH_FAILED');
    } finally { await f.app.close(); }
  }
});

test('SSO HTTP failure is classified before portal parsing and does not repeat any request', async () => {
  const f = await callbackFixture({ssoStatus: 403});
  try {
    await f.callback('application/json', 'empty');
    assert.equal(f.records[0].verificationStage, 'sso_entry'); assert.equal(f.records[0].identityShape, undefined);
    assert.equal(f.records[0].schoolTrace.at(-1).status, 403); assert.equal(f.records[0].fetchDestination, 'empty');
    assert.deepEqual(f.calls.map(row => row.path), ['/mypage', '/login/canvas', '/webSSO/sso.jsp']);
  } finally {await f.app.close();}
});

test('provider success context survives session issue failure but is absent from successful response/logs', async () => {
  for (const issueFails of [false, true]) {
    const f = await callbackFixture({identitySucceeds: true, issueFails});
    try {
      const response = await f.callback('application/json', 'private-untrusted-header'); assert.equal(f.issued(), 1);
      if (issueFails) {
        assert.equal(response.statusCode, 500); assert.equal(f.records.length, 1);
        assert.equal(f.records[0].stage, 'session_issue'); assert.equal(f.records[0].code, 'unknown');
        assert.deepEqual(f.records[0].lmsExchange, {status: 'ready'}); assert.equal(f.records[0].schoolTrace.length, 4);
        assert.equal(f.records[0].fetchDestination, 'other');
      } else {
        assert.equal(response.statusCode, 303); assert.equal(response.headers.location, 'https://lms.flyjung.kr/'); assert.deepEqual(f.records, []);
      }
      assert.doesNotMatch(response.body, /schoolTrace|lmsExchange|verificationStage|private-/);
    } finally {await f.app.close();}
  }
});
