import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {AppError} from '../src/errors.js';
import {unavailableSchoolProvider} from '../src/provider.js';
import type {Store} from '../src/store.js';
import type {LoginClientContext} from '../src/frontend-clients.js';

const subject = '90000001', artifact = 'synthetic-only-artifact';
const other = {id: 'other-web', origins: ['https://other.flyjung.kr'], redirectUris: ['https://other.flyjung.kr/app/'],
  defaultRedirectUri: 'https://other.flyjung.kr/app/', authMode: 'cookie'};
const bearer = {id: 'pages-web', origins: ['https://synthetic.github.io'], redirectUris: ['https://synthetic.github.io/alms/#/auth/callback'],
  defaultRedirectUri: 'https://synthetic.github.io/alms/#/auth/callback', authMode: 'bearer'};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

async function fixture(options: {beforeConsume?: () => Promise<void>; verify?: () => Promise<void>; beforeIssue?: () => Promise<void>; failure?: Error; issueFailure?: Error; mismatch?: boolean} = {}) {
  const attempts = new Map<string, {binding: string; context: LoginClientContext; consumed: boolean}>();
  const records: Record<string, unknown>[] = [];
  const verifyEntered = deferred<void>(), issueEntered = deferred<void>();
  const contextWaiters = new Map<number, ReturnType<typeof deferred<void>>>();
  let consumes = 0, verifies = 0, issues = 0, grants = 0, contextReads = 0;
  const store = {
    createLoginAttempt: async (state: string, binding: string, context: LoginClientContext) => {attempts.set(state, {binding, context, consumed: false});},
    getLoginClientContext: async (state: string) => {
      contextReads++;
      for (const [expected, waiter] of contextWaiters) if (expected <= contextReads) {contextWaiters.delete(expected); waiter.resolve();}
      return attempts.get(state)?.context ?? null;
    },
    consumeLoginAttempt: async (state: string, binding: string) => {
      consumes++; await options.beforeConsume?.();
      const row = attempts.get(state); if (!row || row.binding !== binding || row.consumed) return false;
      row.consumed = true; return true;
    },
    issueVerifiedSession: async () => {
      issues++; issueEntered.resolve(); await options.beforeIssue?.();
      if (options.issueFailure) throw options.issueFailure;
      return {token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 3600000).toISOString()};
    },
    createFrontendAuthCode: async () => {grants++;},
  } as unknown as Store;
  const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent', NODE_ENV: 'production',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), FRONTEND_CLIENTS_JSON: JSON.stringify([other, bearer])}), store,
  {...unavailableSchoolProvider, auth: {providerId: 'synthetic',
    createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),
    verifyCallback: async input => {
      verifies++; assert.deepEqual(input, {sToken: artifact, sIdno: subject}); verifyEntered.resolve();
      await options.verify?.(); if (options.failure) throw options.failure;
      return {subject: options.mismatch ? '90000002' : subject, schoolSession: {synthetic: true}};
    }}});
  app.addHook('onRequest', async request => {request.log.warn = ((record: Record<string, unknown>) => records.push(record)) as typeof request.log.warn;});
  async function begin(id = 'alms-web') {
    const query = id === 'alms-web' ? {} : {clientId: id, ...(id === bearer.id ? {
      clientState: 's'.repeat(43), codeChallenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'), codeChallengeMethod: 'S256',
    } : {})};
    const start = await app.inject('/v1/auth/login?' + new URLSearchParams(query)); assert.equal(start.statusCode, 200);
    const callback = new URL(new URL(start.json().url).searchParams.get('apiReturnUrl')!);
    return {callback, url: callback.pathname + '?' + new URLSearchParams({sToken: artifact, sIdno: subject}),
      cookie: String(start.headers['set-cookie']).split(';')[0]!};
  }
  async function finish(started: Awaited<ReturnType<typeof begin>>, options: {cookie?: string; accept?: string; token?: string; student?: string; post?: boolean} = {}) {
    const fields = new URLSearchParams({sToken: options.token ?? artifact, sIdno: options.student ?? subject});
    return app.inject({method: options.post ? 'POST' : 'GET', url: started.callback.pathname + (options.post ? '' : '?' + fields),
      headers: {cookie: options.cookie ?? started.cookie, accept: options.accept ?? 'text/html',
        ...(options.post ? {'content-type': 'application/x-www-form-urlencoded'} : {})}, ...(options.post ? {payload: fields.toString()} : {})});
  }
  const waitForContexts = (expected: number) => {
    if (contextReads >= expected) return Promise.resolve();
    const waiter = deferred<void>(); contextWaiters.set(expected, waiter); return waiter.promise;
  };
  return {app, begin, finish, records, attempts, verifyEntered, issueEntered, waitForContexts, counts: () => ({consumes, verifies, issues, grants})};
}

