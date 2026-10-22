import { inspect } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Job } from './domain.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const scopeSchema = z.object({ userId: id, courseId: id, lectureId: id });
const claimSchema = scopeSchema.extend({ jobId: id, acceptedGeneration: z.uuid(), executionTokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type WorkerClaim = Readonly<z.infer<typeof claimSchema>>;
type Scope = z.infer<typeof scopeSchema>;
const brand: unique symbol = Symbol('PlaybackAuthority');
export interface PlaybackAdmission { readonly [brand]: 'admission' }
export interface PlaybackFinalProof { readonly [brand]: 'final' }
type AdmissionData = Readonly<Scope & { generation: string; encryptedSession: string; expiresAt: number }>;
type FinalData = Readonly<{ claim: WorkerClaim; generation: string; encryptedSession: string; expiresAt: number }>;
const admissions = new WeakMap<PlaybackAdmission, AdmissionData>();
const finals = new WeakMap<PlaybackFinalProof, FinalData>();
const invalid = () => new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이나 작업 상태가 바뀌었습니다. 다시 확인해 주세요.');
function session(value: { generation: string; encryptedSession: string }) {
  return z.object({ generation: z.uuid(), encryptedSession: z.string().min(1).max(2_000_000) }).strict().parse(value);
}
function handle<T extends 'admission' | 'final'>(kind: T) {
  return Object.freeze({ [brand]: kind, toJSON: () => ({ kind: 'private-playback-authority' }),
    [inspect.custom]: () => 'PlaybackAuthority { private }' });
}
/** Adapter-only proof after fresh school reads and its final cookie-jar CAS. Never serialize its inspected data. */
export function createPlaybackAdmission(scope: Scope, value: { generation: string; encryptedSession: string }): PlaybackAdmission {
  const result = handle('admission');
  admissions.set(result, Object.freeze({ ...scopeSchema.strict().parse(scope), ...session(value), expiresAt: Date.now() + 30_000 }));
  return result;
}
export function inspectPlaybackAdmission(value: PlaybackAdmission, scope: Scope): AdmissionData {
  const data = admissions.get(value);
  if (!data || data.expiresAt <= Date.now() || !sameScope(data, scope)) throw invalid();
  return data;
}
/** The identity/claim validator remains usable after the runtime/report controller has closed. */
export function createPlaybackFinalProof(claim: WorkerClaim, value: { generation: string; encryptedSession: string }): PlaybackFinalProof {
  const parsed = Object.freeze(claimSchema.parse(claim)), checked = session(value);
  if (parsed.acceptedGeneration !== checked.generation) throw invalid();
  const result = handle('final');
  finals.set(result, Object.freeze({ claim: parsed, ...checked, expiresAt: Date.now() + 30_000 }));
  return result;
}
export function inspectPlaybackFinalProof(value: PlaybackFinalProof, claim: WorkerClaim): FinalData {
  const data = finals.get(value);
  if (!data || data.expiresAt <= Date.now() || !sameClaim(data.claim, claim)) throw invalid();
  return data;
}
const sameScope = (a: Scope, b: Scope) => a.userId === b.userId && a.courseId === b.courseId && a.lectureId === b.lectureId;
export function sameClaim(a: WorkerClaim, b: WorkerClaim) {
  return sameScope(a, b) && a.jobId === b.jobId && a.acceptedGeneration === b.acceptedGeneration && a.executionTokenHash === b.executionTokenHash;
}
export function jobClaim(job: Job): WorkerClaim {
  if (!job.acceptedGeneration || !job.executionTokenHash) throw invalid();
  return Object.freeze(claimSchema.parse({ jobId: job.id, userId: job.userId, courseId: job.courseId, lectureId: job.lectureId,
    acceptedGeneration: job.acceptedGeneration, executionTokenHash: job.executionTokenHash }));
}
export function claimMatchesJob(claim: WorkerClaim, job: Job) {
  return sameScope(claim, job) && claim.jobId === job.id && claim.acceptedGeneration === job.acceptedGeneration
    && claim.executionTokenHash === job.executionTokenHash;
}
