import { createHash, createPrivateKey } from 'node:crypto';
import type { JWKS } from 'oidc-provider';

export interface McpConfig {
  issuer: string;
  resource: string;
  signingJwks: JWKS;
  cookieKeys: readonly string[];
  client: { id: string; redirectUris: readonly string[] };
}

/** Codex 0.141.0 appends this exact server URL's identifier to its loopback path. */
export function mcpNativeRedirectUris(resource: string): readonly string[] {
  const url = new URL(resource);
  url.hash = '';
  const callbackId = createHash('sha256').update(url.href).digest().subarray(0, 9).toString('base64url');
  return ['http://127.0.0.1/callback', 'http://localhost/callback',
    `http://127.0.0.1/callback/${callbackId}`, `http://localhost/callback/${callbackId}`];
}

/** A disabled deployment never silently generates temporary OAuth credentials. */
export function loadMcpConfig(env: NodeJS.ProcessEnv, apiOrigin: string, encryptionKey?: Buffer): McpConfig | undefined {
  if (env.MCP_ENABLED !== undefined && !['true', 'false'].includes(env.MCP_ENABLED)) throw new Error('Invalid MCP_ENABLED');
  if (env.MCP_ENABLED !== 'true') return undefined;
  if (!encryptionKey || encryptionKey.length !== 32) throw new Error('MCP requires SESSION_ENCRYPTION_KEY');
  const origin = new URL(apiOrigin);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) {
    throw new Error('MCP requires HTTPS or local loopback');
  }
  let signingJwks: JWKS;
  let cookieKeys: string[];
  try {
    const signingInput = env.MCP_SIGNING_JWKS_JSON;
    const cookieInput = env.MCP_COOKIE_KEYS_JSON;
    if (!signingInput || signingInput.length > 32768 || !cookieInput || cookieInput.length > 4096) throw new Error();
    signingJwks = JSON.parse(signingInput) as JWKS;
    cookieKeys = JSON.parse(cookieInput) as string[];
    if (!Array.isArray(signingJwks.keys) || signingJwks.keys.length < 1 || signingJwks.keys.length > 3) throw new Error();
    const kids = new Set<string>();
    for (const key of signingJwks.keys) {
      if (key.kty !== 'RSA' || typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key.kid) || kids.has(key.kid) ||
          typeof key.d !== 'string' || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) throw new Error();
      const privateKey = createPrivateKey({ key, format: 'jwk' });
      if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
      kids.add(key.kid);
    }
    if (!Array.isArray(cookieKeys) || cookieKeys.length < 1 || cookieKeys.length > 3 ||
        cookieKeys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_=-]{43,128}$/.test(key)) || new Set(cookieKeys).size !== cookieKeys.length) throw new Error();
  } catch {
    // Do not include parser input or private key material in startup diagnostics.
    throw new Error('MCP requires valid persistent signing JWKS and cookie keys');
  }
  return {
    issuer: `${origin.origin}/oauth`, resource: `${origin.origin}/mcp`, signingJwks, cookieKeys,
    client: { id: 'alms-codex', redirectUris: mcpNativeRedirectUris(`${origin.origin}/mcp`) },
  };
}
