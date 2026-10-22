import { inspect } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';
import { sameClaim, type WorkerClaim } from './playback-authority.js';

const claimSchema = z.object({ jobId: z.uuid(), userId: z.uuid(),
  courseId: z.string().regex(/^[1-9]\d{0,15}$/), lectureId: z.string().regex(/^[1-9]\d{0,15}$/),
  acceptedGeneration: z.uuid(), executionTokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const closedSchema = z.object({ runtimeStopped: z.literal(true), dispatchFenced: z.literal(true), callbacksDrained: z.literal(true) }).strict();
const brand: unique symbol = Symbol('PlaybackTerminationProof');
export interface PlaybackTerminationProof { readonly [brand]: true }
type Data = Readonly<{ claim: WorkerClaim; terminatedAt: string }>;
const proofs = new WeakMap<PlaybackTerminationProof, Data>();
const unsafe = () => new AppError(409, 'JOB_SETTLEMENT_UNSAFE', '영상 실행의 종료를 확인할 수 없습니다.');

/** Trusted adapter only. School ACK, lease expiry or a missing token is not termination. */
export function createPlaybackTerminationProof(claim: WorkerClaim,
  closure: { runtimeStopped: true; dispatchFenced: true; callbacksDrained: true }): PlaybackTerminationProof {
  const parsed = Object.freeze(claimSchema.parse(claim)); closedSchema.parse(closure);
  const handle = Object.freeze({ [brand]: true as const,
    toJSON: () => ({ kind: 'private-playback-termination' }),
    [inspect.custom]: () => 'PlaybackTerminationProof { private }' });
  proofs.set(handle, Object.freeze({ claim: parsed, terminatedAt: new Date().toISOString() }));
  return handle;
}

export function inspectPlaybackTerminationProof(value: PlaybackTerminationProof, claim: WorkerClaim): Data {
  const proof = proofs.get(value);
  if (!proof || !sameClaim(proof.claim, claim)) throw unsafe();
  return proof;
}
