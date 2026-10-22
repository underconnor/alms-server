import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { Pool } from 'pg';
import type { JWKS } from 'oidc-provider';
import { createMcpAuthorization, mcpRevocationAllowed, type McpAuthorizationOptions } from '../src/mcp-auth/index.js';
import { McpAuthorizationRepository, digest } from '../src/mcp-auth/repository.js';
import { consentHtml, signInHtml } from '../src/mcp-auth/html.js';
import { mcpNativeRedirectUris } from '../src/mcp-config.js';

const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
const signingJwks = { keys: [{ ...jwk, kid: 'synthetic-test-key', use: 'sig', alg: 'RS256' }] } as JWKS;
const options = (pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool): McpAuthorizationOptions => ({
  apiOrigin: 'http://127.0.0.1:4300', frontendOrigin: 'https://lms.flyjung.kr', issuer: 'http://127.0.0.1:4300/oauth', resource: 'http://127.0.0.1:4300/mcp',
  store: { getSession: async () => null }, pool, encryptionKey: Buffer.alloc(32, 7), signingJwks, cookieKeys: ['synthetic-cookie-key-'.repeat(3)],
  cookieName: 'alms_session_dev', client: { id: 'alms-codex', redirectUris: mcpNativeRedirectUris('http://127.0.0.1:4300/mcp') },
});
async function fixture() {
  let queries = 0;
  const service = createMcpAuthorization(options({ query: async (sql: string) => {
    if (sql.includes('AS session_binding')) return { rows: [{ migration: true, authorizations: true, challenges: true, objects: true, session_binding: true, challenge_binding: true }] };
    queries++; return { rows: [], rowCount: 0 };
  } } as unknown as Pool));
  const app = Fastify(); await app.register(cookie); await app.register(formbody); await service.register(app);
  return { app, service, queries: () => queries };
}

test('MCP authorization fails closed for missing keys, changed issuers and non-native redirect metadata', () => {
  for (const patch of [{ encryptionKey: Buffer.alloc(31) }, { cookieKeys: [] }, { signingJwks: { keys: [] } }, { issuer: 'https://evil.example/oauth' },
    { resource: 'http://127.0.0.1:4300/other' }, { client: { id: 'other', redirectUris: ['http://127.0.0.1/callback'] } },
    ...['https://evil.example/callback', 'http://127.0.0.1/other', 'http://127.0.0.1/callback?code=1', 'http://a@127.0.0.1/callback',
      'http://127.0.0.1/callback/mCKDGNpl4J3j', 'http://localhost/callback/unknown', 'http://127.0.0.1/callback/*',
      'http://127.0.0.1/callback/xMAw8DYbtWUt/extra', 'http://localhost/callback/xMAw8DYbtWUt?code=1',
      'http://localhost/callback/xMAw8DYbtWUt#fragment', 'http://u@localhost/callback/xMAw8DYbtWUt',
      'http://127.0.0.1/no/../callback', 'http:localhost/callback', 'http://2130706433/callback',
      'http://LOCALHOST/callback', ' http://localhost/callback', 'http://localhost:80/callback']
      .map(url => ({ client: { id: 'alms-codex', redirectUris: [url] } }))]) assert.throws(() => createMcpAuthorization({ ...options(), ...patch }));
});

