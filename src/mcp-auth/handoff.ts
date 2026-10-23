import { mcpDenied } from './repository.js';

/** The provider-generated resume URL is the only permitted browser handoff. */
export function verifiedMcpResumeUrl(value: string, apiOrigin: string, expectedResumeUrl: string): string {
  try {
    const target = new URL(value), expected = new URL(expectedResumeUrl);
    if (new URL(apiOrigin).origin !== apiOrigin || target.origin !== apiOrigin || expected.origin !== apiOrigin
      || target.href !== value || expected.href !== expectedResumeUrl || value !== expectedResumeUrl
      || !/^\/oauth\/auth\/[A-Za-z0-9_-]{43}$/.test(target.pathname) || target.search || target.hash || target.username || target.password) throw mcpDenied();
    return target.href;
  } catch { throw mcpDenied(); }
}
