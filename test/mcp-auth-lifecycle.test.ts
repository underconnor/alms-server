import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { Pool } from 'pg';
import type { JWKS } from 'oidc-provider';
import type { Session } from '../src/domain.js';
import { createMcpAuthorization } from '../src/mcp-auth/index.js';
import { McpAuthorizationRepository, digest } from '../src/mcp-auth/repository.js';
import { mcpNativeRedirectUris } from '../src/mcp-config.js';
import { hashToken } from '../src/store.js';

const apiOrigin = 'http://127.0.0.1:4300', resource = apiOrigin + '/mcp';
const clientId = 'alms-codex', callback = 'http://127.0.0.1:8123/callback';
const key = Buffer.alloc(32, 9);
const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
const signingJwks = { keys: [{ ...jwk, kid: 'synthetic-lifecycle-key', use: 'sig', alg: 'RS256' }] } as JWKS;
type Tokens = { access_token: string; refresh_token: string; expires_in: number };
type Code = { code: string; verifier: string };

/** Actual service, encrypted adapter, and provider; only SQL persistence is synthetic.
 * Not a PostgreSQL locking/transaction test and never opens a network socket. */
async function fixture() {
  const sessions = new Map<string, Session>();
  const objects = new Map<string, Record<string, any>>();
  const grants = new Map<string, Record<string, any>>();
  const challenges = new Map<string, Record<string, any>>();
  const objectKey = (model: string, hash: string) => model + ':' + hash;
  const issueParent = (owner = randomUUID(), ttl = 3600) => {
    const token = randomBytes(32).toString('base64url');
    const session: Session = { tokenHash: hashToken(token), csrfToken: randomBytes(24).toString('base64url'),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), clientId: 'alms-web', analyticsSessionId: randomUUID(),
      user: { id: owner, displayName: null, analyticsId: randomUUID(), analyticsEnabled: true } };
    sessions.set(session.tokenHash, session); return { token, session };
  };
  const own = issueParent();
  const query = async (sql: string, values: any[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('AS session_binding')) return { rows: [Object.fromEntries(['migration', 'authorizations', 'challenges', 'objects', 'session_binding', 'challenge_binding'].map(name => [name, true]))], rowCount: 1 };
    if (sql.startsWith('INSERT INTO mcp_oauth_objects')) {
      const previous = objects.get(objectKey(values[0], values[1]));
      objects.set(objectKey(values[0], values[1]), { model: values[0], id_hash: values[1], payload_enc: values[2], grant_hash: values[3], uid_hash: values[4],
        expires: Date.now() + values[5] * 1000, consumed_at: previous?.consumed_at ?? null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id_hash,payload_enc,consumed_at FROM mcp_oauth_objects')) {
      const column = sql.includes('AND uid_hash=') ? 'uid_hash' : 'id_hash';
      const row = [...objects.values()].find(item => item.model === values[0] && item[column] === values[1] && item.expires > Date.now());
      return { rows: row ? [row] : [], rowCount: Number(Boolean(row)) };
    }
    if (sql.startsWith('UPDATE mcp_oauth_objects SET consumed_at')) {
      const row = objects.get(objectKey(values[0], values[1]));
      if (!row || row.consumed_at || row.expires <= Date.now()) return { rows: [], rowCount: 0 };
      row.consumed_at = new Date().toISOString(); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM mcp_oauth_objects WHERE model=')) return { rows: [], rowCount: Number(objects.delete(objectKey(values[0], values[1]))) };
    if (sql.startsWith('INSERT INTO mcp_consent_challenges')) {
      const parent = sessions.get(values[3]);
      if (!parent || parent.user.id !== values[2] || parent.csrfToken !== values[4] || Date.parse(parent.expiresAt) <= Date.now()) return { rows: [], rowCount: 0 };
      const previous = challenges.get(values[0]);
      if (previous?.consumed) return { rows: [], rowCount: 0 };
      challenges.set(values[0], { nonce: values[1], owner: values[2], hash: values[3], consumed: false }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT expires_at FROM sessions')) {
      const parent = sessions.get(values[0]);
      return { rows: parent && parent.user.id === values[1] && parent.csrfToken === values[2] && Date.parse(parent.expiresAt) > Date.now() ? [{ expires_at: parent.expiresAt }] : [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE mcp_consent_challenges SET consumed_at')) {
      const row = challenges.get(values[0]);
      if (!row || row.consumed || row.nonce !== values[1] || row.owner !== values[2] || row.hash !== values[3]) return { rows: [], rowCount: 0 };
      row.consumed = true; return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO mcp_authorizations')) {
      assert.equal(grants.has(values[1]), false, 'Synthetic grant_hash unique constraint');
      grants.set(values[1], { id: values[0], user_id: values[2], approved_session_hash: values[3], client_id: values[4], resource: values[5], scopes: ['alms:read'], expires_at: values[6], revoked: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT a.* FROM mcp_authorizations')) {
      const row = grants.get(values[0]), parent = row && sessions.get(row.approved_session_hash);
      const valid = row && !row.revoked && Date.parse(row.expires_at) > Date.now() && parent && parent.user.id === row.user_id && Date.parse(parent.expiresAt) > Date.now();
      return { rows: valid ? [row] : [], rowCount: Number(Boolean(valid)) };
    }
    if (sql.startsWith('UPDATE mcp_authorizations SET revoked_at=')) {
      const row = grants.get(values[0]); if (row) row.revoked = true; return { rows: [], rowCount: Number(Boolean(row)) };
    }
    if (sql.startsWith('DELETE FROM mcp_oauth_objects WHERE grant_hash=')) {
      for (const [name, row] of objects) if (row.grant_hash === values[0]) objects.delete(name);
      return { rows: [], rowCount: 0 };
    }
    // Timer cleanup is not used to prepare fixtures or make a lifecycle test pass.
    throw new Error('Unhandled synthetic SQL prefix: ' + sql.slice(0, 80));
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const repo = new McpAuthorizationRepository(pool, key);
  const service = createMcpAuthorization({ apiOrigin, frontendOrigin: 'https://lms.flyjung.kr', issuer: apiOrigin + '/oauth', resource, pool,
    store: { getSession: async tokenHash => {
      const parent = sessions.get(tokenHash); return parent && Date.parse(parent.expiresAt) > Date.now() ? parent : null;
    } }, encryptionKey: key, signingJwks, cookieKeys: ['synthetic-lifecycle-cookie-key-'.repeat(3)], cookieName: 'alms_session_dev',
    client: { id: clientId, redirectUris: mcpNativeRedirectUris(resource) } });
  const app = Fastify(); await app.register(cookie); await app.register(formbody); await service.register(app);
  const jar = new Map([['alms_session_dev', own.token]]);
  const request = async (url: string, input: { body?: Record<string, string>; useCookies?: boolean; origin?: string | null } = {}) => {
    const target = new URL(url, apiOrigin); assert.equal(target.origin, apiOrigin, 'Never navigate a loopback callback or external origin');
    const useCookies = input.useCookies !== false;
    const response = await app.inject({ method: input.body ? 'POST' : 'GET', url: target.pathname + target.search,
      headers: { host: '127.0.0.1:4300', ...(useCookies ? { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') } : {}),
        ...(input.body ? { 'content-type': 'application/x-www-form-urlencoded', ...(input.origin === null ? {} : input.origin !== undefined ? { origin: input.origin } : useCookies ? { origin: apiOrigin } : {}) } : {}) },
      ...(input.body ? { payload: new URLSearchParams(input.body).toString() } : {}) });
    for (const value of [response.headers['set-cookie']].flat().filter(Boolean) as string[]) {
      const pair = value.split(';')[0]!, at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  const begin = async () => {
    const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await request('/oauth/auth?' + new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'alms:read',
      resource, code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic-state' }));
    assert.equal(started.statusCode, 303); const interaction = started.headers.location!;
    const page = await request(interaction); assert.equal(page.statusCode, 200);
    return { verifier, interaction, page };
  };
  const approveCode = async (): Promise<Code> => {
    const pending = await begin();
    const csrf = /name="csrf" value="([^"]+)"/.exec(pending.page.body)?.[1], nonce = /name="nonce" value="([^"]+)"/.exec(pending.page.body)?.[1]; assert.ok(csrf && nonce);
    const consent = await request(pending.interaction, { body: { csrf, nonce, decision: 'approve' } }); assert.equal(consent.statusCode, 200);
    const resume = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(consent.body)?.[1]; assert.ok(resume);
    const finished = await request(resume); assert.equal(finished.statusCode, 303);
    const code = new URL(finished.headers.location!).searchParams.get('code'); assert.ok(code);
    return { code, verifier: pending.verifier };
  };
  const exchange = async (code: Code) => request('/oauth/token', { useCookies: false, body: { grant_type: 'authorization_code', client_id: clientId,
    redirect_uri: callback, code: code.code, code_verifier: code.verifier, resource } });
  const tokensFor = async (code: Code): Promise<Tokens> => { const response = await exchange(code); assert.equal(response.statusCode, 200); return response.json(); };
  const approve = async () => tokensFor(await approveCode());
  const refresh = (tokens: Tokens) => request('/oauth/token', { useCookies: false, body: { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource } });
  const assertLive = async (tokens: Tokens, expectedOwner = own.session.user.id) => {
    const principal = await service.authenticate(tokens.access_token); assert.equal(principal.userId, expectedOwner); await principal.validate(); return principal;
  };
  const deleteParent = (tokenHash: string) => {
    sessions.delete(tokenHash);
    // Match the migration's ON DELETE CASCADE; opaque tokens deliberately remain.
    for (const [name, row] of grants) if (row.approved_session_hash === tokenHash) grants.delete(name);
    for (const [name, row] of challenges) if (row.hash === tokenHash) challenges.delete(name);
  };
  return { app, service, repo, own, grants, objects, issueParent, request, begin, approveCode, exchange, tokensFor, approve, refresh, assertLive, deleteParent,
    setBrowserParent: (token: string) => jar.set('alms_session_dev', token),
    removeOidcSessions: () => { for (const [name, row] of objects) if (row.model === 'Session') objects.delete(name); },
    close: async () => { await service.close(); await app.close(); } };
}

test('a second consent with no code exchange preserves the first access, principal and refresh', async () => {
  const f = await fixture();
  try {
    const first = await f.approve(), principal = await f.assertLive(first);
    await f.approveCode(); assert.equal(f.grants.size, 2);
    await f.assertLive(first); await principal.validate();
    const refreshed = await f.refresh(first); assert.equal(refreshed.statusCode, 200); await f.assertLive(refreshed.json());
  } finally { await f.close(); }
});

test('separately approved codes exchange in reverse order with distinct verifier and independent grants', async () => {
  const f = await fixture();
  try {
    const first = await f.approveCode(), second = await f.approveCode(); assert.notEqual(first.verifier, second.verifier);
    const secondTokens = await f.tokensFor(second), firstTokens = await f.tokensFor(first);
    await f.assertLive(firstTokens); await f.assertLive(secondTokens);
    const firstPayload = await f.repo.adapter('AccessToken').find(firstTokens.access_token), secondPayload = await f.repo.adapter('AccessToken').find(secondTokens.access_token);
    assert.ok(firstPayload && secondPayload); assert.notEqual(firstPayload.grantId, secondPayload.grantId);
    assert.equal(firstPayload.expiresWithSession, undefined); assert.equal(secondPayload.expiresWithSession, undefined);
    const oidcSession = await f.repo.adapter('Session').findByUid!(String(firstPayload.sessionUid));
    const clientAuthorizations = oidcSession?.authorizations as Record<string, { persistsLogout?: boolean }> | undefined;
    assert.equal(clientAuthorizations?.[clientId]?.persistsLogout, true);
    assert.ok(firstPayload.exp! > Math.floor(Date.now() / 1000));
  } finally { await f.close(); }
});

test('refresh rotation and replay revoke only the replayed grant family', async () => {
  const f = await fixture();
  try {
    const first = await f.approve(), second = await f.approve();
    const a = await f.refresh(first), b = await f.refresh(second); assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
    const rotatedA: Tokens = a.json(), rotatedB: Tokens = b.json();
    assert.notEqual(rotatedA.refresh_token, first.refresh_token); assert.notEqual(rotatedB.refresh_token, second.refresh_token);
    const replay = await f.refresh(first); assert.equal(replay.statusCode, 400); assert.equal(replay.json().error, 'invalid_grant');
    await assert.rejects(f.service.authenticate(first.access_token), { code: 'MCP_AUTH_REQUIRED' });
    await assert.rejects(f.service.authenticate(rotatedA.access_token), { code: 'MCP_AUTH_REQUIRED' });
    await f.assertLive(second); await f.assertLive(rotatedB);
    const nextB = await f.refresh(rotatedB); assert.equal(nextB.statusCode, 200); await f.assertLive(nextB.json());
    assert.equal([...f.grants.values()].filter(row => row.revoked).length, 1);
  } finally { await f.close(); }
});

test('explicit access or refresh revocation leaves the other connection and ALMS parent intact', async () => {
  for (const type of ['access_token', 'refresh_token'] as const) {
    const f = await fixture();
    try {
      const first = await f.approve(), second = await f.approve(), firstPrincipal = await f.assertLive(first);
      const revoked = await f.request('/oauth/token/revocation', { useCookies: false, body: { client_id: clientId, token: first[type], token_type_hint: type } });
      assert.equal(revoked.statusCode, 200);
      await assert.rejects(firstPrincipal.validate(), { code: 'MCP_AUTH_REQUIRED' });
      await assert.rejects(f.service.authenticate(first.access_token), { code: 'MCP_AUTH_REQUIRED' });
      assert.equal((await f.refresh(first)).statusCode, 400); await f.assertLive(second);
      assert.equal((await f.refresh(second)).statusCode, 200);
      assert.equal(f.own.session.expiresAt > new Date().toISOString(), true);
      assert.equal([...f.grants.values()].filter(row => row.revoked).length, 1);
    } finally { await f.close(); }
  }
});

test('OIDC session removal preserves native grants while exact ALMS parent deletion or expiry denies all access and refresh', async () => {
  for (const mode of ['delete', 'expire'] as const) {
    const f = await fixture();
    try {
      const first = await f.approve(), second = await f.approve(), principal = await f.assertLive(first);
      f.removeOidcSessions(); await f.assertLive(first); await f.assertLive(second);
      const refreshed = await f.refresh(first); assert.equal(refreshed.statusCode, 200); const rotated: Tokens = refreshed.json();
      await f.assertLive(rotated);
      if (mode === 'delete') f.deleteParent(f.own.session.tokenHash);
      else f.own.session.expiresAt = new Date(Date.now() - 1000).toISOString();
      await assert.rejects(principal.validate(), { code: 'MCP_AUTH_REQUIRED' });
      for (const tokens of [first, second, rotated]) await assert.rejects(f.service.authenticate(tokens.access_token), { code: 'MCP_AUTH_REQUIRED' });
      for (const tokens of [second, rotated]) { const denied = await f.refresh(tokens); assert.equal(denied.statusCode, 400); assert.equal(denied.json().error, 'invalid_grant'); }
    } finally { await f.close(); }
  }
});

test('a new parent for the same owner neither extends nor silently replaces a previous connection parent', async () => {
  const f = await fixture();
  try {
    const first = await f.approve(), firstPrincipal = await f.assertLive(first);
    const firstGrant = [...f.grants.values()][0]!, originalExpiry = firstGrant.expires_at;
    const another = f.issueParent(f.own.session.user.id, 7200); f.setBrowserParent(another.token);
    const second = await f.approve(), secondPrincipal = await f.assertLive(second);
    assert.notEqual(firstPrincipal.sessionTokenHash, secondPrincipal.sessionTokenHash);
    assert.equal(firstGrant.expires_at, originalExpiry);
    f.deleteParent(another.session.tokenHash);
    await assert.rejects(f.service.authenticate(second.access_token), { code: 'MCP_AUTH_REQUIRED' });
    await f.assertLive(first); assert.equal((await f.refresh(first)).statusCode, 200);
    f.deleteParent(f.own.session.tokenHash); await assert.rejects(firstPrincipal.validate(), { code: 'MCP_AUTH_REQUIRED' });
  } finally { await f.close(); }
});

test('code exchange and refresh clamp newly issued token expiry to a shortened current parent without extending its grant', async () => {
  const f = await fixture();
  try {
    const pending = await f.approveCode(), originalExpiry = [...f.grants.values()][0]!.expires_at;
    const shortExpiry = new Date(Date.now() + 40_000).toISOString(); f.own.session.expiresAt = shortExpiry;
    const tokens = await f.tokensFor(pending); assert.ok(tokens.expires_in > 0 && tokens.expires_in <= 40);
    for (const [model, token] of [['AccessToken', tokens.access_token], ['RefreshToken', tokens.refresh_token]] as const) {
      const payload = await f.repo.adapter(model).find(token); assert.ok(payload); assert.ok(payload.exp! <= Math.floor(Date.parse(shortExpiry) / 1000));
    }
    const refreshed = await f.refresh(tokens); assert.equal(refreshed.statusCode, 200);
    const rotated: Tokens = refreshed.json(); assert.ok(rotated.expires_in > 0 && rotated.expires_in <= 40);
    const refreshedPayload = await f.repo.adapter('RefreshToken').find(rotated.refresh_token); assert.ok(refreshedPayload);
    assert.ok(refreshedPayload.exp! <= Math.floor(Date.parse(shortExpiry) / 1000));
    assert.equal([...f.grants.values()][0]!.expires_at, originalExpiry);
  } finally { await f.close(); }
});

test('changed authorization owner, client, resource or scope cannot authenticate or refresh a native grant', async () => {
  const f = await fixture();
  try {
    const tokens = await f.approve(), row = [...f.grants.values()][0]!;
    for (const [field, value] of [['user_id', randomUUID()], ['client_id', 'another-client'], ['resource', 'https://evil.example/mcp'], ['scopes', ['alms:read', 'offline_access']]] as const) {
      const previous = row[field]; row[field] = value;
      await assert.rejects(f.service.authenticate(tokens.access_token), { code: 'MCP_AUTH_REQUIRED' });
      const denied = await f.refresh(tokens); assert.equal(denied.statusCode, 400); assert.equal(denied.json().error, 'invalid_grant');
      row[field] = previous; await f.assertLive(tokens);
    }
    const payload = await f.repo.adapter('AccessToken').find(tokens.access_token); assert.ok(payload?.grantId);
    assert.equal(f.grants.get(digest(payload.grantId))?.approved_session_hash, f.own.session.tokenHash);
  } finally { await f.close(); }
});

test('an existing OIDC identity cannot approve a different browser owner after grants become independent', async () => {
  const f = await fixture();
  try {
    const first = await f.approve(), another = f.issueParent(); f.setBrowserParent(another.token);
    const pending = await f.begin(); assert.match(pending.page.body, /ALMS 계정이 변경되었어요/); assert.doesNotMatch(pending.page.body, /name="nonce"/);
    const forged = await f.request(pending.interaction, { body: { csrf: another.session.csrfToken, nonce: 'a'.repeat(43), decision: 'approve' } });
    assert.equal(forged.statusCode, 403); assert.equal(f.grants.size, 1);
    await f.assertLive(first); assert.equal((await f.refresh(first)).statusCode, 200);
  } finally { await f.close(); }
});
