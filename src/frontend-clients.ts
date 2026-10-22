import { getDomain } from 'tldts';
import { z } from 'zod';
import { AppError } from './errors.js';

export const defaultFrontendClientId = 'alms-web';
export const frontendClientId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const pkceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const pkceVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
export type FrontendClient = Readonly<{
  id: string; origins: readonly string[]; redirectUris: readonly string[];
  defaultRedirectUri: string; authMode: 'cookie' | 'bearer';
}>;
export type LoginClientContext = {
  clientId: string; redirectUri: string; clientState?: string; codeChallenge?: string;
};
const registration = z.object({ id: frontendClientId, origins: z.array(z.string()).min(1).max(10),
  redirectUris: z.array(z.string()).min(1).max(20), defaultRedirectUri: z.string(),
  authMode: z.enum(['cookie', 'bearer']) }).strict();

function safeUrl(value: string, production: boolean): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hostname.includes('*') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production && loopback)))
    throw new Error('Frontend client URLs must use HTTPS or development loopback HTTP');
  return url;
}
export function sameSite(left: URL, right: URL): boolean {
  const site = (url: URL) => getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return left.protocol === right.protocol && site(left) === site(right);
}
export function loadFrontendClients(raw: string | undefined, frontendOrigin: string, apiOrigin: string,
  legacyOrigins: readonly string[], production: boolean): readonly FrontendClient[] {
  if (production && !sameSite(safeUrl(frontendOrigin,production),safeUrl(apiOrigin,production)))
    throw new Error('The existing cookie frontend must share the API site; register cross-site frontends with PKCE');
  const clients: FrontendClient[] = [{ id: defaultFrontendClientId, authMode: 'cookie',
    origins: [...new Set([frontendOrigin, ...legacyOrigins])], redirectUris: [frontendOrigin + '/'], defaultRedirectUri: frontendOrigin + '/' }];
  if (!raw) return clients;
  if (raw.length > 32_768) throw new Error('Frontend client registry is too large');
  const values = z.array(registration).max(32).parse(JSON.parse(raw));
  const seen = new Set([defaultFrontendClientId]);
  for (const value of values) {
    if (seen.has(value.id)) throw new Error('Frontend client IDs must be unique; alms-web is reserved');
    seen.add(value.id);
    const origins = value.origins.map(input => {
      const url = safeUrl(input, production);
      if (input !== url.origin) throw new Error('Frontend origins must be exact origins');
      if (value.authMode === 'cookie' && !sameSite(url, new URL(apiOrigin)) && !(url.protocol === 'http:' && !production))
        throw new Error('Cross-site frontends must use bearer with PKCE');
      return url.origin;
    });
    const redirectUris = value.redirectUris.map(input => {
      const url = safeUrl(input, production);
      if (url.toString() !== input || !origins.includes(url.origin) || url.search)
        throw new Error('Login return URLs must be exact registered URLs without a query');
      if (url.hash && !/^#\/[A-Za-z0-9/_-]*$/.test(url.hash)) throw new Error('Login return fragments must be a static route');
      return input;
    });
    if (!redirectUris.includes(value.defaultRedirectUri)) throw new Error('Default return URL must be registered');
    clients.push(Object.freeze({ ...value, origins: Object.freeze(origins), redirectUris: Object.freeze(redirectUris) }));
  }
  return Object.freeze(clients);
}
export function getFrontendClient(clients: readonly FrontendClient[], id = defaultFrontendClientId): FrontendClient {
  const client = clients.find(value => value.id === id);
  if (!client) throw new AppError(400, 'INVALID_CLIENT', '등록된 프론트를 확인할 수 없습니다.');
  return client;
}
const startQuery = z.object({ clientId: frontendClientId.optional(), redirectUri: z.string().max(2048).optional(),
  clientState: pkceChallenge.optional(), codeChallenge: pkceChallenge.optional(), codeChallengeMethod: z.literal('S256').optional(),
  // Historical callers supplied this ignored field. It never selects a destination.
  returnTo: z.string().max(2048).optional() }).strict();
export function loginContext(clients: readonly FrontendClient[], query: unknown): LoginClientContext {
  const input = startQuery.parse(query);
  const client = getFrontendClient(clients, input.clientId);
  const redirectUri = input.redirectUri ?? client.defaultRedirectUri;
  if (!client.redirectUris.includes(redirectUri)) throw new AppError(400, 'INVALID_REDIRECT_URI', '등록된 로그인 복귀 주소가 아닙니다.');
  if (client.authMode === 'bearer' && (!input.clientState || !input.codeChallenge || input.codeChallengeMethod !== 'S256'))
    throw new AppError(400, 'PKCE_REQUIRED', '로그인 요청의 보호 값을 확인해 주세요.');
  if (client.authMode === 'cookie' && (input.codeChallenge || input.codeChallengeMethod))
    throw new AppError(400, 'INVALID_REQUEST', '로그인 방식을 확인해 주세요.');
  return { clientId: client.id, redirectUri, ...(input.clientState ? { clientState: input.clientState } : {}),
    ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}) };
}
export function validateStoredLoginContext(clients: readonly FrontendClient[], context: LoginClientContext): FrontendClient {
  const client = getFrontendClient(clients, context.clientId);
  if (!client.redirectUris.includes(context.redirectUri) || (client.authMode === 'bearer'
    && (!pkceChallenge.safeParse(context.codeChallenge).success || !pkceChallenge.safeParse(context.clientState).success)))
    throw new AppError(400, 'INVALID_CLIENT', '로그인 설정이 변경됐습니다. 다시 시작해 주세요.');
  return client;
}
export function frontendReturn(context: LoginClientContext, values: Record<string, string>): string {
  const destination = new URL(context.redirectUri);
  const route = destination.hash.replace(/^#/, '') || '/';
  destination.hash = route + '?' + new URLSearchParams(values).toString();
  return destination.toString();
}
