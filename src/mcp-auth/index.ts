import Provider, { errors, interactionPolicy, type Configuration, type JWKS, type KoaContextWithOIDC } from 'oidc-provider';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.js';
import { hashToken } from '../store.js';
import type { Session } from '../domain.js';
import type { McpPrincipal } from '../mcp-types.js';
import { AppError } from '../errors.js';
import { mcpNativeRedirectUris } from '../mcp-config.js';
import { McpAuthorizationRepository, mcpDenied, type Authorization } from './repository.js';
import { accountChangedHtml, consentHtml, signInHtml } from './html.js';

export interface McpAuthorizationOptions {
  apiOrigin: string; frontendOrigin: string; issuer: string; resource: string; store: Pick<Store, 'getSession'>; pool: Pool;
  encryptionKey: Buffer; signingJwks: JWKS; cookieKeys: readonly string[]; cookieName: string;
  client: { id: string; redirectUris: readonly string[] };
}
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const consentInput = z.object({ csrf: z.string().min(1).max(256), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), decision: z.enum(['approve', 'deny']) }).strict();
const remaining = (expiry: string, maximum: number) => {
  const seconds = Math.floor((Date.parse(expiry) - Date.now()) / 1000);
  if (seconds <= 0) throw new errors.InvalidGrant('authorization expired');
  return Math.min(maximum, seconds);
};
/** oidc-provider passes (context, authenticated client, token) in this order. */
export function mcpRevocationAllowed(_ctx: unknown, client: { clientId: string }, token: { clientId?: string }): boolean {
  return client.clientId === 'alms-codex' && token.clientId === client.clientId;
}