test('native authorization accepts only the exact Codex callback path or the legacy path with variable loopback ports', async () => {
  const f = await fixture();
  const base = new URLSearchParams({ client_id: 'alms-codex', response_type: 'code', scope: 'alms:read', resource: options().resource,
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'synthetic-state' });
  try {
    for (const redirect of ['http://127.0.0.1:8123/callback/xMAw8DYbtWUt', 'http://localhost:49152/callback/xMAw8DYbtWUt', 'http://127.0.0.1:8124/callback']) {
      const query = new URLSearchParams(base); query.set('redirect_uri', redirect);
      const result = await f.app.inject({ url: '/oauth/auth?' + query, headers: { host: '127.0.0.1:4300' } });
      assert.equal(result.statusCode, 303); assert.match(result.headers.location!, /^http:\/\/127\.0\.0\.1:4300\/oauth\/interaction\//);
    }
    for (const redirect of ['http://127.0.0.1:8123/callback/unknown', 'http://localhost:49152/callback/mCKDGNpl4J3j',
      'http://127.0.0.1:8123/callback/xMAw8DYbtWUt/extra', 'http://localhost:8123/callback/xMAw8DYbtWUt?code=1', 'http://evil.example/callback/xMAw8DYbtWUt']) {
      const query = new URLSearchParams(base); query.set('redirect_uri', redirect);
      const result = await f.app.inject({ url: '/oauth/auth?' + query, headers: { host: '127.0.0.1:4300' } });
      assert.equal(result.statusCode, 400); assert.equal(result.headers.location, undefined);
    }
  } finally { await f.app.close(); await f.service.close(); }
});

test('revocation policy checks the third token argument against the authenticated native client', () => {
  const context = { oidc: { client: { clientId: 'alms-codex' } } };
  assert.equal(mcpRevocationAllowed(context, { clientId: 'alms-codex' }, { clientId: 'alms-codex' }), true);
  assert.equal(mcpRevocationAllowed(context, { clientId: 'alms-codex' }, { clientId: 'foreign-client' }), false);
  assert.equal(mcpRevocationAllowed(context, { clientId: 'alms-codex' }, {}), false);
  assert.equal(mcpRevocationAllowed(context, { clientId: 'foreign-client' }, { clientId: 'foreign-client' }), false);
});

test('enabled authorization refuses to register routes when migration, tables or session bindings are absent', async () => {
  for (const missing of ['migration', 'authorizations', 'challenges', 'objects', 'session_binding', 'challenge_binding']) {
    const app = Fastify(), row = Object.fromEntries(['migration', 'authorizations', 'challenges', 'objects', 'session_binding', 'challenge_binding'].map(key => [key, key !== missing]));
    const service = createMcpAuthorization(options({ query: async () => ({ rows: [row] }) } as unknown as Pool));
    try { await assert.rejects(service.register(app), /migrations are pending or invalid/); assert.equal((await app.inject('/oauth/jwks')).statusCode, 404); }
    finally { await service.close(); await app.close(); }
  }
});

test('OAuth discovery uses the exact issuer and native client metadata without touching school or issuing sessions', async () => {
  const f = await fixture();
  try {
    const result = await f.app.inject({ url: '/.well-known/oauth-authorization-server/oauth', headers: { host: '127.0.0.1:4300' } });
    assert.equal(result.statusCode, 200);
    const body = result.json();
    assert.equal(body.issuer, options().issuer); assert.equal(body.authorization_endpoint, options().issuer + '/auth');
    assert.equal(body.token_endpoint, options().issuer + '/token');
    assert.ok(body.code_challenge_methods_supported.includes('S256'));
    assert.deepEqual(body.scopes_supported, ['alms:read']);
    assert.equal(body.registration_endpoint, undefined); assert.equal(body.userinfo_endpoint, undefined);
    assert.equal(f.queries(), 0);
    assert.equal((await f.app.inject({ url: '/oauth/jwks', headers: { host: 'evil.example' } })).statusCode, 400);
  } finally { await f.app.close(); await f.service.close(); }
});

test('native authorization rejects absent/foreign resource, writes and weaker PKCE before persisting OAuth state', async () => {
  const f = await fixture();
  const base = new URLSearchParams({ client_id: 'alms-codex', redirect_uri: 'http://127.0.0.1:8123/callback', response_type: 'code', scope: 'alms:read',
    resource: options().resource, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'synthetic-state' });
  try {
    for (const [key, value] of [['resource', null], ['resource', 'https://evil.example/mcp'], ['scope', 'alms:read alms:write'], ['scope', 'alms:read offline_access'], ['code_challenge_method', 'plain']] as const) {
      const query = new URLSearchParams(base); if (value === null) query.delete(key); else query.set(key, value);
      const result = await f.app.inject({ url: '/oauth/auth?' + query, headers: { host: '127.0.0.1:4300' } });
      assert.equal(result.statusCode, 400); assert.ok(result.json().error); assert.equal(f.queries(), 0);
    }
  } finally { await f.app.close(); await f.service.close(); }
});

test('MCP bearer parsing cannot authenticate missing, forged or ALMS cookie tokens', async () => {
  const f = await fixture();
  try {
    for (const token of ['', 'Bearer abc', 'a'.repeat(43), 'a'.repeat(257), 'a.b.c']) await assert.rejects(f.service.authenticate(token), { code: 'MCP_AUTH_REQUIRED' });
    const abort = new AbortController(); abort.abort(); await assert.rejects(f.service.authenticate('a'.repeat(43), abort.signal), { name: 'AbortError' });
  } finally { await f.app.close(); await f.service.close(); }
});

test('OAuth adapter persists only hashed lookup identifiers and domain-separated ciphertext', async () => {
  const writes: Array<{ sql: string; values: unknown[] }> = []; let row: Record<string, unknown> | undefined;
  const pool = { query: async (sql: string, values: unknown[]) => {
    writes.push({ sql, values });
    if (sql.startsWith('INSERT INTO mcp_oauth_objects')) row = { id_hash: values[1], payload_enc: values[2], consumed_at: null };
    return { rows: row && sql.startsWith('SELECT id_hash') ? [row] : [], rowCount: 1 };
  } } as unknown as Pool;
  const repo = new McpAuthorizationRepository(pool, Buffer.alloc(32, 7)), adapter = repo.adapter('AccessToken');
  const payload = { kind: 'AccessToken', accountId: randomUUID(), aud: options().resource, grantId: 'private-grant', scope: 'alms:read', exp: 2000000000 };
  await adapter.upsert('private-bearer-token', payload, 300);
  assert.equal(writes[0]!.values[1], digest('private-bearer-token'));
  assert.doesNotMatch(JSON.stringify(writes[0]!.values), /private-bearer-token|private-grant|alms:read|2000000000/);
  assert.deepEqual(await adapter.find('private-bearer-token'), payload);
  row!.consumed_at = '2030-01-01T00:00:00Z'; assert.ok((await adapter.find('private-bearer-token'))?.consumed);
  const differentKey = new McpAuthorizationRepository(pool, Buffer.alloc(32, 8));
  await assert.rejects(differentKey.adapter('AccessToken').find('private-bearer-token'));
  assert.throws(() => repo.adapter('Client'));
  for (const seconds of [0, -1, NaN, 1.5, 604801]) await assert.rejects(adapter.upsert('unused', payload, seconds));
});

test('consent HTML escapes all untrusted labels and does not expose a school credential or write action', () => {
  const html = consentHtml({ action: '/oauth/interaction/test', csrf: 'synthetic-csrf', nonce: 'a'.repeat(43), displayName: '<script>attack()</script>', clientId: 'alms-codex' });
  assert.doesNotMatch(html, /<script>|type="password"|sToken|<input[^>]*name="userId"/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /name="csrf"/); assert.match(html, /name="nonce"/);
  assert.match(html, /ALMS 로그인 유효기간 안에서 자동 갱신/);
  assert.match(signInHtml('https://lms.flyjung.kr/#/login'), /noopener noreferrer/);
});