test('same cookie GET and form POST share the in-flight SQL, verification and exact issued session once', {timeout: 5000}, async () => {
  const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise});
  try {
    const started = await f.begin(); const first = f.finish(started); await f.verifyEntered.promise;
    const duplicate = f.finish(started, {post: true});
    // Form body parsing is asynchronous; ensure the duplicate reached the auth
    // context boundary while the original provider is still deliberately held.
    await f.waitForContexts(2); await turn();
    assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 0, grants: 0});
    gate.resolve(); const responses = await Promise.all([first, duplicate]);
    for (const response of responses) {
      assert.equal(response.statusCode, 303); assert.equal(response.headers.location, 'https://lms.flyjung.kr/');
      assert.match(String(response.headers['set-cookie']), /^__Host-alms_session=.*HttpOnly; Secure; SameSite=Lax/);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.doesNotMatch(response.body + String(response.headers.location), /synthetic-only-artifact|90000001|csrf|context/);
    }
    assert.equal(responses[0]!.headers['set-cookie'], responses[1]!.headers['set-cookie']);
    assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 1, grants: 0}); assert.equal(f.records.length, 0);
    const replay = await f.finish(started); assert.equal(replay.headers.location, 'https://lms.flyjung.kr/#/login?reason=login_expired');
    assert.equal(replay.headers['set-cookie'], undefined); assert.equal(f.counts().verifies, 1); assert.equal(f.counts().issues, 1);
    assert.equal(f.records.at(-1)!.sameAttemptPreviouslyIssuedSession, true);
  } finally {gate.resolve(); await f.app.close();}
});

test('duplicate arrival while the first SQL consume is pending cannot start a second consume', async () => {
  const gate = deferred<void>(); const f = await fixture({beforeConsume: () => gate.promise});
  try {
    const started = await f.begin(); const first = f.finish(started); await turn();
    const duplicate = f.finish(started); await turn(); assert.equal(f.counts().consumes, 1); assert.equal(f.counts().verifies, 0);
    gate.resolve(); const responses = await Promise.all([first, duplicate]);
    assert.equal(responses.every(response => response.statusCode === 303 && response.headers.location === 'https://lms.flyjung.kr/'), true);
    assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 1, grants: 0});
  } finally {gate.resolve(); await f.app.close();}
});

test('duplicates during issuance receive one verified session without a second issuance', async () => {
  const gate = deferred<void>(); const f = await fixture({beforeIssue: () => gate.promise});
  try {
    const started = await f.begin(); const first = f.finish(started); await f.issueEntered.promise;
    const duplicate = f.finish(started); await turn(); assert.equal(f.counts().issues, 1);
    gate.resolve(); const responses = await Promise.all([first, duplicate]);
    assert.equal(responses[0]!.headers['set-cookie'], responses[1]!.headers['set-cookie']);
    assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 1, grants: 0});
  } finally {gate.resolve(); await f.app.close();}
});

test('shared issuance failure keeps its original stage and sanitized JSON/HTML handling without retrying SQL', async () => {
  const gate = deferred<void>(); const f = await fixture({beforeIssue: () => gate.promise, issueFailure: new Error('private-synthetic-database-detail')});
  try {
    const started = await f.begin(); const first = f.finish(started); await f.issueEntered.promise;
    const duplicate = f.finish(started, {accept: 'application/json'}); await turn(); gate.resolve();
    const [html, json] = await Promise.all([first, duplicate]);
    assert.equal(html.statusCode, 303); assert.match(String(html.headers.location), /reason=school_upstream_unavailable$/);
    assert.equal(json.statusCode, 500); assert.equal(json.json().error.code, 'INTERNAL_ERROR');
    assert.equal(html.headers['set-cookie'], undefined); assert.equal(json.headers['set-cookie'], undefined);
    assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 1, grants: 0});
    assert.equal(f.records.length, 2); assert.equal(f.records.every(row => row.stage === 'session_issue'), true);
    assert.doesNotMatch(html.body + json.body + JSON.stringify(f.records), /private-synthetic-database-detail|synthetic-only-artifact|90000001/);
  } finally {gate.resolve(); await f.app.close();}
});

