import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import type { Store } from '../src/store.js';

const frontend = 'https://lms.flyjung.kr/';
const syntheticToken = 'synthetic-private-token';
const subject = '90000001';
const queryTokenShape = { tokenParsedSpace: false, tokenQueryLiteralPlus: false, tokenQueryEncodedPlus: false, tokenInQuery: true };
const diagnosticWithoutTokenShape = (records: unknown[]) => JSON.stringify(records.map(record =>
  Object.fromEntries(Object.entries(record as Record<string, unknown>).filter(([key]) => !Object.hasOwn(queryTokenShape, key)))));
async function fixture(options: { loginUrl?: string; startFailure?: Error; identitySubject?: string; artifactToken?: string;
  beforeVerification?: () => Promise<void> } = {}) {
  const attempts = new Map<string,string>();
  let failure: Error | null = null; let databaseFailure = false;
  let verified = 0; let issued = 0;
  const store = {
    createLoginAttempt: async (state: string,binding: string) => { if (options.startFailure) throw options.startFailure; attempts.set(state,binding); },
    consumeLoginAttempt: async (state: string,binding: string) => {
      if (attempts.get(state) !== binding) return false;
      attempts.delete(state); return true;
    },
    issueVerifiedSession: async () => {
      if (databaseFailure) throw new Error('synthetic database credentials must stay private');
      issued++;
      return { token: randomBytes(32).toString('base64url'),expiresAt: new Date(Date.now()+3600000).toISOString() };
    },
  } as unknown as Store;
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused',LOG_LEVEL: 'silent',SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),store,{
    ...unavailableSchoolProvider,
    auth: { providerId: 'synthetic',createLoginUrl: callback => options.loginUrl ?? 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),
      verifyCallback: async ({ sToken,sIdno }) => {
        verified++; assert.equal(sToken,options.artifactToken ?? syntheticToken); assert.equal(sIdno,subject);
        await options.beforeVerification?.();
        if (failure) throw failure; return { subject: options.identitySubject ?? subject,schoolSession: {} };
      } },
  });
  async function begin() {
    const response = await app.inject('/v1/auth/login');
    assert.equal(response.statusCode,200);
    assert.match(String(response.headers['set-cookie']),/Max-Age=900(?:;|$)/);
    const returned = new URL(response.json().url).searchParams.get('apiReturnUrl')!;
    assert.equal(new URL(returned).search,'');
    assert.match(new URL(returned).pathname,/^\/v1\/auth\/callback\/[A-Za-z0-9_-]{43}$/);
    // Match SmartID's observed literal '?' concatenation, not URLSearchParams merging.
    const callback = new URL(returned+'?'+new URLSearchParams({ sToken: syntheticToken,sIdno: subject }));
    return { callback,url: callback.pathname+callback.search,cookie: String(response.headers['set-cookie']).split(';')[0]! };
  }
  return { app,begin,attempts,setFailure: (error: Error | null) => { failure=error; },failDatabase: (value = true) => { databaseFailure=value; },counts: () => ({ verified,issued }) };
}
function assertRedirect(response: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['app']['inject']>>,reason: string) {
  assert.equal(response.statusCode,303);
  assert.equal(response.headers.location,frontend+'#/login?reason='+reason);
  assert.doesNotMatch(JSON.stringify(response.headers)+response.body,new RegExp(syntheticToken+'|'+subject+'|raw-private-detail'));
  assert.doesNotMatch(String(response.headers['set-cookie']),/__Host-alms_session=/);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.headers['referrer-policy'],'no-referrer');
}

