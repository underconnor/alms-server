import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { hashToken, type FrontendAuthCodeInput, type Store } from '../src/store.js';
import type { Session } from '../src/domain.js';
import type { LoginClientContext } from '../src/frontend-clients.js';
import { unavailableSchoolProvider } from '../src/provider.js';

const cookieClient = { id: 'other-web', origins: ['https://other.flyjung.kr'], redirectUris: ['https://other.flyjung.kr/app/'],
  defaultRedirectUri: 'https://other.flyjung.kr/app/', authMode: 'cookie' };
const bearerClient = { id: 'pages-web', origins: ['https://synthetic.github.io'], redirectUris: ['https://synthetic.github.io/alms/#/auth/callback'],
  defaultRedirectUri: 'https://synthetic.github.io/alms/#/auth/callback', authMode: 'bearer' };
const verifier = 'q'.repeat(64), clientState = 's'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const registry = [cookieClient, bearerClient];
async function fixture() {
  const attempts = new Map<string, {binding: string; context: LoginClientContext; consumed: boolean}>();
  const grants = new Map<string, FrontendAuthCodeInput & {expires: number; consumed: boolean}>();
  const sessions = new Map<string, Session>();
  let failure: Error | undefined, verifies = 0, issues = 0, logout = 0;
  const store = {
    createLoginAttempt: async (state: string, binding: string, context: LoginClientContext) => { attempts.set(state, {binding, context, consumed: false}); },
    getLoginClientContext: async (state: string) => attempts.get(state)?.context ?? null,
    consumeLoginAttempt: async (state: string, binding: string) => {
      const row = attempts.get(state); if (!row || row.binding !== binding || row.consumed) return false;
      row.consumed = true; return true;
    },
    issueVerifiedSession: async (_identity: unknown, _ttl: number, _school: unknown, clientId: string) => {
      issues++; const token = randomBytes(32).toString('base64url');
      const session: Session = { tokenHash: hashToken(token), clientId, csrfToken: randomBytes(32).toString('base64url'),
        analyticsSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        user: { id: randomUUID(), displayName: 'Synthetic QA', analyticsId: randomUUID(), analyticsEnabled: true } };
      sessions.set(session.tokenHash, session); return { token, ...session };
    },
    createFrontendAuthCode: async (input: FrontendAuthCodeInput) => { grants.set(input.codeHash, {...input, expires: Date.now() + 60_000, consumed: false}); },
    consumeFrontendAuthCode: async (codeHash: string, id: string, uri: string, pkce: string) => {
      const row = grants.get(codeHash);
      if (!row || row.consumed || row.expires <= Date.now() || row.clientId !== id || row.redirectUri !== uri || row.codeChallenge !== pkce) return null;
      row.consumed = true; return {encryptedToken: row.encryptedToken, sessionTokenHash: row.sessionTokenHash};
    },
    getSession: async (hash: string) => sessions.get(hash) ?? null,
    deleteSession: async (hash: string) => { logout++; sessions.delete(hash); },
  } as unknown as Store;
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent', NODE_ENV: 'production',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), FRONTEND_CLIENTS_JSON: JSON.stringify(registry) });
  const app = await buildApp(config, store, { ...unavailableSchoolProvider,
    auth: { providerId: 'synthetic', createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),
      verifyCallback: async () => { verifies++; if (failure) throw failure; return {subject: 'synthetic-subject', schoolSession: {synthetic: true}}; } } });
  async function begin(id = bearerClient.id, extra: Record<string, string> = {}) {
    const query = {clientId: id, ...(id === bearerClient.id ? {redirectUri: bearerClient.defaultRedirectUri, clientState, codeChallenge: challenge, codeChallengeMethod: 'S256'} : {}), ...extra};
    const response = await app.inject('/v1/auth/login?' + new URLSearchParams(query));
    assert.equal(response.statusCode, 200);
    const callback = new URL(new URL(response.json().url).searchParams.get('apiReturnUrl')!);
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const path = callback.pathname + '?sToken=synthetic-only&sIdno=synthetic-subject';
    return {response, path, cookie, callback};
  }
  async function finish(id?: string) {
    const started = await begin(id);
    const response = await app.inject({url: started.path, headers: {cookie: started.cookie, accept: 'text/html'}});
    assert.equal(response.statusCode, 303); return {started, response};
  }
  const exchange = (code: string, extra: Record<string, unknown> = {}, origin = bearerClient.origins[0]!) => app.inject({ method: 'POST', url: '/v1/auth/token',
    headers: {origin, accept: 'application/json'}, payload: {clientId: bearerClient.id, code, codeVerifier: verifier, redirectUri: bearerClient.defaultRedirectUri, ...extra} });
  return {app, attempts, grants, sessions, begin, finish, exchange, setFailure: (error: Error) => {failure = error;}, counts: () => ({verifies, issues, logout})};
}