test('different valid binding, callback token or callback subject never joins a pending verified result', async () => {
  const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise});
  try {
    const started = await f.begin(); const first = f.finish(started); await f.verifyEntered.promise;
    for (const changed of [{cookie: '__Host-alms_login=' + randomBytes(32).toString('base64url')}, {token: 'other-synthetic-artifact'}, {student: '90000002'}]) {
      const denied = await f.finish(started, changed);
      assert.equal(denied.statusCode, 303); assert.match(String(denied.headers.location), /reason=login_expired$/);
      assert.equal(denied.headers['set-cookie'], undefined);
    }
    assert.equal(f.counts().verifies, 1); assert.equal(f.counts().issues, 0);
    gate.resolve(); assert.equal((await first).headers.location, 'https://lms.flyjung.kr/'); assert.equal(f.counts().issues, 1);
  } finally {gate.resolve(); await f.app.close();}
});

test('missing or malformed binding and repeated callback fields still fail before SQL or provider verification', async () => {
  const f = await fixture();
  try {
    const started = await f.begin();
    for (const cookie of ['', '__Host-alms_login=invalid-private-binding']) {
      const denied = await f.finish(started, {cookie}); assert.match(String(denied.headers.location), /reason=login_expired$/);
    }
    const invalid = await f.app.inject({url: started.url + '&sToken=other-synthetic', headers: {cookie: started.cookie, accept: 'text/html'}});
    assert.equal(invalid.statusCode, 303); assert.equal(invalid.headers['set-cookie'], undefined);
    assert.deepEqual(f.counts(), {consumes: 0, verifies: 0, issues: 0, grants: 0});
  } finally {await f.app.close();}
});

test('independent client and newly started attempt cannot reuse an older in-flight token or clear its newer binding', async () => {
  const gate = deferred<void>(); let verifications = 0;
  const f = await fixture({verify: async () => {if (++verifications === 1) await gate.promise;}});
  try {
    const old = await f.begin(); const first = f.finish(old); await f.verifyEntered.promise;
    const fresh = await f.begin(); assert.notEqual(fresh.cookie, old.cookie);
    const wrongBinding = await f.finish(old, {cookie: fresh.cookie}); assert.match(String(wrongBinding.headers.location), /reason=login_expired$/);
    const freshResult = await f.finish(fresh); const otherResult = await f.finish(await f.begin(other.id));
    assert.equal(freshResult.headers.location, 'https://lms.flyjung.kr/'); assert.equal(otherResult.headers.location, other.defaultRedirectUri);
    assert.match(String(otherResult.headers['set-cookie']), /^__Host-alms_session_other-web=/);
    gate.resolve(); const delayed = await first;
    assert.doesNotMatch(String(delayed.headers['set-cookie']), /__Host-alms_login=/);
    assert.notEqual(delayed.headers['set-cookie'], freshResult.headers['set-cookie']);
    assert.deepEqual(f.counts(), {consumes: 4, verifies: 3, issues: 3, grants: 0});
  } finally {gate.resolve(); await f.app.close();}
});