test('JSON callback preserves 401 versus 502 and sanitizes provider errors',async () => {
  const f=await fixture();
  try {
    for (const [error,status,code] of [
      [new AppError(401,'SCHOOL_AUTH_FAILED','raw-private-detail'),401,'SCHOOL_AUTH_FAILED'],
      [new AppError(502,'SCHOOL_UPSTREAM_UNAVAILABLE','raw-private-detail'),502,'SCHOOL_UPSTREAM_UNAVAILABLE'],
      [new Error('raw-private-detail'),502,'SCHOOL_UPSTREAM_UNAVAILABLE'],
    ] as const) {
      f.setFailure(error); const attempt=await f.begin();
      const response=await f.app.inject({ url: attempt.url,headers: { cookie: attempt.cookie,accept: 'application/json' } });
      assert.equal(response.statusCode,status); assert.equal(response.json().error.code,code);
      assert.equal(response.headers.location,undefined); assert.ok(response.json().error.requestId);
      assert.doesNotMatch(response.body,/raw-private-detail/);
      assert.doesNotMatch(String(response.headers['set-cookie']),/__Host-alms_session=/);
    }
    assert.equal(f.counts().issued,0);
  } finally { await f.app.close(); }
});

test('HTML GET and form POST callback failures return only the fixed Front reason',async () => {
  const f=await fixture();
  try {
    for (const method of ['GET','POST'] as const) for (const [status,code,reason] of [
      [401,'SCHOOL_AUTH_FAILED','school_auth_failed'],[502,'SCHOOL_UPSTREAM_UNAVAILABLE','school_upstream_unavailable'],
    ] as const) {
      f.setFailure(new AppError(status,code,'raw-private-detail')); const attempt=await f.begin();
      const response=await f.app.inject({ method,url: method==='GET' ? attempt.url : attempt.callback.pathname,
        headers: { cookie: attempt.cookie,accept: 'text/html,application/xhtml+xml,*/*;q=0.8',...(method==='POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method==='POST' ? { payload: new URLSearchParams({ sToken: syntheticToken,sIdno: subject }).toString() } : {}),
      });
      assertRedirect(response,reason);
    }
  } finally { await f.app.close(); }
});

test('invalid, absent or expired browser binding returns login_expired before school verification',async () => {
  const f=await fixture();
  try {
    const attempt=await f.begin();
    for (const cookie of ['', '__Host-alms_login='+randomBytes(32).toString('base64url')]) {
      assertRedirect(await f.app.inject({ url: attempt.url,headers: { cookie,accept: 'text/html' } }),'login_expired');
    }
    f.attempts.clear();
    assertRedirect(await f.app.inject({ url: attempt.url,headers: { cookie: attempt.cookie,accept: 'text/html' } }),'login_expired');
    const invalidState=new URL(attempt.callback); invalidState.pathname='/v1/auth/callback/invalid';
    assertRedirect(await f.app.inject({ url: invalidState.pathname+invalidState.search,headers: { cookie: attempt.cookie,accept: 'text/html' } }),'login_expired');
    assert.deepEqual(f.counts(),{ verified: 0,issued: 0 });
  } finally { await f.app.close(); }
});

test('unexpected callback fields and malformed bodies never reach Front as raw values',async () => {
  const f=await fixture();
  try {
    const attempt=await f.begin();
    assertRedirect(await f.app.inject({ url: attempt.url+'&reason=raw-private-detail&returnTo=https://evil.invalid',headers: { cookie: attempt.cookie,accept: 'text/html' } }),'school_auth_failed');
    const malformed={ method: 'POST' as const,url: attempt.url,headers: { cookie: attempt.cookie,'content-type': 'application/json' },payload: '{"raw-private-detail":' };
    assertRedirect(await f.app.inject({ ...malformed,headers: { ...malformed.headers,accept: 'text/html' } }),'school_auth_failed');
    const json=await f.app.inject({ ...malformed,headers: { ...malformed.headers,accept: 'application/json' } });
    assert.equal(json.statusCode,400); assert.equal(json.json().error.code,'INVALID_REQUEST');
    assert.doesNotMatch(json.body,/raw-private-detail/);
    assert.deepEqual(f.counts(),{ verified: 0,issued: 0 });
  } finally { await f.app.close(); }
});

test('binding diagnostics distinguish missing and invalid cookies from a rejected attempt without exposing values', async () => {
  for (const [kind, cookieKind] of [['missing_cookie', 'missing'], ['invalid_cookie', 'invalid'], ['attempt_rejected', 'different'], ['attempt_rejected', 'expired']] as const) {
    const f = await fixture(); const records: unknown[] = [];
    f.app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
    try {
      const attempt = await f.begin();
      const cookie = cookieKind === 'missing' ? '' : cookieKind === 'invalid' ? '__Host-alms_login=private-invalid-binding'
        : cookieKind === 'different' ? '__Host-alms_login=' + randomBytes(32).toString('base64url') : attempt.cookie;
      if (cookieKind === 'expired') f.attempts.clear();
      const response = await f.app.inject({url: attempt.url, headers: {cookie, accept: 'text/html'}});
      assertRedirect(response, 'login_expired');
      assert.deepEqual(records, [{event: 'auth_callback_failed', stage: 'callback_binding', code: 'invalid_callback', fetchDestination: 'unknown', ...queryTokenShape,
        bindingFailure: kind, sameAttemptPreviouslyIssuedSession: false}]);
      assert.doesNotMatch(diagnosticWithoutTokenShape(records), /private-|token|state|nonce|url|cookie=/);
      assert.deepEqual(f.counts(), {verified: 0, issued: 0});
    } finally { await f.app.close(); }
  }
});

test('failed callbacks stay single-use and a fresh login can succeed',async () => {
  const f=await fixture();
  try {
    f.setFailure(new AppError(502,'SCHOOL_UPSTREAM_UNAVAILABLE','raw-private-detail'));
    const first=await f.begin(); const headers={ cookie: first.cookie,accept: 'text/html' };
    assertRedirect(await f.app.inject({ url: first.url,headers }),'school_upstream_unavailable');
    assertRedirect(await f.app.inject({ url: first.url,headers }),'login_expired');
    const next=await f.begin(); assert.notEqual(next.cookie,first.cookie); assert.notEqual(next.url,first.url);
    f.setFailure(null);
    const success=await f.app.inject({ url: next.url,headers: { cookie: next.cookie,accept: 'text/html' } });
    assert.equal(success.statusCode,303); assert.equal(success.headers.location,frontend);
    assert.match(String(success.headers['set-cookie']),/__Host-alms_session=/);
    assert.deepEqual(f.counts(),{ verified: 2,issued: 1 });
  } finally { await f.app.close(); }
});

for (const oldResult of ['success', 'provider_failure', 'database_failure'] as const) {
  test(`a delayed ${oldResult} callback cannot delete a newer browser login binding`, async () => {
    let entered!: () => void, release!: () => void;
    const verifying = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const f = await fixture({beforeVerification: async () => {
      if (++calls === 1) { entered(); await wait; }
    }});
    try {
      if (oldResult === 'provider_failure') f.setFailure(new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'private-provider-error'));
      if (oldResult === 'database_failure') f.failDatabase();
      const old = await f.begin();
      const returning = f.app.inject({url: old.url, headers: {cookie: old.cookie, accept: 'text/html'}});
      await verifying;
      // A new tab or an explicit new attempt can start while the first school's response is pending.
      const fresh = await f.begin();
      assert.notEqual(fresh.cookie, old.cookie);
      release();
      const delayed = await returning;
      assert.equal(delayed.statusCode, 303);
      const cookies = delayed.headers['set-cookie'];
      const values = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
      // Browser cookie updates apply in response-arrival order, not in attempt-start order.
      // A Max-Age=0 response for this shared name would delete the fresh binding above.
      assert.equal(values.some(value => value.startsWith('__Host-alms_login=')), false);
      const replay = await f.app.inject({url: old.url, headers: {cookie: old.cookie, accept: 'text/html'}});
      assertRedirect(replay, 'login_expired');
      assert.equal(f.counts().verified, 1);
      f.setFailure(null);
      f.failDatabase(false);
      const finished = await f.app.inject({url: fresh.url, headers: {cookie: fresh.cookie, accept: 'text/html'}});
      assert.equal(finished.statusCode, 303); assert.equal(finished.headers.location, frontend);
      assert.equal(f.counts().verified, 2);
      assert.equal(f.counts().issued, oldResult === 'success' ? 2 : 1);
    } finally { release(); await f.app.close(); }
  });
}

test('token syntax diagnostics distinguish GET query plus, encoded plus and space from POST-only values without changing provider input', async () => {
  const cases = [
    { method: 'GET', query: 'sToken=shape+probe', token: 'shape probe', flags: [true, true, false, true] },
    { method: 'GET', query: 'sToken=shape%2Bprobe', token: 'shape+probe', flags: [false, false, true, true] },
    { method: 'GET', query: 'sToken=shape%2bprobe', token: 'shape+probe', flags: [false, false, true, true] },
    { method: 'GET', query: 'sToken=shape%20probe', token: 'shape probe', flags: [true, false, false, true] },
    { method: 'GET', query: 'sToken=shape+%2Bprobe', token: 'shape +probe', flags: [true, true, true, true] },
    { method: 'GET', query: '%73Token=shape%2Bprobe', token: 'shape+probe', flags: [false, false, true, true] },
    { method: 'GET', query: 'sToken=shape%252Bprobe', token: 'shape%2Bprobe', flags: [false, false, false, true] },
    { method: 'POST', query: '', token: 'shape+probe', flags: [false, false, false, false] },
    { method: 'POST', query: '', token: 'shape probe', flags: [true, false, false, false] },
    { method: 'POST', query: 'sToken=shape%2Bprobe', token: 'shape+probe', flags: [false, false, true, true] },
  ] as const;
  for (const scenario of cases) {
    const f = await fixture({ artifactToken: scenario.token }), records: unknown[] = [];
    f.app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
    try {
      const attempt = await f.begin();
      f.setFailure(new AppError(401, 'SCHOOL_AUTH_FAILED', 'private-provider-error'));
      const fields = new URLSearchParams({ ...(scenario.query ? {} : {sToken: scenario.token}), sIdno: subject });
      const response = await f.app.inject({ method: scenario.method,
        url: attempt.callback.pathname + (scenario.method === 'GET' ? '?' + scenario.query + '&' + fields : scenario.query ? '?' + scenario.query : ''),
        headers: {cookie: attempt.cookie, accept: 'text/html', ...(scenario.method === 'POST' ? {'content-type': 'application/x-www-form-urlencoded'} : {})},
        ...(scenario.method === 'POST' ? {payload: fields.toString()} : {}) });
      assertRedirect(response, 'school_auth_failed');
      const [tokenParsedSpace, tokenQueryLiteralPlus, tokenQueryEncodedPlus, tokenInQuery] = scenario.flags;
      assert.deepEqual(records, [{event: 'auth_callback_failed', stage: 'provider_verification', code: 'school_auth_failed', fetchDestination: 'unknown',
        tokenParsedSpace, tokenQueryLiteralPlus, tokenQueryEncodedPlus, tokenInQuery}]);
      for (const value of [scenario.token, subject, attempt.cookie, attempt.callback.pathname, 'private-provider-error'])
        assert.equal(JSON.stringify(records).includes(value), false);
      assert.doesNotMatch(response.body + JSON.stringify(response.headers), /tokenParsedSpace|tokenQueryLiteralPlus|tokenQueryEncodedPlus|tokenInQuery/);
      assert.deepEqual(f.counts(), {verified: 1, issued: 0});
      assert.equal(f.attempts.size, 0);
    } finally { await f.app.close(); }
  }
});

test('token diagnostic flags are absent before input validation and from successful responses, while callback replay still fails', async () => {
  const f = await fixture({artifactToken: 'shape+probe'}), records: unknown[] = [];
  f.app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
  try {
    const attempt = await f.begin();
    const missing = await f.app.inject({url: attempt.callback.pathname, headers: {cookie: attempt.cookie, accept: 'text/html'}});
    assertRedirect(missing, 'school_auth_failed');
    assert.deepEqual(records, [{event: 'auth_callback_failed', stage: 'callback_validation', code: 'invalid_request', fetchDestination: 'unknown'}]);
    assert.deepEqual(f.counts(), {verified: 0, issued: 0}); assert.equal(f.attempts.size, 1);
    records.length = 0;
    const url = attempt.callback.pathname + '?sToken=shape%2Bprobe&sIdno=' + subject;
    const success = await f.app.inject({url, headers: {cookie: attempt.cookie, accept: 'text/html'}});
    assert.equal(success.statusCode, 303); assert.equal(success.headers.location, frontend);
    assert.deepEqual(records, []); assert.deepEqual(f.counts(), {verified: 1, issued: 1});
    assert.doesNotMatch(success.body + JSON.stringify(success.headers), /shape|tokenParsedSpace|tokenQueryLiteralPlus|tokenQueryEncodedPlus|tokenInQuery/);
    const replay = await f.app.inject({url, headers: {cookie: attempt.cookie, accept: 'text/html'}});
    assertRedirect(replay, 'login_expired'); assert.deepEqual(f.counts(), {verified: 1, issued: 1});
    assert.deepEqual(records, [{event: 'auth_callback_failed', stage: 'callback_binding', code: 'invalid_callback', fetchDestination: 'unknown',
      ...queryTokenShape, tokenQueryEncodedPlus: true, bindingFailure: 'attempt_rejected', sameAttemptPreviouslyIssuedSession: true}]);
  } finally { await f.app.close(); }
});

test('callback store failures keep JSON 500 but HTML gets a sanitized recovery route',async () => {
  const f=await fixture(); f.failDatabase();
  try {
    for (const accept of ['application/json','text/html']) {
      const attempt=await f.begin();
      const response=await f.app.inject({ url: attempt.url,headers: { cookie: attempt.cookie,accept } });
      if (accept==='text/html') assertRedirect(response,'school_upstream_unavailable');
      else { assert.equal(response.statusCode,500); assert.equal(response.json().error.code,'INTERNAL_ERROR'); }
      assert.doesNotMatch(response.body,/synthetic database/);
    }
    assert.equal(f.counts().issued,0);
  } finally { await f.app.close(); }
});

test('a post-success missing-cookie callback reports exact attempt correlation without accepting replay or disclosing evidence', async () => {
  for (const accept of ['application/json', 'text/html']) {
    const f = await fixture(), records: unknown[] = [];
    f.app.addHook('onRequest', async request => {request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn;});
    try {
      const succeeded = await f.begin(), other = await f.begin();
      const success = await f.app.inject({url: succeeded.url, headers: {cookie: succeeded.cookie, accept}});
      assert.equal(success.statusCode, 303);
      assert.equal(success.headers.location, frontend);
      assert.deepEqual(records, []);
      for (const [attempt, previouslyIssued] of [[succeeded, true], [other, false]] as const) {
        const response = await f.app.inject({url: attempt.url, headers: {accept}});
        if (accept === 'text/html') assertRedirect(response, 'login_expired');
        else {
          assert.equal(response.statusCode, 401);
          assert.equal(response.json().error.code, 'INVALID_CALLBACK');
          assert.equal(response.headers.location, undefined);
        }
        const record = records.at(-1);
        assert.deepEqual(record, {event: 'auth_callback_failed', stage: 'callback_binding', code: 'invalid_callback', fetchDestination: 'unknown',
          ...queryTokenShape, bindingFailure: 'missing_cookie', sameAttemptPreviouslyIssuedSession: previouslyIssued});
        for (const value of [attempt.callback.pathname, attempt.cookie, syntheticToken, subject]) assert.equal(JSON.stringify(record).includes(value), false);
        assert.doesNotMatch(response.body + JSON.stringify(response.headers), /sameAttemptPreviouslyIssuedSession|private-|stateHash/);
        assert.doesNotMatch(String(response.headers['set-cookie']), /__Host-alms_session=/);
      }
      assert.deepEqual(f.counts(), {verified: 1, issued: 1});
    } finally {await f.app.close();}
  }
});

test('consumed attempts whose provider, identity or session issuance failed never acquire success correlation', async () => {
  for (const failure of ['provider', 'identity', 'database'] as const) {
    const f = await fixture(failure === 'identity' ? {identitySubject: 'private-wrong-subject'} : {}), records: unknown[] = [];
    f.app.addHook('onRequest', async request => {request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn;});
    try {
      if (failure === 'provider') f.setFailure(new AppError(401, 'SCHOOL_AUTH_FAILED', 'private-provider-error'));
      if (failure === 'database') f.failDatabase();
      const attempt = await f.begin();
      await f.app.inject({url: attempt.url, headers: {cookie: attempt.cookie, accept: 'application/json'}});
      assert.equal(f.counts().issued, 0);
      records.length = 0;
      const replay = await f.app.inject({url: attempt.url, headers: {accept: 'text/html'}});
      assertRedirect(replay, 'login_expired');
      assert.deepEqual(records, [{event: 'auth_callback_failed', stage: 'callback_binding', code: 'invalid_callback', fetchDestination: 'unknown',
        ...queryTokenShape, bindingFailure: 'missing_cookie', sameAttemptPreviouslyIssuedSession: false}]);
      assert.deepEqual(f.counts(), {verified: 1, issued: 0});
    } finally {await f.app.close();}
  }
});

test('callback failures emit one fixed diagnostic at the fatal callback boundary for HTML and JSON', async () => {
  for (const accept of ['application/json', 'text/html']) for (const scenario of [
    { name: 'input', stage: 'callback_validation', code: 'invalid_request', status: 400 },
    { name: 'binding', stage: 'callback_binding', code: 'invalid_callback', status: 401 },
    { name: 'provider', stage: 'provider_verification', code: 'school_auth_failed', status: 401 },
    { name: 'identity', stage: 'identity_binding', code: 'school_auth_failed', status: 401 },
    { name: 'database', stage: 'session_issue', code: 'unknown', status: 500 },
  ] as const) {
    const f = await fixture(scenario.name === 'identity' ? { identitySubject: 'private-wrong-subject' } : {});
    const records: unknown[] = [];
    f.app.addHook('onRequest', async request => { request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn; });
    try {
      const attempt = await f.begin();
      if (scenario.name === 'provider') f.setFailure(new AppError(401, 'SCHOOL_AUTH_FAILED', 'private-message'));
      if (scenario.name === 'database') f.failDatabase();
      const response = await f.app.inject({ url: attempt.url + (scenario.name === 'input' ? '&extra=private-field' : ''),
        headers: { accept, cookie: scenario.name === 'binding' ? '' : attempt.cookie } });
      assert.equal(response.statusCode, accept === 'text/html' ? 303 : scenario.status);
      assert.deepEqual(records, [{ event: 'auth_callback_failed', stage: scenario.stage, code: scenario.code, fetchDestination: 'unknown',
        ...(scenario.name === 'input' ? {} : queryTokenShape),
        ...(scenario.name === 'binding' ? {bindingFailure: 'missing_cookie', sameAttemptPreviouslyIssuedSession: false} : {}) }]);
      assert.doesNotMatch(diagnosticWithoutTokenShape(records), /private-|url|token|subject|student|cause|body/);
      assert.doesNotMatch(String(response.headers['set-cookie']), /__Host-alms_session=/);
      assert.equal(f.counts().issued, 0);
      assert.equal(f.counts().verified, ['input', 'binding'].includes(scenario.name) ? 0 : 1);
    } finally { await f.app.close(); }
  }
});

test('HTML opt-out, explicit JSON preference and absent Accept preserve the JSON contract',async () => {
  const f=await fixture();
  try {
    for (const accept of ['', '*/*', 'text/html;q=0,application/json', 'application/json,text/html;q=0.5']) {
      const response=await f.app.inject({ url: '/v1/auth/callback',headers: { accept } });
      assert.equal(response.statusCode,400); assert.equal(response.json().error.code,'INVALID_REQUEST');
      assert.equal(response.headers.location,undefined);
    }
  } finally { await f.app.close(); }
});

test('disabled school authentication keeps JSON 503 and sends browser callbacks to recovery',async () => {
  const app=await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused',LOG_LEVEL: 'silent' }),{} as Store);
  try {
    const json=await app.inject({ url: '/v1/auth/callback',headers: { accept: 'application/json' } });
    assert.equal(json.statusCode,503); assert.equal(json.json().error.code,'SCHOOL_AUTH_UNAVAILABLE');
    assertRedirect(await app.inject({ url: '/v1/auth/callback',headers: { accept: 'text/html' } }),'school_upstream_unavailable');
    assert.equal((await app.inject('/v1/auth/login')).statusCode,503);
  } finally { await app.close(); }
});

test('path state cannot be overridden or repeated in query or POST body',async () => {
  const f=await fixture();
  try {
    const attempt=await f.begin(); const nonce=attempt.callback.pathname.split('/').at(-1)!;
    const requests=[
      { url: attempt.url+'&state='+nonce },
      { method: 'POST' as const,url: attempt.callback.pathname,payload: { state: nonce,sToken: syntheticToken,sIdno: subject } },
      { method: 'POST' as const,url: attempt.url,payload: { sToken: syntheticToken } },
      { url: attempt.url+'&sToken='+syntheticToken },
    ];
    for (const request of requests) for (const accept of ['application/json','text/html']) {
      const response=await f.app.inject({ ...request,headers: { cookie: attempt.cookie,accept } });
      if (accept==='text/html') assertRedirect(response,'school_auth_failed');
      else { assert.equal(response.statusCode,400); assert.equal(response.headers.location,undefined); }
    }
    assert.deepEqual(f.counts(),{ verified: 0,issued: 0 });
  } finally { await f.app.close(); }
});

test('well-formed legacy GET and POST remain compatible without repairing ambiguous state',async () => {
  const f=await fixture();
  try {
    for (const method of ['GET','POST'] as const) {
      const attempt=await f.begin(); const nonce=attempt.callback.pathname.split('/').at(-1)!;
      const fields={ state: nonce,sToken: syntheticToken,sIdno: subject };
      const response=await f.app.inject({ method,url: '/v1/auth/callback'+(method==='GET' ? '?'+new URLSearchParams(fields) : ''),
        headers: { cookie: attempt.cookie,accept: 'text/html' },...(method==='POST' ? { payload: fields } : {}) });
      assert.equal(response.statusCode,303); assert.equal(response.headers.location,frontend);
    }
    const attempt=await f.begin(); const nonce=attempt.callback.pathname.split('/').at(-1)!;
    const malformed='/v1/auth/callback?state='+nonce+'?sToken='+syntheticToken+'&sIdno='+subject;
    const response=await f.app.inject({ url: malformed,headers: { cookie: attempt.cookie,accept: 'application/json' } });
    assert.equal(response.statusCode,400); assert.equal(response.json().error.code,'INVALID_REQUEST');
    assert.deepEqual(f.counts(),{ verified: 2,issued: 2 });
  } finally { await f.app.close(); }
});

test('callback completion logs the route pattern without the path nonce or school fields',async () => {
  const f=await fixture(); const records: unknown[]=[];
  f.app.addHook('onRequest',async request => { request.log.info=((value: unknown) => { records.push(value); }) as typeof request.log.info; });
  try {
    const attempt=await f.begin(); const nonce=attempt.callback.pathname.split('/').at(-1)!;
    const response=await f.app.inject({ url: attempt.url,headers: { cookie: attempt.cookie,accept: 'text/html' } });
    assert.equal(response.statusCode,303);
    assert.ok(records.some(record => (record as { route?: string }).route==='/v1/auth/callback/:state'));
    for (const record of records) {
      assert.deepEqual(Object.keys(record as object).sort(),['elapsedMs','method','route','statusCode']);
      // Timing floats can coincidentally contain the synthetic numeric student ID.
      const strings=Object.values(record as object).filter(value=>typeof value==='string').join(' ');
      for (const privateValue of [nonce,syntheticToken,subject]) assert.equal(strings.includes(privateValue),false);
    }
  } finally { await f.app.close(); }
});

test('direct navigation issues a browser-bound attempt and redirects to school without a JSON fetch',async () => {
  const f=await fixture();
  try {
    const start=await f.app.inject('/v1/auth/start?returnTo=https://evil.invalid');
    assert.equal(start.statusCode,303);
    const school=new URL(start.headers.location!); assert.equal(school.origin,'https://smartid.ssu.ac.kr');
    const returned=school.searchParams.get('apiReturnUrl')!; const callback=new URL(returned);
    assert.equal(callback.origin,'https://api-lms.flyjung.kr'); assert.equal(callback.search,'');
    assert.match(callback.pathname,/^\/v1\/auth\/callback\/[A-Za-z0-9_-]{43}$/);
    const cookie=String(start.headers['set-cookie']);
    for (const flag of ['HttpOnly','Secure','SameSite=None','Max-Age=900','Path=/']) assert.ok(cookie.includes(flag));
    assert.doesNotMatch(cookie,/Domain=|__Host-alms_session=/);
    assert.equal(start.headers['cache-control'],'no-store'); assert.equal(start.headers['referrer-policy'],'no-referrer');
    const received=new URL(returned+'?'+new URLSearchParams({ sToken: syntheticToken,sIdno: subject }));
    const finished=await f.app.inject({ url: received.pathname+received.search,headers: { cookie: cookie.split(';')[0]!,accept: 'text/html' } });
    assert.equal(finished.statusCode,303); assert.equal(finished.headers.location,frontend);
    assert.deepEqual(f.counts(),{ verified: 1,issued: 1 });
    const retry=await f.app.inject('/v1/auth/start'); assert.notEqual(retry.headers.location,start.headers.location); assert.notEqual(retry.headers['set-cookie'],start.headers['set-cookie']);
  } finally { await f.app.close(); }
});

test('direct start rejects unsafe destinations and normalizes startup failures',async () => {
  for (const options of [
    { loginUrl: 'https://evil.invalid/?raw-private-detail' },
    { loginUrl: 'https://user:raw-private-detail@smartid.ssu.ac.kr/' },
    { loginUrl: 'https://smartid.ssu.ac.kr:8443/' },
    { startFailure: new Error('raw-private-detail') },
  ]) {
    const f=await fixture(options);
    try {
      const response=await f.app.inject('/v1/auth/start');
      assertRedirect(response,'school_upstream_unavailable');
      assert.equal(response.headers['set-cookie'],undefined); assert.equal(f.attempts.size,0);
    } finally { await f.app.close(); }
  }
  const app=await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused',LOG_LEVEL: 'silent' }),{} as Store);
  try { assertRedirect(await app.inject('/v1/auth/start'),'school_upstream_unavailable'); }
  finally { await app.close(); }
});