test('registry rejects cross-site cookie clients, open redirects, malformed origins and duplicate reserved IDs', () => {
  const base = {DATABASE_URL: 'postgres://unused', NODE_ENV: 'production'};
  for (const registration of [ {...bearerClient, authMode: 'cookie'}, {...bearerClient, origins: ['https://synthetic.github.io/path']},
    {...cookieClient, id: 'alms-web'}, {...bearerClient, redirectUris: ['https://evil.invalid/']},
    {...bearerClient, defaultRedirectUri: 'https://evil.invalid/'}, {...bearerClient, origins: ['https://*.github.io']},
    {...bearerClient, redirectUris: ['https://synthetic.github.io/alms/?next=https://evil.invalid']} ]) {
    assert.throws(() => loadConfig({...base, FRONTEND_CLIENTS_JSON: JSON.stringify([registration])}));
  }
  // Private public suffixes mean two GitHub Pages sites are distinct cookie sites.
  assert.throws(() => loadConfig({...base, API_PUBLIC_ORIGIN: 'https://another.github.io', FRONTEND_CLIENTS_JSON: JSON.stringify([{...bearerClient, authMode: 'cookie'}])}));
});

test('unregistered clients, nonexact return URLs and missing S256 fail before issuing state or school requests', async () => {
  const f = await fixture(); try {
    for (const query of [{clientId: 'unregistered'}, {clientId: cookieClient.id, redirectUri: cookieClient.defaultRedirectUri + '?next=evil'},
      {clientId: bearerClient.id}, {clientId: bearerClient.id, clientState, codeChallenge: challenge, codeChallengeMethod: 'plain'}]) {
      const response = await f.app.inject('/v1/auth/start?' + new URLSearchParams(query));
      assert.equal(response.statusCode, 400); assert.equal(response.headers.location, undefined);
    }
    assert.equal(f.attempts.size, 0); assert.deepEqual(f.counts(), {verifies: 0, issues: 0, logout: 0});
  } finally { await f.app.close(); }
});

test('each cookie client returns to its registered success and failure location while retaining HttpOnly Secure Lax cookies', async () => {
  const f = await fixture(); try {
    const {response} = await f.finish(cookieClient.id);
    assert.equal(response.headers.location, cookieClient.defaultRedirectUri);
    assert.match(String(response.headers['set-cookie']), /__Host-alms_session_other-web=.*HttpOnly; Secure; SameSite=Lax/);
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    assert.equal((await f.app.inject({url: '/v1/me', headers: {cookie, origin: cookieClient.origins[0]}})).statusCode, 200);
    assert.equal((await f.app.inject({url: '/v1/me', headers: {cookie, origin: bearerClient.origins[0]}})).statusCode, 403);
    f.setFailure(new AppError(401, 'SCHOOL_AUTH_FAILED', 'synthetic raw detail'));
    const {response: failed} = await f.finish(cookieClient.id);
    assert.equal(failed.headers.location, cookieClient.defaultRedirectUri + '#/login?reason=school_auth_failed&clientId=other-web');
    assert.equal(failed.headers['set-cookie'], undefined); assert.doesNotMatch(failed.body, /raw detail/);
    const retry = await f.begin(cookieClient.id);
    const missing = await f.app.inject({url: retry.path, headers: {accept: 'text/html'}});
    assert.equal(missing.headers.location, cookieClient.defaultRedirectUri + '#/login?reason=login_expired&clientId=other-web');
  } finally { await f.app.close(); }
});

