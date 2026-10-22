import type { Config } from './config.js';

/** One machine-readable entry point; no user, key, registry or school state. */
export function apiDiscovery(config: Pick<Config, 'apiOrigin' | 'mcp'>) {
  return {
    contractVersion: '2026-10-22',
    http: { openapi: `${config.apiOrigin}/openapi.json`, featureSupport: `${config.apiOrigin}/v1/features`,
      clientPackage: '@alms/http-client', schoolSdkPackage: '@alms/ssu-api' },
    mcp: { enabled: Boolean(config.mcp), endpoint: `${config.apiOrigin}/mcp`,
      resourceMetadata: `${config.apiOrigin}/.well-known/oauth-protected-resource/mcp`,
      readOnly: true, authorization: 'oauth2_authorization_code_pkce_s256', clientId: 'alms-codex', scopes: ['alms:read'] },
  };
}