for (const failure of ['provider-denial', 'provider-unavailable', 'identity-mismatch'] as const) {
  test(`shared ${failure} retains the original failure reason and fixed stage without issuing any session`, async () => {
    const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise,
      ...(failure === 'identity-mismatch' ? {mismatch: true} : {failure: failure === 'provider-denial'
        ? new AppError(401, 'SCHOOL_AUTH_FAILED', 'private-synthetic-detail') : new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'private-synthetic-detail')})});
    try {
      const started = await f.begin(); const first = f.finish(started); await f.verifyEntered.promise;
      const duplicate = f.finish(started); await turn(); gate.resolve(); const responses = await Promise.all([first, duplicate]);
      const reason = failure === 'provider-unavailable' ? 'school_upstream_unavailable' : 'school_auth_failed';
      for (const response of responses) {
        assert.equal(response.statusCode, 303); assert.match(String(response.headers.location), new RegExp('reason=' + reason + '$'));
        assert.equal(response.headers['set-cookie'], undefined); assert.doesNotMatch(response.body + String(response.headers.location), /private-synthetic-detail/);
      }
      assert.deepEqual(f.counts(), {consumes: 1, verifies: 1, issues: 0, grants: 0});
      assert.equal(f.records.length, 2); assert.equal(f.records[0]!.stage, f.records[1]!.stage);
      assert.equal(f.records[0]!.stage, failure === 'identity-mismatch' ? 'identity_binding' : 'provider_verification');
      assert.doesNotMatch(JSON.stringify(f.records), /90000001|synthetic-only-artifact|private-synthetic-detail|__Host-alms/);
      const replay = await f.finish(started); assert.match(String(replay.headers.location), /reason=login_expired$/);
      assert.equal(f.counts().verifies, 1);
    } finally {gate.resolve(); await f.app.close();}
  });
}

test('duplicate timeout and lookup expiry do not cancel or add a deadline to the original callback', async t => {
  const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise});
  try {
    const started = await f.begin(); t.mock.timers.enable({apis: ['setTimeout']});
    let originalFinished = false;
    const first = f.finish(started).then(response => {originalFinished = true; return response;}); await f.verifyEntered.promise;
    const duplicate = f.finish(started); await turn(); t.mock.timers.tick(15_000); await turn();
    const timedOut = await duplicate;
    assert.equal(timedOut.statusCode, 303); assert.match(String(timedOut.headers.location), /reason=school_upstream_unavailable$/);
    assert.equal(timedOut.headers['set-cookie'], undefined); assert.equal(originalFinished, false);
    t.mock.timers.tick(45_000); await turn(); assert.equal(originalFinished, false);
    const afterExpiry = await f.finish(started); assert.match(String(afterExpiry.headers.location), /reason=login_expired$/);
    assert.deepEqual(f.counts(), {consumes: 2, verifies: 1, issues: 0, grants: 0});
    gate.resolve(); const success = await first; assert.equal(success.headers.location, 'https://lms.flyjung.kr/');
    assert.equal(f.counts().verifies, 1); assert.equal(f.counts().issues, 1);
  } finally {gate.resolve(); await f.app.close();}
});

test('bearer callback remains single-use while its first verification is pending and grants only one code', async () => {
  const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise});
  try {
    const started = await f.begin(bearer.id); const first = f.finish(started); await f.verifyEntered.promise;
    const duplicate = await f.finish(started); assert.match(String(duplicate.headers.location), /reason=login_expired/);
    assert.equal(duplicate.headers['set-cookie'], undefined); assert.equal(f.counts().consumes, 2);
    gate.resolve(); const success = await first; assert.equal(success.statusCode, 303);
    assert.match(String(success.headers.location), /code=[A-Za-z0-9_-]{43}/); assert.equal(success.headers['set-cookie'], undefined);
    assert.deepEqual(f.counts(), {consumes: 2, verifies: 1, issues: 1, grants: 1});
  } finally {gate.resolve(); await f.app.close();}
});

test('duplicate participant overflow retains the original SQL rejection and never adds school verification or issuance', {timeout: 5000}, async () => {
  const gate = deferred<void>(); const f = await fixture({verify: () => gate.promise});
  try {
    const started = await f.begin(); const first = f.finish(started); await f.verifyEntered.promise;
    const duplicates = Array.from({length: 8}, () => f.finish(started));
    await f.waitForContexts(9); await turn();
    const overflow = await f.finish(started); assert.match(String(overflow.headers.location), /reason=login_expired$/);
    assert.equal(overflow.headers['set-cookie'], undefined); assert.equal(f.counts().consumes, 2);
    gate.resolve(); const responses = await Promise.all([first, ...duplicates]);
    assert.equal(responses.every(response => response.headers.location === 'https://lms.flyjung.kr/'), true);
    assert.equal(new Set(responses.map(response => response.headers['set-cookie'])).size, 1);
    assert.deepEqual(f.counts(), {consumes: 2, verifies: 1, issues: 1, grants: 0});
  } finally {gate.resolve(); await f.app.close();}
});
