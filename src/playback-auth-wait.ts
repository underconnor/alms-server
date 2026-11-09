import { z } from 'zod';
import { decryptSchoolSession } from './crypto.js';
import type { Job } from './domain.js';

export const authenticationWaitReason = z.enum(['school_auth_required','school_session_changed']);
export type AuthenticationWaitReason = z.infer<typeof authenticationWaitReason>;
const authWaitSchema = z.object({ waitingSince: z.iso.datetime({ offset: true }), reason: authenticationWaitReason,
  canContinue: z.boolean(), continuedAsJobId: z.uuid().nullable() }).strict();
export type PlaybackAuthWait = z.infer<typeof authWaitSchema>;
export function publicPlaybackAuthWait(value: unknown): PlaybackAuthWait | null {
  const parsed = authWaitSchema.safeParse(value); if (!parsed.success) return null;
  return { ...parsed.data, canContinue: parsed.data.continuedAsJobId === null && parsed.data.canContinue };
}
const schoolState = z.object({ version: z.literal(1), generation: z.uuid(), lmsExchange: z.object({ status: z.literal('ready') }).passthrough() }).passthrough();
export interface ContinuationSchoolSessionStore { getEncryptedSchoolSession(owner: string, provider: string): Promise<string | null> }
/** A newer verified SSO is a display prerequisite, never a replacement for fresh native admission. */
export async function currentContinuationGeneration(store: ContinuationSchoolSessionStore, key: Buffer | undefined, owner: string): Promise<string | null> {
  if (!key) return null;
  const raw = await store.getEncryptedSchoolSession(owner, 'ssu'); if (!raw) return null;
  try { return schoolState.parse(decryptSchoolSession(raw, key, owner, 'ssu')).generation; } catch { return null; }
}
export async function withPlaybackContinuationState(store: ContinuationSchoolSessionStore, key: Buffer | undefined, owner: string, jobs: readonly Job[]): Promise<Job[]> {
  const marked = jobs.some(job => job.userId === owner && job.authWait && job.authenticationContinuationEligible);
  // An unavailable readiness hint must not erase otherwise readable queue history.
  // The POST path does not swallow these failures and still checks fresh authority.
  const generation = marked ? await currentContinuationGeneration(store, key, owner).catch(() => null) : null;
  return jobs.map(job => job.authWait ? { ...job, authWait: { ...job.authWait,
    canContinue: Boolean(job.userId === owner && job.authenticationContinuationEligible && generation && generation !== job.acceptedGeneration
      && job.authWait.continuedAsJobId === null) } } : job);
}
