import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createPlaybackTerminationProof, inspectPlaybackTerminationProof, type PlaybackTerminationProof } from '../src/playback-termination.js';
import type { WorkerClaim } from '../src/playback-authority.js';

const claim = (): WorkerClaim => ({ jobId: randomUUID(), userId: randomUUID(), courseId: '10', lectureId: '20',
  acceptedGeneration: randomUUID(), executionTokenHash: 'a'.repeat(64) });
const closure = { runtimeStopped: true, dispatchFenced: true, callbacksDrained: true } as const;
test('termination proof binds an immutable exact attempt and redacts internal authority', () => {
  const original = claim(), proof = createPlaybackTerminationProof(original, closure);
  const saved = inspectPlaybackTerminationProof(proof, original);
  assert.deepEqual(saved.claim, original); assert.ok(Number.isFinite(Date.parse(saved.terminatedAt)));
  assert.ok(Object.isFrozen(proof)); assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.claim));
  const rendered = JSON.stringify(proof) + inspect(proof);
  for (const privateValue of [original.jobId, original.userId, original.acceptedGeneration, original.executionTokenHash]) assert.ok(!rendered.includes(privateValue));
  assert.throws(() => inspectPlaybackTerminationProof({} as PlaybackTerminationProof, original));
});
test('every claim mismatch rejects a real termination proof', () => {
  const original = claim(), proof = createPlaybackTerminationProof(original, closure);
  for (const change of [{ jobId: randomUUID() }, { userId: randomUUID() }, { courseId: '11' }, { lectureId: '21' },
    { acceptedGeneration: randomUUID() }, { executionTokenHash: 'b'.repeat(64) }])
    assert.throws(() => inspectPlaybackTerminationProof(proof, { ...original, ...change }));
});
test('expiry, school ACK or a partial cleanup cannot construct the proof', () => {
  for (const value of [{}, { runtimeStopped: true }, { ...closure, callbacksDrained: false }, { ...closure, dispatchFenced: false },
    { ...closure, runtimeStopped: false }, { ...closure, acknowledged: true }])
    assert.throws(() => createPlaybackTerminationProof(claim(), value as typeof closure));
});
