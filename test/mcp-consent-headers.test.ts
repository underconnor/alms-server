import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JWKS } from 'oidc-provider';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Session } from '../src/domain.js';
import { hashToken, type Store } from '../src/store.js';
import { createMcpAuthorization } from '../src/mcp-auth/index.js';
import { mcpNativeRedirectUris } from '../src/mcp-config.js';

test('the full app preserves same-origin only for verified MCP consent HTML, and never accepts null or missing Origins', async () => {
  const apiOrigin = 'http://127.0.0.1:4300', token = randomBytes(32).toString('base64url');
  const session: Session = { tokenHash: hashToken(token), csrfToken: 'synthetic-csrf', clientId: 'alms-web',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { id: randomUUID(), displayName: '합성 사용자', analyticsId: randomUUID(), analyticsEnabled: false } };
  let sessionAvailable = true;
  const store = { getSession: async (hash: string) => sessionAvailable && hash === session.tokenHash ? session : null } as unknown as Store;
  // Preserve the real provider's encrypted interaction payload in memory. This
  // fixture covers app hooks and HTTP headers, not database or consent commits.
  const rows = new Map<string, { id_hash: string; uid_hash: string | null; payload_enc: string }>();
  let consentChallenges = 0;
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('AS session_binding')) return { rows: [{ migration: true, authorizations: true, challenges: true, objects: true, session_binding: true, challenge_binding: true }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO mcp_oauth_objects')) {
      rows.set(values[0] + ':' + values[1], { id_hash: String(values[1]), uid_hash: values[4] as string | null, payload_enc: String(values[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id_hash,payload_enc,consumed_at')) {
      const row = sql.includes('uid_hash=$2') ? [...rows].find(([key, row]) => key.startsWith(values[0] + ':') && row.uid_hash === values[1])?.[1]
        : rows.get(values[0] + ':' + values[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO mcp_consent_challenges')) { consentChallenges++; return { rows: [], rowCount: 1 }; }
    throw new Error('Unexpected synthetic query');
  } } as unknown as Pool;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const service = createMcpAuthorization({ apiOrigin, frontendOrigin: 'https://lms.flyjung.kr', issuer: apiOrigin + '/oauth', resource: apiOrigin + '/mcp',
    store, pool, encryptionKey: Buffer.alloc(32, 9), signingJwks: { keys: [{ ...key, kid: 'synthetic-header-key', use: 'sig', alg: 'RS256' }] } as JWKS,
    cookieKeys: ['synthetic-header-cookie-key-'.repeat(3)], cookieName: 'alms_session_dev',
    client: { id: 'alms-codex', redirectUris: mcpNativeRedirectUris(apiOrigin + '/mcp') } });
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgres://unused', COOKIE_SECURE: 'false', API_PUBLIC_ORIGIN: apiOrigin, LOG_LEVEL: 'silent' }), store);
  await service.register(app);
  app.get('/synthetic-unrelated-html', async (_request, reply) => reply.type('text/html').header('referrer-policy', 'same-origin').send('<p>fixture</p>'));
  const jar = new Map<string, string>([['alms_session_dev', token]]);
  const headers = () => ({ host: '127.0.0.1:4300', cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') });
  const saveCookies = (cookies: string | string[] | undefined) => {
    for (const item of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
      const pair = item.split(';')[0]!, at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  try {
    const params = new URLSearchParams({ client_id: 'alms-codex', redirect_uri: 'http://127.0.0.1:49152/callback/xMAw8DYbtWUt',
      response_type: 'code', scope: 'alms:read', resource: apiOrigin + '/mcp', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'synthetic-state' });
    const started = await app.inject({ url: '/oauth/auth?' + params, headers: headers() });
    assert.equal(started.statusCode, 303); saveCookies(started.headers['set-cookie']);
    const interaction = new URL(started.headers.location!);
    const page = await app.inject({ url: interaction.pathname, headers: headers() });
    assert.equal(page.statusCode, 200); assert.match(page.body, /name="nonce"/); assert.equal(consentChallenges, 1);
    assert.equal(page.headers['referrer-policy'], 'same-origin'); assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff'); assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(String(page.headers['content-security-policy']), /form-action 'self'; frame-ancestors 'none'/);
    for (const origin of [undefined, 'null', 'https://evil.example']) {
      const denied = await app.inject({ method: 'POST', url: interaction.pathname, headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
        payload: new URLSearchParams({ csrf: session.csrfToken, nonce: 'a'.repeat(43), decision: 'approve' }).toString() });
      assert.equal(denied.statusCode, 403); assert.equal(denied.json().error.code, 'CSRF_INVALID'); assert.equal(denied.headers['referrer-policy'], 'no-referrer');
    }
    sessionAvailable = false;
    const login = await app.inject({ url: interaction.pathname, headers: headers() });
    assert.equal(login.statusCode, 200); assert.match(login.body, /ALMS 로그인이 필요해요/); assert.equal(login.headers['referrer-policy'], 'no-referrer');
    assert.equal(consentChallenges, 1);
    for (const url of ['/healthz', '/v1/me', '/v1/auth/start', '/not-found', '/synthetic-unrelated-html']) {
      const response = await app.inject({ url, headers: headers() });
      assert.equal(response.headers['referrer-policy'], 'no-referrer', url);
    }
  } finally { await service.close(); await app.close(); }
});
