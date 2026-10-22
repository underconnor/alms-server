import { z } from 'zod';
import { loadFrontendClients } from './frontend-clients.js';
import { loadMcpConfig } from './mcp-config.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173,https://lms.flyjung.kr'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(604800).default(86400),
  APP_VERSION: z.string().default('0.1.0'),
  GIT_COMMIT: z.string().default('unknown'),
  API_PUBLIC_ORIGIN: z.url().default('https://api-lms.flyjung.kr'),
  FRONTEND_ORIGIN: z.url().default('https://lms.flyjung.kr'),
  FRONTEND_CLIENTS_JSON: z.string().optional(),
  SESSION_ENCRYPTION_KEY: z.string().optional(),
  POSTHOG_PROJECT_KEY: z.string().optional(),
  SSU_PLAYBACK_ENABLED: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const origins = parsed.ALLOWED_ORIGINS.split(',').map(x => new URL(x.trim()).origin);
  if (parsed.NODE_ENV === 'production' && parsed.COOKIE_SECURE !== 'true') {
    throw new Error('Production cookies must be secure');
  }
  const sessionEncryptionKey = parsed.SESSION_ENCRYPTION_KEY ? Buffer.from(parsed.SESSION_ENCRYPTION_KEY,'base64') : undefined;
  if (sessionEncryptionKey && (sessionEncryptionKey.length !== 32 || sessionEncryptionKey.toString('base64') !== parsed.SESSION_ENCRYPTION_KEY)) throw new Error('SESSION_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  if (parsed.SSU_PLAYBACK_ENABLED === 'true' && !sessionEncryptionKey) throw new Error('Playback requires a school session encryption key');
  const apiOrigin = new URL(parsed.API_PUBLIC_ORIGIN).origin;
  const frontendOrigin = new URL(parsed.FRONTEND_ORIGIN).origin;
  if (parsed.NODE_ENV === 'production' && (!apiOrigin.startsWith('https://') || !frontendOrigin.startsWith('https://'))) throw new Error('Public origins must use HTTPS');
  const frontendClients = loadFrontendClients(parsed.FRONTEND_CLIENTS_JSON, frontendOrigin, apiOrigin, origins, parsed.NODE_ENV === 'production');
  const mcp = loadMcpConfig(env, apiOrigin, sessionEncryptionKey);
  return {
    databaseUrl: parsed.DATABASE_URL, host: parsed.HOST, port: parsed.PORT,
    allowedOrigins: [...new Set([...origins, ...frontendClients.flatMap(client => client.origins)])], frontendClients, cookieSecure: parsed.COOKIE_SECURE === 'true',
    cookieName: parsed.COOKIE_SECURE === 'true' ? '__Host-alms_session' : 'alms_session_dev',
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS, version: parsed.APP_VERSION,
    commit: parsed.GIT_COMMIT, posthogKey: parsed.POSTHOG_PROJECT_KEY,
    apiOrigin,frontendOrigin,sessionEncryptionKey,
    logLevel: parsed.LOG_LEVEL, playbackEnabled: parsed.SSU_PLAYBACK_ENABLED === 'true', mcp,
  };
}
export type Config = ReturnType<typeof loadConfig>;