test('bearer login returns only a bound one-use code, requires PKCE plus exact Origin, and never downgrades cookie protection', async () => {
  const f = await fixture(); try {
    const {response} = await f.finish();
    assert.equal(response.headers['set-cookie'], undefined);
    const returned = new URL(String(response.headers.location));
    const params = new URLSearchParams(returned.hash.split('?')[1]);
    const code = params.get('code')!;
    assert.equal(params.get('clientId'), bearerClient.id); assert.equal(params.get('clientState'), clientState);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/); assert.doesNotMatch(returned.toString(), /sToken|synthetic-subject|accessToken|csrfToken/);
    assert.equal((await f.exchange(code, {}, 'https://evil.invalid')).statusCode, 403);
    assert.equal((await f.exchange(code, {codeVerifier: 'wrong'.repeat(16)})).statusCode, 401);
    assert.equal([...f.grants.values()][0]!.consumed, false, 'invalid verifier cannot consume the bound grant');
    const exchanged = await f.exchange(code); assert.equal(exchanged.statusCode, 200);
    assert.equal(exchanged.headers['set-cookie'], undefined); assert.equal(exchanged.headers['cache-control'], 'no-store');
    const body = exchanged.json(); assert.match(body.accessToken, /^[A-Za-z0-9_-]{43}$/); assert.equal(body.tokenType, 'Bearer');
    assert.equal((await f.exchange(code)).statusCode, 401);
    const headers = {origin: bearerClient.origins[0]!, authorization: 'Bearer ' + body.accessToken, 'x-alms-client-id': bearerClient.id, accept: 'application/json'};
    const me = await f.app.inject({url: '/v1/me', headers}); assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json().client, {id: bearerClient.id, authMode: 'bearer'});
    assert.equal((await f.app.inject({url: '/v1/me', headers: {...headers, 'x-alms-client-id': cookieClient.id}})).statusCode, 403);
    assert.equal((await f.app.inject({url: '/v1/me', headers: {authorization: headers.authorization}})).statusCode, 403);
    assert.equal((await f.app.inject({url: '/v1/me', headers: {cookie: '__Host-alms_session=' + body.accessToken}})).statusCode, 403);
    assert.equal((await f.app.inject({method: 'POST', url: '/v1/auth/logout', headers})).statusCode, 403);
    const loggedOut = await f.app.inject({method: 'POST', url: '/v1/auth/logout', headers: {...headers, 'x-csrf-token': body.csrfToken}});
    assert.equal(loggedOut.statusCode, 204); assert.equal(loggedOut.headers['set-cookie'], undefined);
    assert.equal((await f.app.inject({url: '/v1/me', headers})).statusCode, 401);
  } finally { await f.app.close(); }
});

test('expired, revoked-session, and concurrently exchanged grants never yield a second bearer credential', async () => {
  for (const mode of ['expired', 'revoked', 'concurrent'] as const) {
    const f = await fixture(); try {
      const {response} = await f.finish(); const code = new URLSearchParams(new URL(String(response.headers.location)).hash.split('?')[1]).get('code')!;
      if (mode === 'expired') [...f.grants.values()][0]!.expires = Date.now() - 1;
      if (mode === 'revoked') f.sessions.clear();
      const results = await Promise.all([f.exchange(code), f.exchange(code)]);
      assert.equal(results.filter(value => value.statusCode === 200).length, mode === 'concurrent' ? 1 : 0);
      assert.equal(results.filter(value => value.statusCode === 401).length, mode === 'concurrent' ? 1 : 2);
    } finally { await f.app.close(); }
  }
});

test('legacy callback POST with state in its body retains the started client on success and verification failure', async () => {
  for (const id of [cookieClient.id, bearerClient.id]) for (const denied of [false, true]) {
    const f = await fixture(); try {
      const started = await f.begin(id);
      if (denied) f.setFailure(new AppError(401,'SCHOOL_AUTH_FAILED','synthetic private failure'));
      const response = await f.app.inject({method: 'POST', url: '/v1/auth/callback', headers: {cookie: started.cookie, accept: 'text/html'},
        payload: {state: started.callback.pathname.split('/').at(-1), sToken: 'synthetic-only', sIdno: 'synthetic-subject'}});
      assert.equal(response.statusCode,303);
      assert.equal(new URL(String(response.headers.location)).origin, id === cookieClient.id ? cookieClient.origins[0] : bearerClient.origins[0]);
      if (id === bearerClient.id) { assert.equal(response.headers['set-cookie'],undefined); assert.match(String(response.headers.location), /clientState=/); }
      if (denied) assert.match(String(response.headers.location), /reason=school_auth_failed/);
    } finally { await f.app.close(); }
  }
});