export function createMcpAuthorization(options: McpAuthorizationOptions) {
  const origin = new URL(options.apiOrigin);
  const frontend = new URL(options.frontendOrigin);
  if (origin.origin !== options.apiOrigin || options.issuer !== options.apiOrigin + '/oauth' || options.resource !== options.apiOrigin + '/mcp'
    || !options.cookieKeys.length || options.cookieKeys.some(key => key.length < 32) || options.encryptionKey.length !== 32 || !options.signingJwks.keys.length)
    throw new Error('Invalid MCP authorization configuration');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Invalid MCP origin');
  if (frontend.origin !== options.frontendOrigin || frontend.protocol !== 'https:' && !(frontend.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(frontend.hostname))) throw new Error('Invalid MCP frontend origin');
  if (options.client.id !== 'alms-codex' || options.client.redirectUris.length === 0) throw new Error('Invalid MCP client');
  const nativeRedirects = new Set(mcpNativeRedirectUris(options.resource));
  for (const value of options.client.redirectUris) {
    const url = new URL(value);
    if (url.href !== value) throw new Error('Invalid native MCP redirect');
    url.port = ''; // oidc-provider applies native loopback's variable-port rule.
    if (!nativeRedirects.has(url.href))
      throw new Error('Invalid native MCP redirect');
  }
  const repo = new McpAuthorizationRepository(options.pool, options.encryptionKey);
  const authority = new WeakMap<object, Authorization>();
  const verifiedBrowserSession = async (token: string | undefined) => {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const value = await options.store.getSession(hashToken(token));
    return value && (value.clientId ?? 'alms-web') === 'alms-web' && Date.parse(value.expiresAt) > Date.now() ? value : null;
  };
  const assertAuthorization = async (grantId: string, accountId?: string) => {
    const grant = await repo.find(grantId);
    if (!grant || grant.clientId !== options.client.id || grant.resource !== options.resource || grant.scopes.length !== 1 || grant.scopes[0] !== 'alms:read'
      || accountId !== undefined && grant.userId !== accountId) throw mcpDenied();
    const session = await options.store.getSession(grant.sessionTokenHash);
    if (!session || session.user.id !== grant.userId || (session.clientId ?? 'alms-web') !== 'alms-web' || Date.parse(session.expiresAt) <= Date.now()) throw mcpDenied();
    return grant;
  };
  const ttl = (ctx: KoaContextWithOIDC, maximum: number) => {
    const value = authority.get(ctx); if (!value) throw new errors.InvalidGrant('authorization unavailable');
    return remaining(value.expiresAt, maximum);
  };
  const policy = interactionPolicy.base();
  // An old OIDC cookie cannot stand in for the current verified ALMS owner.
  policy.get('login')!.checks.add(new interactionPolicy.Check('alms_session', 'A current ALMS login is required', ctx => !ctx.oidc.account), 0);
  const configuration: Configuration = {
    adapter: name => repo.adapter(name), jwks: options.signingJwks,
    clients: [{ client_id: options.client.id, client_name: 'ALMS Codex', application_type: 'native',
      redirect_uris: [...options.client.redirectUris], response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }],
    features: { devInteractions: { enabled: false }, registration: { enabled: false }, userinfo: { enabled: false }, rpInitiatedLogout: { enabled: false }, dPoP: { enabled: false },
      revocation: { enabled: true, allowedPolicy: mcpRevocationAllowed },
      resourceIndicators: { enabled: true, getResourceServerInfo: async (_ctx, resource, client) => {
        if (resource !== options.resource || client.clientId !== options.client.id) throw new errors.InvalidTarget();
        return { scope: 'alms:read', audience: options.resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
      } } },
    responseTypes: ['code'], scopes: ['alms:read'], pkce: { required: () => true },
    clientBasedCORS: () => false,
    // This refresh permission is part of the explicit ALMS read consent. It is
    // bounded by that ALMS session, never an offline authorization.
    issueRefreshToken: async (ctx, client, source) => {
      if (client.clientId !== options.client.id || !client.grantTypeAllowed('refresh_token') || !source.scopes.has('alms:read') || source.scopes.has('offline_access') || !source.grantId) return false;
      const grant = await assertAuthorization(source.grantId, source.accountId); authority.set(ctx, grant); return true;
    },
    rotateRefreshToken: true,
    cookies: { keys: [...options.cookieKeys], names: { session: '_alms_mcp_session', interaction: '_alms_mcp_interaction', resume: '_alms_mcp_resume' },
      long: { httpOnly: true, sameSite: 'lax', secure: origin.protocol === 'https:' }, short: { httpOnly: true, sameSite: 'lax', secure: origin.protocol === 'https:' } },
    interactions: { policy, url: (_ctx, interaction) => options.apiOrigin + '/oauth/interaction/' + encodeURIComponent(interaction.uid) },
    ttl: { AccessToken: ctx => ttl(ctx, 300), AuthorizationCode: ctx => ttl(ctx, 60), RefreshToken: ctx => ttl(ctx, 86400), Grant: 86400, Session: 86400, Interaction: 900 },
    findAccount: async (ctx, accountId, source) => {
      const grantId = source?.grantId ?? ctx.oidc.result?.consent?.grantId;
      if (!grantId) {
        const session = await verifiedBrowserSession(ctx.cookies.get(options.cookieName, { signed: false }));
        return session?.user.id === accountId ? { accountId, claims: async () => ({ sub: accountId }) } : undefined;
      }
      try {
        const grant = await assertAuthorization(grantId, accountId); authority.set(ctx, grant);
        return { accountId: grant.userId, claims: async () => ({ sub: grant.userId }) };
      } catch { return undefined; }
    },
    loadExistingGrant: async ctx => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      if (!grantId) return undefined;
      try { const value = await assertAuthorization(grantId); authority.set(ctx, value); return provider.Grant.find(grantId); } catch { return undefined; }
    },
    renderError: async ctx => { ctx.type = 'html'; ctx.body = '<!doctype html><html lang="ko"><meta charset="utf-8"><title>ALMS 연결 오류</title><p>연결 요청이 만료됐거나 허용되지 않습니다. Codex에서 연결을 다시 시작해 주세요.</p></html>'; },
  };
  const provider = new Provider(options.issuer, configuration);
  // Only this private mount supplies canonical proxy data derived from the configured public origin.
  provider.proxy = true;
  provider.use(async (ctx, next) => {
    try {
      if (ctx.path === '/auth') {
        const query = new URLSearchParams(ctx.querystring), scopes = (query.get('scope') ?? '').split(' ').filter(Boolean);
        if (query.getAll('resource').length !== 1 || query.get('resource') !== options.resource) throw new errors.InvalidTarget();
        if (query.get('code_challenge_method') !== 'S256') throw new errors.InvalidRequest('PKCE S256 is required');
        if (query.get('client_id') !== options.client.id || scopes.length !== 1 || scopes[0] !== 'alms:read') throw new errors.InvalidScope('Unsupported read scope', query.get('scope') ?? '');
      }
      await next();
      // This mount exposes OAuth authorization-server metadata for an MCP
      // resource, so advertise the scope accepted by its authorization route.
      if (ctx.path === '/.well-known/openid-configuration' && ctx.status === 200) {
        (ctx.body as Record<string, unknown>).scopes_supported = ['alms:read'];
      }
    } catch (error) {
      if (!(error instanceof errors.OIDCProviderError)) throw error;
      ctx.status = error.statusCode; ctx.type = 'application/json'; ctx.body = { error: error.error };
    }
  });
  const callback = provider.callback();
  const browserSession = (request: FastifyRequest) => verifiedBrowserSession(request.cookies[options.cookieName]);
  const privateHtml = (reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const interaction = async (request: FastifyRequest, reply: FastifyReply) => {
    const detail = await provider.interactionDetails(request.raw, reply.raw);
    const uid = (request.params as { uid: string }).uid;
    if (detail.uid !== uid || !['login', 'consent'].includes(detail.prompt.name) || detail.params.client_id !== options.client.id
      || detail.params.resource !== options.resource || typeof detail.params.scope !== 'string'
      || detail.params.scope !== 'alms:read') throw mcpDenied();
    return detail;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    async authenticate(bearer: string, signal?: AbortSignal): Promise<McpPrincipal> {
      signal?.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(bearer)) throw mcpDenied();
      const token = await provider.AccessToken.find(bearer);
      if (!token || token.kind !== 'AccessToken' || token.aud !== options.resource || token.clientId !== options.client.id || !token.grantId || token.tokenType !== 'Bearer' || token.isExpired) throw mcpDenied();
      if (token.scope !== 'alms:read') throw new AppError(403, 'MCP_SCOPE_INSUFFICIENT', '조회 권한을 확인해 주세요.');
      const value = await assertAuthorization(token.grantId, token.accountId); signal?.throwIfAborted();
      return Object.freeze({ userId: value.userId, authorizationId: value.id, sessionTokenHash: value.sessionTokenHash, scopes: Object.freeze([...value.scopes]),
        validate: async (signal?: AbortSignal) => { signal?.throwIfAborted(); const current = await provider.AccessToken.find(bearer); if (!current || current.isExpired || current.grantId !== token.grantId) throw mcpDenied(); await assertAuthorization(token.grantId, value.userId); signal?.throwIfAborted(); } });
    },
    async register(app: FastifyInstance) {
      await repo.health();
      app.get('/oauth/interaction/:uid', async (request, reply) => {
        if (request.headers.host !== origin.host) throw new AppError(400, 'INVALID_REQUEST', '잘못된 서비스 주소입니다.');
        const detail = await interaction(request, reply), session = await browserSession(request);
        if (!session) return privateHtml(reply).send(signInHtml(options.frontendOrigin + '/#/login'));
        if (detail.session?.accountId && detail.session.accountId !== session.user.id) return privateHtml(reply).send(accountChangedHtml());
        const nonce = await repo.challenge(detail.uid, session);
        // Native form POST needs a non-null Origin; cross-origin referrers stay suppressed.
        return privateHtml(reply).header('referrer-policy', 'same-origin').send(consentHtml({ action: '/oauth/interaction/' + detail.uid, csrf: session.csrfToken, nonce, displayName: session.user.displayName, clientId: options.client.id }));
      });
      app.post('/oauth/interaction/:uid', async (request, reply) => {
        if (request.headers.host !== origin.host) throw new AppError(400, 'INVALID_REQUEST', '잘못된 서비스 주소입니다.');
        if (request.headers.origin !== options.apiOrigin) throw new AppError(403, 'CSRF_INVALID', '승인 요청을 확인할 수 없습니다.');
        const detail = await interaction(request, reply), session = await browserSession(request), input = consentInput.parse(request.body);
        if (!session || !equal(input.csrf, session.csrfToken)) throw new AppError(403, 'CSRF_INVALID', '승인 요청을 확인할 수 없습니다.');
        if (detail.session?.accountId && detail.session.accountId !== session.user.id) throw new AppError(403, 'MCP_AUTH_ACCOUNT_CHANGED', 'ALMS 계정이 변경되어 승인을 중단했습니다.');
        if (input.decision === 'deny') {
          await repo.deny(detail.uid, input.nonce, session);
          reply.hijack(); await provider.interactionFinished(request.raw, reply.raw, { error: 'access_denied' }, { mergeWithLastSubmission: false }); return;
        }
        const grant = new provider.Grant({ accountId: session.user.id, clientId: options.client.id });
        grant.exp = Math.floor(Date.parse(session.expiresAt) / 1000);
        grant.addResourceScope(options.resource, 'alms:read'); grant.addOIDCScope('alms:read');
        const grantId = await grant.save();
        try { await repo.authorize(detail.uid, input.nonce, session, grantId, options.client.id, options.resource); }
        catch (error) { await grant.destroy(); throw error; }
        reply.hijack();
        await provider.interactionFinished(request.raw, reply.raw, { login: { accountId: session.user.id }, consent: { grantId } }, { mergeWithLastSubmission: false });
      });
      const route = async (request: FastifyRequest, reply: FastifyReply, discovery = false) => {
        const requestedHost = request.headers.host;
        if (requestedHost !== origin.host) throw new AppError(400, 'INVALID_REQUEST', '잘못된 서비스 주소입니다.');
        const originalUrl = request.raw.url, originalHeaders = { proto: request.headers['x-forwarded-proto'], host: request.headers['x-forwarded-host'] };
        Object.assign(request.raw, { originalUrl: discovery ? '/oauth/.well-known/openid-configuration' : originalUrl });
        request.raw.url = discovery ? '/.well-known/openid-configuration' : originalUrl!.slice('/oauth'.length) || '/';
        request.headers['x-forwarded-proto'] = origin.protocol.slice(0, -1); request.headers['x-forwarded-host'] = origin.host;
        reply.hijack();
        try { await callback(request.raw, reply.raw); }
        finally { request.raw.url = originalUrl; request.headers['x-forwarded-proto'] = originalHeaders.proto; request.headers['x-forwarded-host'] = originalHeaders.host; }
      };
      app.all('/oauth/*', { onRequest: async (request, reply) => route(request, reply) }, async () => undefined);
      app.get('/.well-known/oauth-authorization-server/oauth', { onRequest: async (request, reply) => route(request, reply, true) }, async () => undefined);
      timer = setInterval(() => { void repo.cleanup().catch(() => {}); }, 60_000).unref();
    },
    async close() { if (timer) clearInterval(timer); },
  };
}
