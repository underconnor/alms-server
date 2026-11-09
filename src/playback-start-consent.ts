import { z } from 'zod';
import { AppError } from './errors.js';
import { decryptSchoolSession } from './crypto.js';
export const consentIdentifier = z.string().regex(/^[1-9]\d{0,15}$/);
export const startConsentInput = z
  .object({
    courseId: consentIdentifier,
    lectureIds: z.array(consentIdentifier).min(1).max(100),
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.lectureIds).size !== v.lectureIds.length)
      ctx.addIssue({ code: 'custom', path: ['lectureIds'], message: 'Duplicate target' });
  })
  .transform((v) => ({
    ...v,
    lectureIds: [...v.lectureIds].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)),
  }));
export type PlaybackStartConsentInput = z.infer<typeof startConsentInput>;
export type PlaybackStartConsentReceipt = { id: string; expiresAt: string; courseId: string; lectureIds: string[] };
export type JobStartConsent = {
  id: string;
  expiresAt: string;
  attempt: 'not_attempted' | 'reserved' | 'acknowledged' | 'unknown';
};
export type PlaybackStartAttempt = { attemptId: string; consentId: string; expiresAt: string };
export type ConsentAuthorization = { almsTokenHash: string; csrfToken: string; clientId: string | null };
export type ConsentSchoolAuthorization = ConsentAuthorization & { generation: string; encryptedSession: string };
const state = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    lmsExchange: z.object({ status: z.literal('ready') }).passthrough(),
  })
  .passthrough();
export function inspectConsentSchoolSession(
  raw: string | null,
  key: Buffer,
  owner: string,
): { generation: string; encryptedSession: string } {
  try {
    if (!raw) throw new Error();
    return { generation: state.parse(decryptSchoolSession(raw, key, owner, 'ssu')).generation, encryptedSession: raw };
  } catch {
    throw new AppError(401, 'SCHOOL_AUTH_REQUIRED', '학교 인증을 갱신한 뒤 다시 확인해 주세요.');
  }
}
export const consentFailure = (code: string, status = 409) =>
  new AppError(status, code, '자동수강 시작 동의를 다시 확인해 주세요.');
export function publicStartConsent(value: unknown): JobStartConsent | null {
  const parsed = z
    .object({
      id: z.uuid(),
      expiresAt: z.iso.datetime({ offset: true }),
      attempt: z.enum(['not_attempted', 'reserved', 'acknowledged', 'unknown']),
    })
    .strict()
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type NotAdmittedJobRequest = { requestStatus: 'not_admitted'; requestKey: string; startConsentId: string };
export function consentGenerationForInspection(
  raw: string | null,
  key: Buffer | undefined,
  owner: string,
): string | null {
  if (!raw || !key) return null;
  try {
    return state.parse(decryptSchoolSession(raw, key, owner, 'ssu')).generation;
  } catch {
    return null;
  }
}