test('two frontend logins preserve independent binding and session cookies, and logout clears only its client', async () => {
  const f = await fixture(); try {
    const legacy = await f.begin('alms-web'), other = await f.begin(cookieClient.id);
    assert.match(legacy.cookie,/^__Host-alms_login=/); assert.match(other.cookie,/^__Host-alms_login_other-web=/);
    const bindings = legacy.cookie + '; ' + other.cookie;
    const results = await Promise.all([legacy,other].map(start=>f.app.inject({url:start.path,headers:{cookie:bindings,accept:'text/html'}})));
    assert.ok(results.every(response=>response.statusCode===303));
    const cookies = results.map(response=>String(response.headers['set-cookie']).split(';')[0]).join('; ');
    assert.match(cookies,/__Host-alms_session=/); assert.match(cookies,/__Host-alms_session_other-web=/);
    const original = await f.app.inject({url:'/v1/me',headers:{cookie:cookies,origin:'https://lms.flyjung.kr'}});
    const second = await f.app.inject({url:'/v1/me',headers:{cookie:cookies,origin:cookieClient.origins[0]}});
    assert.equal(original.statusCode,200); assert.equal(second.statusCode,200); assert.notEqual(original.json().user.id,second.json().user.id);
    const logout = await f.app.inject({method:'POST',url:'/v1/auth/logout',headers:{cookie:cookies,origin:cookieClient.origins[0],
      'x-alms-client-id':cookieClient.id,'x-csrf-token':second.json().csrfToken}});
    assert.equal(logout.statusCode,204); assert.match(String(logout.headers['set-cookie']),/^__Host-alms_session_other-web=/);
    assert.doesNotMatch(String(logout.headers['set-cookie']),/__Host-alms_session=/);
    assert.equal((await f.app.inject({url:'/v1/me',headers:{cookie:cookies,origin:'https://lms.flyjung.kr'}})).statusCode,200);
  } finally {await f.app.close();}
});

test('explicit default client after its logout cannot fall back to another frontend session cookie', async () => {
  const f = await fixture(); try {
    const originalLogin = await f.finish('alms-web');
    const otherLogin = await f.finish(cookieClient.id);
    const originalCookie = String(originalLogin.response.headers['set-cookie']).split(';')[0]!;
    const otherCookie = String(otherLogin.response.headers['set-cookie']).split(';')[0]!;
    const bothCookies = originalCookie + '; ' + otherCookie;
    const original = await f.app.inject({url: '/v1/me', headers: {cookie: bothCookies, origin: 'https://lms.flyjung.kr',
      'x-alms-client-id': 'alms-web'}});
    assert.equal(original.statusCode, 200);
    const loggedOut = await f.app.inject({method: 'POST', url: '/v1/auth/logout', headers: {cookie: bothCookies,
      origin: 'https://lms.flyjung.kr', 'x-alms-client-id': 'alms-web', 'x-csrf-token': original.json().csrfToken}});
    assert.equal(loggedOut.statusCode, 204);
    assert.match(String(loggedOut.headers['set-cookie']), /^__Host-alms_session=;/);
    assert.doesNotMatch(String(loggedOut.headers['set-cookie']), /__Host-alms_session_other-web=/);

    // Simulate the browser applying only the default client's cookie removal.
    const remaining = {cookie: otherCookie, origin: 'https://lms.flyjung.kr'};
    const inferred = await f.app.inject({url: '/v1/me', headers: remaining});
    assert.equal(inferred.statusCode, 403);
    assert.equal(inferred.json().error.code, 'CLIENT_ORIGIN_INVALID');
    const declared = await f.app.inject({url: '/v1/me', headers: {...remaining, 'x-alms-client-id': 'alms-web'}});
    assert.equal(declared.statusCode, 401);
    assert.equal(declared.json().error.code, 'AUTH_REQUIRED');

    const other = await f.app.inject({url: '/v1/me', headers: {cookie: otherCookie, origin: cookieClient.origins[0],
      'x-alms-client-id': cookieClient.id}});
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().client.id, cookieClient.id);
    assert.equal(f.sessions.size, 1);
    assert.deepEqual(f.counts(), {verifies: 2, issues: 2, logout: 1});
  } finally { await f.app.close(); }
});

test('preflight exposes only registered origins and public contract headers', async () => {
  const f = await fixture(); try {
    const response = await f.app.inject({method: 'OPTIONS', url: '/v1/me', headers: {origin: bearerClient.origins[0]!,
      'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-alms-client-id'}});
    assert.equal(response.statusCode, 204); assert.equal(response.headers['access-control-allow-origin'], bearerClient.origins[0]);
    assert.match(String(response.headers['access-control-allow-headers']), /Authorization/);
    const denied = await f.app.inject({method: 'OPTIONS', url: '/v1/me', headers: {origin: 'https://evil.invalid', 'access-control-request-method': 'GET'}});
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  } finally { await f.app.close(); }
});
