import { createHash, randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { SchoolProvider } from './provider.js';
import { hashToken,type Store } from './store.js';
import { encryptSchoolSession } from './crypto.js';
import { AppError,unavailable } from './errors.js';
import { authFailureDiagnostic, rememberAuthFailure, authCallbackContext, authFetchDestination,
  type AuthCallbackContext, type AuthFailureStage } from './auth-diagnostics.js';
import { IssuedAttemptDiagnostics } from './auth-attempt-diagnostics.js';
import { loginAttemptTtlSeconds } from './auth-policy.js';
import { defaultFrontendClientId, frontendClientId, frontendReturn, getFrontendClient, loginContext,
  pkceVerifier, validateStoredLoginContext, type LoginClientContext } from './frontend-clients.js';
import { sealFrontendToken, unsealFrontendToken } from './frontend-token-seal.js';
import { CookieCallbackFlights } from './auth-inflight.js';

const token = z.string().min(1).max(8192);
const student = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const callbackPart = z.object({ state: state.optional(),sToken: token.optional(),sIdno: student.optional() }).strict();
const callbackFull = z.object({ state,sToken: token,sIdno: student }).strict();
const callbackParams = z.object({ state: state.optional() }).strict();
type CallbackTokenShape = { tokenParsedSpace: boolean; tokenQueryLiteralPlus: boolean;
  tokenQueryEncodedPlus: boolean; tokenInQuery: boolean };

/** Only fixed syntax flags leave this function; never retain the URL or token. */
function callbackTokenShape(request: FastifyRequest, parsedToken: string, tokenInQuery: boolean): CallbackTokenShape {
  let tokenQueryLiteralPlus = false, tokenQueryEncodedPlus = false;
  if (tokenInQuery) {
    const question = request.url.indexOf('?');
    for (const field of question < 0 ? [] : request.url.slice(question + 1).split('&')) {
      const equals = field.indexOf('=');
      if (equals < 0) continue;
      let name: string;
      try { name = decodeURIComponent(field.slice(0, equals).replace(/\+/g, ' ')); }
      catch { continue; }
      if (name !== 'sToken') continue;
      const value = field.slice(equals + 1);
      tokenQueryLiteralPlus ||= value.includes('+');
      tokenQueryEncodedPlus ||= /%2b/i.test(value);
    }
  }
  return { tokenParsedSpace: parsedToken.includes(' '), tokenQueryLiteralPlus, tokenQueryEncodedPlus, tokenInQuery };
}

function prefersHtml(accept = ''): boolean {
  let html = 0; let json = 0;
  for (const range of accept.toLowerCase().split(',')) {
    const [type,...parameters] = range.trim().split(';');
    const q = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue;
    if (type?.trim() === 'text/html') html = Math.max(html,quality);
    if (type?.trim() === 'application/json') json = Math.max(json,quality);
  }
  return html > 0 && html >= json;
}

function callbackFailureReason(error: unknown): 'login_expired' | 'school_auth_failed' | 'school_upstream_unavailable' {
  if (error instanceof AppError && error.statusCode === 401 && error.code === 'INVALID_CALLBACK') return 'login_expired';
  if (error instanceof ZodError) return error.issues.some(issue => issue.path[0] === 'state') ? 'login_expired' : 'school_auth_failed';
  const status = (error as { statusCode?: number })?.statusCode;
  return status && status >= 400 && status < 500 && status !== 429 ? 'school_auth_failed' : 'school_upstream_unavailable';
}
export const loginCookieName = (config: Config,clientId = defaultFrontendClientId) =>
  (config.cookieSecure ? '__Host-alms_login' : 'alms_login_dev') + (clientId === defaultFrontendClientId ? '' : '_' + clientId);
export const sessionCookieName = (config: Config,clientId = defaultFrontendClientId) =>
  config.cookieName + (clientId === defaultFrontendClientId ? '' : '_' + clientId);
export function setSessionCookie(reply: FastifyReply,config: Config,value: string,expiresAt: string,clientId = defaultFrontendClientId) {
  reply.setCookie(sessionCookieName(config,clientId),value,{ httpOnly: true,secure: config.cookieSecure,sameSite: 'lax',path: '/',expires: new Date(expiresAt) });
}

export async function registerAuth(app: FastifyInstance,config: Config,store: Store,provider: SchoolProvider) {
  const clientContexts = new WeakMap<FastifyRequest, LoginClientContext>();
  const defaultContext = (): LoginClientContext => ({ clientId: defaultFrontendClientId,
    redirectUri: getFrontendClient(config.frontendClients).defaultRedirectUri });
  const resolveCallbackClient = async (request: FastifyRequest) => {
    if (clientContexts.has(request)) return clientContexts.get(request)!;
    const value = (request.params as { state?: unknown } | undefined)?.state
      ?? (request.query as { state?: unknown } | undefined)?.state
      ?? (request.body as { state?: unknown } | undefined)?.state;
    if (state.safeParse(value).success && store.getLoginClientContext) {
      const context = await store.getLoginClientContext(hashToken(value as string));
      if (context) { validateStoredLoginContext(config.frontendClients, context); clientContexts.set(request, context); return context; }
    }
    return defaultContext();
  };
  const callbackStages = new WeakMap<FastifyRequest, AuthFailureStage>();
  const callbackContexts = new WeakMap<FastifyRequest, AuthCallbackContext>();
  const callbackTokenShapes = new WeakMap<FastifyRequest, CallbackTokenShape>();
  const bindingFailures = new WeakMap<FastifyRequest, 'missing_cookie' | 'invalid_cookie' | 'attempt_rejected'>();
  const callbackStateHashes = new WeakMap<FastifyRequest, string>();
  const issuedAttemptDiagnostics = new IssuedAttemptDiagnostics();
  const cookieCallbacks = new CookieCallbackFlights<{ token: string; expiresAt: string; context: AuthCallbackContext }>();
  app.addHook('onClose', async () => { cookieCallbacks.close(); });
  const bindingOptions = { httpOnly: true,secure: config.cookieSecure,sameSite: (config.cookieSecure ? 'none' : 'lax') as 'none' | 'lax',path: '/' };
  const redirectFailure = (error: unknown,reply: FastifyReply,context = defaultContext()) => {
    const destination = new URL(context.redirectUri);
    if (!destination.hash) destination.hash = '/login';
    const values = { reason: callbackFailureReason(error), ...(context.clientId !== defaultFrontendClientId ? { clientId: context.clientId } : {}),
      ...(context.clientState ? { clientState: context.clientState } : {}) };
    return reply.code(303).redirect(frontendReturn({ ...context, redirectUri: destination.toString() }, values));
  };
  const beginLogin = async (request: FastifyRequest,reply: FastifyReply) => {
    const context = loginContext(config.frontendClients, request.query);
    const origin = request.headers.origin;
    if (origin && !getFrontendClient(config.frontendClients,context.clientId).origins.includes(origin))
      throw new AppError(403,'CLIENT_ORIGIN_INVALID','로그인을 시작한 프론트를 확인할 수 없습니다.');
    clientContexts.set(request, context);
    if (!provider.auth || !config.sessionEncryptionKey) throw unavailable('SCHOOL_AUTH_UNAVAILABLE');
    const value = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    // SmartID appends '?sToken=...' literally, so the return URL must have no query string.
    const callback = new URL('/v1/auth/callback/'+value,config.apiOrigin);
    const url = await provider.auth.createLoginUrl(callback.toString());
    const destination = new URL(url);
    if (destination.protocol!=='https:' || destination.hostname!=='smartid.ssu.ac.kr' || destination.username || destination.password || destination.hash || (destination.port && destination.port!=='443')) throw unavailable('SCHOOL_AUTH_UNAVAILABLE');
    await store.createLoginAttempt(hashToken(value),hashToken(binding),context);
    reply.setCookie(loginCookieName(config,context.clientId),binding,{ ...bindingOptions,maxAge: loginAttemptTtlSeconds });
    return url;
  };
  app.get('/v1/auth/login',async (request,reply) => ({ url: await beginLogin(request,reply) }));
  app.get('/v1/auth/start',{ errorHandler: (error,request,reply) => {
    if (!clientContexts.has(request) && Object.keys(request.query as object).length) throw error;
    return redirectFailure(error,reply,clientContexts.get(request));
  } },async (request,reply) => {
    const url = await beginLogin(request,reply);
    return reply.code(303).redirect(url);
  });

  for (const url of ['/v1/auth/callback/:state','/v1/auth/callback']) app.route({ method: ['GET','POST'],url,errorHandler: async (error,request,reply) => {
    request.log.warn({ event: 'auth_callback_failed', ...callbackContexts.get(request),
      ...authFailureDiagnostic(error, callbackStages.get(request) ?? 'callback_validation'),
      fetchDestination: authFetchDestination(request.headers['sec-fetch-dest']),
      ...callbackTokenShapes.get(request),
      ...(bindingFailures.has(request) ? { bindingFailure: bindingFailures.get(request),
        sameAttemptPreviouslyIssuedSession: issuedAttemptDiagnostics.sameAttemptPreviouslyIssuedSession(callbackStateHashes.get(request)!) } : {}) }, 'auth callback failed');
    // Delegate API errors to the common JSON handler; only browser navigation returns to Front.
    if (!prefersHtml(request.headers.accept)) throw error;
    // Only a stored, currently registered destination can receive a failed callback.
    let context: LoginClientContext;
    try { context = await resolveCallbackClient(request); } catch { context = defaultContext(); }
    return redirectFailure(error,reply,context);
  },handler: async (request,reply) => {
    const context = await resolveCallbackClient(request);
    const client = validateStoredLoginContext(config.frontendClients, context);
    callbackStages.set(request, 'callback_validation');
    if (!provider.auth || !config.sessionEncryptionKey) throw unavailable('SCHOOL_AUTH_UNAVAILABLE');
    const params = callbackParams.parse(request.params);
    const query = callbackPart.parse(request.query);
    const body = request.method==='POST' ? callbackPart.parse(request.body ?? {}) : {};
    if (params.state && ('state' in query || 'state' in body)) throw new AppError(400,'INVALID_CALLBACK','인증 응답을 확인할 수 없습니다.');
    for (const key of Object.keys(query)) if (key in body) throw new AppError(400,'INVALID_CALLBACK','인증 응답을 확인할 수 없습니다.');
    const input = callbackFull.parse({ ...params,...query,...body });
    const stateHash = hashToken(input.state);
    callbackStateHashes.set(request, stateHash);
    callbackTokenShapes.set(request, callbackTokenShape(request, input.sToken, 'sToken' in query));
    callbackStages.set(request, 'callback_binding');
    const binding = request.cookies[loginCookieName(config,context.clientId)];
    if (!binding) bindingFailures.set(request, 'missing_cookie');
    else if (!state.safeParse(binding).success) bindingFailures.set(request, 'invalid_cookie');
    if (bindingFailures.has(request)) throw new AppError(401,'INVALID_CALLBACK','로그인을 다시 시작해 주세요.');
    const verifyAndIssue = async () => {
      try {
        if (!await store.consumeLoginAttempt(stateHash,hashToken(binding!))) {
          bindingFailures.set(request, 'attempt_rejected');
          throw new AppError(401,'INVALID_CALLBACK','로그인을 다시 시작해 주세요.');
        }
        // SQL remains single-use. A delayed result must not clear a newer start's binding.
        let identity;
        callbackStages.set(request, 'provider_verification');
        try { identity = await provider.auth!.verifyCallback({ sToken: input.sToken,sIdno: input.sIdno }); }
        catch (error) {
          const denied = error instanceof AppError && error.statusCode === 401 && error.code === 'SCHOOL_AUTH_FAILED';
          const normalized = denied
            ? new AppError(401,'SCHOOL_AUTH_FAILED','학교 인증을 확인하지 못했습니다. 다시 로그인해 주세요.')
            : new AppError(502,'SCHOOL_UPSTREAM_UNAVAILABLE','학교 로그인 확인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
          rememberAuthFailure(normalized, authFailureDiagnostic(error, 'provider_verification'));
          throw normalized;
        }
        const evidence = authCallbackContext(identity);
        callbackContexts.set(request, evidence);
        callbackStages.set(request, 'identity_binding');
        if (!identity.subject || identity.subject!==input.sIdno) throw new AppError(401,'SCHOOL_AUTH_FAILED','학교 인증 정보를 확인하지 못했습니다.');
        callbackStages.set(request, 'session_issue');
        const result = await store.issueVerifiedSession({ provider: provider.auth!.providerId,subject: identity.subject,displayName: identity.displayName },config.sessionTtlSeconds,{
          provider: provider.auth!.providerId,
          seal: userId => encryptSchoolSession(identity.schoolSession,config.sessionEncryptionKey!,userId,provider.auth!.providerId),
        },client.id);
        issuedAttemptDiagnostics.rememberSessionIssued(stateHash);
        // No school jar, user record or CSRF value is retained by the rendezvous.
        return { token: result.token, expiresAt: result.expiresAt, context: evidence };
      } catch (error) {
        // Joined failures keep the original fixed stage/context; no raw error field
        // becomes a public response, a log property, or an authentication decision.
        rememberAuthFailure(error, { ...authFailureDiagnostic(error, callbackStages.get(request)), ...callbackContexts.get(request) });
        throw error;
      }
    };
    let issued;
    try {
      // Sharing is cookie-only and requires all exact values, including the
      // server-registered return context. The digest is never logged/persisted.
      // The issued token is delivered only to those already-bound active requests;
      // completion removes the lookup before any later replay can join it.
      issued = client.authMode === 'cookie'
        ? await cookieCallbacks.run(createHash('sha256').update(JSON.stringify([client.id, context.redirectUri, context.clientState ?? null,
          stateHash, hashToken(binding!), input.sIdno, input.sToken])).digest('hex'), verifyAndIssue)
        : await verifyAndIssue();
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_CALLBACK') bindingFailures.set(request, 'attempt_rejected');
      throw error;
    }
    callbackContexts.set(request, issued.context);
    callbackStages.set(request, 'callback_response');
    if (client.authMode === 'cookie') setSessionCookie(reply,config,issued.token,issued.expiresAt,client.id);
    if (client.authMode === 'bearer') {
      const code = randomBytes(32).toString('base64url'), codeHash = hashToken(code);
      await store.createFrontendAuthCode({ codeHash, clientId: client.id, redirectUri: context.redirectUri,
        codeChallenge: context.codeChallenge!, sessionTokenHash: hashToken(issued.token),
        encryptedToken: sealFrontendToken(issued.token, config.sessionEncryptionKey!, codeHash, client.id) });
      return reply.code(303).redirect(frontendReturn(context, { code, clientId: client.id, clientState: context.clientState! }));
    }
    return reply.code(303).redirect(context.clientState ? frontendReturn(context, { clientId: client.id, clientState: context.clientState }) : context.redirectUri);
  } });

  app.post('/v1/auth/token', async (request, reply) => {
    const input = z.object({ clientId: frontendClientId, code: state, codeVerifier: pkceVerifier,
      redirectUri: z.string().max(2048) }).strict().parse(request.body);
    const client = getFrontendClient(config.frontendClients, input.clientId);
    if (client.authMode !== 'bearer' || !client.redirectUris.includes(input.redirectUri))
      throw new AppError(400, 'INVALID_CLIENT', '로그인 요청을 확인할 수 없습니다.');
    const origin = request.headers.origin;
    if (!origin || !client.origins.includes(origin) || origin !== new URL(input.redirectUri).origin)
      throw new AppError(403, 'CLIENT_ORIGIN_INVALID', '로그인 프론트를 확인할 수 없습니다.');
    if (!config.sessionEncryptionKey) throw unavailable('SCHOOL_AUTH_UNAVAILABLE');
    const codeHash = hashToken(input.code);
    const challenge = createHash('sha256').update(input.codeVerifier, 'ascii').digest('base64url');
    const grant = await store.consumeFrontendAuthCode(codeHash, client.id, input.redirectUri, challenge);
    if (!grant) throw new AppError(401, 'AUTH_CODE_INVALID', '로그인을 다시 시작해 주세요.');
    const session = await store.getSession(grant.sessionTokenHash);
    if (!session || session.clientId !== client.id) throw new AppError(401, 'AUTH_CODE_INVALID', '로그인을 다시 시작해 주세요.');
    const accessToken = unsealFrontendToken(grant.encryptedToken, config.sessionEncryptionKey, codeHash, client.id);
    if (hashToken(accessToken) !== grant.sessionTokenHash) throw new AppError(401, 'AUTH_CODE_INVALID', '로그인을 다시 시작해 주세요.');
    // Unlike the existing cookie login, this response never sets a session cookie.
    reply.header('pragma', 'no-cache');
    return { accessToken, tokenType: 'Bearer', expiresAt: session.expiresAt, csrfToken: session.csrfToken,
      user: { id: session.user.id, displayName: session.user.displayName } };
  });
}
