import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { Pool } from 'pg';
import type { JWKS } from 'oidc-provider';
import { PgStore } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createMcpAuthorization } from '../../src/mcp-auth/index.js';
import type { Session } from '../../src/domain.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { mcpNativeRedirectUris } from '../../src/mcp-config.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test', '/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');
const apiOrigin = 'http://127.0.0.1:4300', issuer = apiOrigin + '/oauth', resource = apiOrigin + '/mcp';
const redirectUri = 'http://127.0.0.1:8123/callback', clientId = 'alms-codex';
const privateJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
const signingJwks = { keys: [{ ...privateJwk, kid: 'synthetic-pg-test-key', use: 'sig', alg: 'RS256' }] } as JWKS;

describe('real PostgreSQL: MCP consent, OAuth code/refresh, revocation and session isolation', { skip: !databaseUrl }, () => {
  let pool: Pool, store: PgStore;
  const users: string[] = [];
  before(async () => { pool = new Pool({ connectionString: databaseUrl, max: 10 }); store = new PgStore(pool); await migrate(pool); });
  after(async () => {
    if (pool) {
      if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
    }
  });
  async function fixture(ttl = 3600, withHttpApp = false, callback = redirectUri) {
    const own = await store.issueVerifiedSession({ provider: 'mcp-integration-test', subject: randomUUID(), displayName: '합성 사용자' }, ttl);
    users.push(own.user.id);
    const service = createMcpAuthorization({ apiOrigin, frontendOrigin: 'https://lms.flyjung.kr', issuer, resource, pool, store, encryptionKey: Buffer.alloc(32, 9), signingJwks,
      cookieKeys: ['synthetic-pg-cookie-signing-key-'.repeat(3)], cookieName: 'alms_session_dev', client: { id: clientId,
        redirectUris: mcpNativeRedirectUris(resource) } });
    const app = withHttpApp ? await buildApp(loadConfig({ DATABASE_URL: databaseUrl, COOKIE_SECURE: 'false', API_PUBLIC_ORIGIN: apiOrigin,
      FRONTEND_ORIGIN: 'http://127.0.0.1:5173', LOG_LEVEL: 'silent' }), store) : Fastify();
    if (!withHttpApp) { await app.register(cookie); await app.register(formbody); }
    await service.register(app);
    const jar = new Map<string, string>([['alms_session_dev', own.token]]);
    const request = async (url: string, input: { body?: Record<string, string>; origin?: string | null; useCookies?: boolean } = {}) => {
      const target = new URL(url, apiOrigin);
      assert.equal(target.origin, apiOrigin, 'Never follow an issued loopback redirect or any other origin during server tests');
      const result = await app.inject({ method: input.body ? 'POST' : 'GET', url: target.pathname + target.search,
        headers: { host: '127.0.0.1:4300', ...(input.useCookies === false ? {} : { cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') }),
          ...(input.body ? { 'content-type': 'application/x-www-form-urlencoded',
            ...(input.origin === null ? {} : input.origin !== undefined ? { origin: input.origin } : input.useCookies === false ? {} : { origin: apiOrigin }) } : {}) },
        ...(input.body ? { payload: new URLSearchParams(input.body).toString() } : {}) });
      const cookies = result.headers['set-cookie'];
      for (const value of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
        const pair = value.split(';')[0]!, at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return result;
    };
    const start = async () => {
      const verifier = 'a'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'alms:read',
        resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic-state' });
      const started = await request('/oauth/auth?' + params);
      assert.equal(started.statusCode, 303, started.body);
      const interactionUrl = started.headers.location!;
      const page = await request(interactionUrl); assert.equal(page.statusCode, 200, page.body);
      return { interactionUrl, verifier, page };
    };
    const begin = async () => {
      const { interactionUrl, verifier, page } = await start();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
      const nonce = /name="nonce" value="([^"]+)"/.exec(page.body)?.[1]; assert.ok(csrf); assert.ok(nonce);
      assert.equal(page.headers['referrer-policy'], 'same-origin'); assert.equal(page.headers['cache-control'], 'no-store');
      assert.equal(page.headers['x-frame-options'], 'DENY'); assert.match(String(page.headers['content-security-policy']), /form-action 'self'; frame-ancestors 'none'/);
      return { interactionUrl, csrf, nonce, verifier };
    };
    const handoffTarget = (response: Awaited<ReturnType<typeof request>>, interactionUrl: string) => {
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['referrer-policy'], 'no-referrer'); assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(String(response.headers['content-security-policy']), /form-action 'self'/);
      assert.doesNotMatch(response.body, /<script|<form/);
      const expected = apiOrigin + '/oauth/auth/' + new URL(interactionUrl).pathname.split('/').at(-1);
      const target = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(response.body)?.[1];
      assert.equal(target, expected); assert.ok(response.body.includes('href="' + expected + '"'));
      return expected;
    };
    const approve = async () => {
      const pending = await begin();
      const consent = await request(pending.interactionUrl, { body: { csrf: pending.csrf, nonce: pending.nonce, decision: 'approve' } });
      const finished = await request(handoffTarget(consent, pending.interactionUrl)); assert.equal(finished.statusCode, 303, finished.body);
      const returned = new URL(finished.headers.location!); assert.equal(returned.origin + returned.pathname, callback);
      assert.equal(returned.searchParams.get('state'), 'synthetic-state'); const code = returned.searchParams.get('code'); assert.ok(code, returned.search);
      const exchanged = await request('/oauth/token', { useCookies: false, body: { grant_type: 'authorization_code', client_id: clientId,
        redirect_uri: callback, code, code_verifier: pending.verifier, resource } });
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      return { pending, code, tokens: exchanged.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string } };
    };
    return { app, service, own, request, start, begin, approve, handoffTarget, setBrowserToken: (token: string) => jar.set('alms_session_dev', token), close: async () => { await app.close(); await service.close(); } };
  }

  it('native variable loopback port completes code+S256 and authenticates only the verified owner, with bounded lifetime', async () => {
    const f = await fixture(120, true);
    try {
      const flow = await f.approve();
      assert.equal(flow.tokens.token_type, 'Bearer'); assert.equal(flow.tokens.scope, 'alms:read');
      assert.ok(flow.tokens.expires_in > 0 && flow.tokens.expires_in <= 120); assert.ok(flow.tokens.refresh_token);
      assert.equal(new URL(flow.pending.interactionUrl).origin, apiOrigin);
      const principal = await f.service.authenticate(flow.tokens.access_token);
      assert.equal(principal.userId, f.own.user.id); assert.equal(principal.sessionTokenHash.length, 64); assert.deepEqual(principal.scopes, ['alms:read']);
      await principal.validate();
      await assert.rejects(f.service.authenticate(f.own.token), { code: 'MCP_AUTH_REQUIRED' });
      const browserHeaders = { host: '127.0.0.1:4300', cookie: 'alms_session_dev=' + f.own.token,
        origin: 'http://127.0.0.1:5173' };
      assert.equal((await f.app.inject({ url: '/v1/me', headers: browserHeaders })).statusCode, 200);
      const unsafeLogout = await f.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: browserHeaders });
      assert.equal(unsafeLogout.statusCode, 403);
      assert.equal(unsafeLogout.json().error.code, 'CSRF_INVALID');
      const restWithMcpToken = await f.app.inject({ url: '/v1/me', headers: { host: '127.0.0.1:4300',
        authorization: 'Bearer ' + flow.tokens.access_token, 'x-alms-client-id': 'alms-web', origin: 'http://127.0.0.1:5173' } });
      assert.ok([401, 403].includes(restWithMcpToken.statusCode));
      await principal.validate();
      const row = await pool.query('SELECT * FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id]);
      assert.equal(row.rowCount, 1); assert.equal(new Date(row.rows[0].expires_at).toISOString(), f.own.expiresAt);
      assert.doesNotMatch(JSON.stringify(row.rows), new RegExp(flow.tokens.access_token));
    } finally { await f.close(); }
  });

  it('the exact Codex callback suffix completes consent, code exchange and owner validation with a variable loopback port', async () => {
    const f = await fixture(120, true, 'http://127.0.0.1:49152/callback/xMAw8DYbtWUt');
    try {
      const { tokens } = await f.approve();
      const principal = await f.service.authenticate(tokens.access_token);
      assert.equal(principal.userId, f.own.user.id); assert.ok(tokens.refresh_token); await principal.validate();
    } finally { await f.close(); }
  });

  it('consent rejects foreign Origin, wrong CSRF/nonce, caller identity and consumed approval without issuing another grant', async () => {
    const f = await fixture(3600, true);
    try {
      const pending = await f.begin(), input = { csrf: pending.csrf, nonce: pending.nonce, decision: 'approve' };
      for (const origin of [null, 'null', 'https://evil.example']) {
        const denied = await f.request(pending.interactionUrl, { origin, body: input });
        assert.equal(denied.statusCode, 403); assert.equal(denied.json().error.code, 'CSRF_INVALID');
        assert.equal(denied.headers['referrer-policy'], 'no-referrer');
      }
      assert.equal((await f.request(pending.interactionUrl, { body: { ...input, csrf: 'wrong' } })).statusCode, 403);
      assert.ok((await f.request(pending.interactionUrl, { body: { ...input, nonce: 'b'.repeat(43) } })).statusCode >= 400);
      assert.ok((await f.request(pending.interactionUrl, { body: { ...input, userId: randomUUID() } })).statusCode >= 400);
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id])).rowCount, 0);
      const accepted = await f.request(pending.interactionUrl, { body: input }); f.handoffTarget(accepted, pending.interactionUrl);
      assert.ok((await f.request(pending.interactionUrl, { body: input })).statusCode >= 400);
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id])).rowCount, 1);
    } finally { await f.close(); }
  });

  it('deny uses the same private document handoff, reaches only its exact resume URL and issues no authorization', async () => {
    const f = await fixture(3600, true);
    try {
      const pending = await f.begin();
      const denied = await f.request(pending.interactionUrl, { body: { csrf: pending.csrf, nonce: pending.nonce, decision: 'deny' } });
      const resumed = await f.request(f.handoffTarget(denied, pending.interactionUrl));
      assert.equal(resumed.statusCode, 303, resumed.body);
      const returned = new URL(resumed.headers.location!); assert.equal(returned.origin + returned.pathname, redirectUri);
      assert.equal(returned.searchParams.get('error'), 'access_denied'); assert.equal(returned.searchParams.get('code'), null);
      assert.equal(returned.searchParams.get('state'), 'synthetic-state');
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id])).rowCount, 0);
      const replay = await f.request(pending.interactionUrl, { body: { csrf: pending.csrf, nonce: pending.nonce, decision: 'deny' } });
      assert.ok(replay.statusCode >= 400);
    } finally { await f.close(); }
  });

  it('refresh rotates once and replay revokes all access in that chain', async () => {
    const f = await fixture(3600, true);
    try {
      const { tokens } = await f.approve();
      for (const browserOrigin of [apiOrigin, 'http://127.0.0.1:5173']) {
        const forbiddenBrowser = await f.request('/oauth/token', { useCookies: false, origin: browserOrigin,
          body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource } });
        assert.equal(forbiddenBrowser.statusCode, 400); assert.equal(forbiddenBrowser.json().error, 'invalid_request');
      }
      const refreshed = await f.request('/oauth/token', { useCookies: false, body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource } });
      assert.equal(refreshed.statusCode, 200, refreshed.body);
      const next = refreshed.json(); assert.notEqual(next.refresh_token, tokens.refresh_token);
      await f.service.authenticate(next.access_token);
      const replay = await f.request('/oauth/token', { useCookies: false, body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource } });
      assert.equal(replay.statusCode, 400); assert.equal(replay.json().error, 'invalid_grant');
      await assert.rejects(f.service.authenticate(next.access_token), { code: 'MCP_AUTH_REQUIRED' });
      await assert.rejects(f.service.authenticate(tokens.access_token), { code: 'MCP_AUTH_REQUIRED' });
    } finally { await f.close(); }
  });

  it('OAuth revocation and ALMS logout invalidate existing principals without changing school data', async () => {
    const f = await fixture();
    try {
      const { tokens } = await f.approve(), principal = await f.service.authenticate(tokens.access_token);
      const revoked = await f.request('/oauth/token/revocation', { useCookies: false, body: { client_id: clientId, token: tokens.access_token, token_type_hint: 'access_token' } });
      assert.equal(revoked.statusCode, 200, revoked.body); await assert.rejects(principal.validate(), { code: 'MCP_AUTH_REQUIRED' });
      const second = await f.approve(), active = await f.service.authenticate(second.tokens.access_token);
      await store.deleteSession(active.sessionTokenHash);
      await assert.rejects(active.validate(), { code: 'MCP_AUTH_REQUIRED' });
      await assert.rejects(f.service.authenticate(second.tokens.access_token), { code: 'MCP_AUTH_REQUIRED' });
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id])).rowCount, 0);
    } finally { await f.close(); }
  });

  it('ALMS expiry prevents access and refresh while a remaining OIDC cookie opens a fresh login prompt without a server error', async () => {
    const f = await fixture(120, true);
    try {
      const { tokens } = await f.approve(), principal = await f.service.authenticate(tokens.access_token);
      await pool.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1 AND user_id=$2', [principal.sessionTokenHash, f.own.user.id]);
      await assert.rejects(principal.validate(), { code: 'MCP_AUTH_REQUIRED' });
      await assert.rejects(f.service.authenticate(tokens.access_token), { code: 'MCP_AUTH_REQUIRED' });
      const refreshed = await f.request('/oauth/token', { useCookies: false, body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource } });
      assert.equal(refreshed.statusCode, 400, refreshed.body); assert.equal(refreshed.json().error, 'invalid_grant');
      const next = await f.start();
      assert.match(next.page.body, /ALMS 로그인이 필요해요/); assert.doesNotMatch(next.page.body, /name="nonce"/);
      assert.equal(next.page.headers['referrer-policy'], 'no-referrer');
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [f.own.user.id])).rowCount, 1);
    } finally { await f.close(); }
  });

  it('an existing OIDC identity cannot approve a changed ALMS owner or relabel an existing bearer', async () => {
    const f = await fixture(120, true);
    const other = await store.issueVerifiedSession({ provider: 'mcp-integration-test', subject: randomUUID(), displayName: '다른 합성 사용자' }, 120);
    users.push(other.user.id);
    try {
      const { tokens } = await f.approve();
      f.setBrowserToken(other.token);
      const pending = await f.start();
      assert.match(pending.page.body, /ALMS 계정이 변경되었어요/);
      assert.equal(pending.page.headers['referrer-policy'], 'no-referrer');
      assert.doesNotMatch(pending.page.body, /name="nonce"|합성 사용자/);
      const before = await pool.query('SELECT id,user_id FROM mcp_authorizations WHERE user_id=ANY($1::uuid[])', [[f.own.user.id, other.user.id]]);
      assert.equal(before.rowCount, 1); assert.equal(before.rows[0].user_id, f.own.user.id);
      const forged = await f.request(pending.interactionUrl, { body: { csrf: other.csrfToken, nonce: 'a'.repeat(43), decision: 'approve' } });
      assert.equal(forged.statusCode, 403); assert.equal(forged.json().error.code, 'MCP_AUTH_ACCOUNT_CHANGED');
      assert.equal((await pool.query('SELECT id FROM mcp_authorizations WHERE user_id=$1', [other.user.id])).rowCount, 0);
      assert.equal((await f.service.authenticate(tokens.access_token)).userId, f.own.user.id);
    } finally { await f.close(); }
  });
});
