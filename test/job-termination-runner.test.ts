import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Job, JobStatus } from '../src/domain.js';
import type { PgStore, JobTransitionOptions } from '../src/store.js';
import type { SchoolProvider, PreparedPlayback } from '../src/provider.js';
import { claimMatchesJob, jobClaim, createPlaybackFinalProof, type WorkerClaim } from '../src/playback-authority.js';
import { createPlaybackTerminationProof, inspectPlaybackTerminationProof, type PlaybackTerminationProof } from '../src/playback-termination.js';
import { executeJob } from '../src/job-runner.js';
import { AppError } from '../src/errors.js';
const limits = { operationMs: 100, preparationMs: 30, resultMs: 50, cleanupMs: 40, finalizationMs: 100 };
function fixture() {
  let job: Job = { id: randomUUID(), userId: randomUUID(), courseId: '10', lectureId: '20', status: 'queued',
    scheduledFor: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    acceptedGeneration: randomUUID(), executionTokenHash: null, executionOutcome: null, schoolResult: null, errorCode: null,
    idempotencyKey: randomUUID(), requestHash: 'synthetic-hash' };
  const transitions: Array<{ to: JobStatus; options: JobTransitionOptions }> = []; let claim: WorkerClaim;
  const store = { claimJob: async () => { job = { ...job, status: 'running', executionTokenHash: 'a'.repeat(64) }; claim = jobClaim(job); return { ...job }; },
    getWorkerJob: async (value: WorkerClaim) => claimMatchesJob(value, job) ? { ...job } : null,
    heartbeat: async (value: WorkerClaim) => claimMatchesJob(value, job),
    transitionJob: async (value: WorkerClaim, from: JobStatus[], to: JobStatus, result: null, code: string | null, options: JobTransitionOptions) => {
      if (!claimMatchesJob(value, job) || !from.includes(job.status)) return null;
      transitions.push({ to, options }); if (options.terminationProof) inspectPlaybackTerminationProof(options.terminationProof, value);
      job = { ...job, status: to, schoolResult: result ?? job.schoolResult, errorCode: code, executionOutcome: options.outcome ?? job.executionOutcome,
        executionTokenHash: ['running','reconciling','cancel_requested'].includes(to) ? job.executionTokenHash : null }; return { ...job };
    },
  } as unknown as PgStore;
  const claims = new WeakMap<PreparedPlayback, WorkerClaim>();
  const provider = (prepare: SchoolProvider['preparePlayback']): SchoolProvider => ({
    capabilities: { schoolAuthentication: false, schoolRead: false, playback: true, pauseResume: false },
    preparePlayback: async (context, target, signal) => { const value = await prepare!(context, target, signal); claims.set(value, context.claim); return value; },
    validatePlayback: async value => { const claim = claims.get(value)!; return createPlaybackFinalProof(claim,
      { generation: claim.acceptedGeneration, encryptedSession: 'synthetic-school-seal' }); },
    play: async () => { throw new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'synthetic report unknown'); },
    playbackLearningStatus: async () => assert.fail('Unknown report must not read a fresh result'),
  });
  return { store, provider, id: job.id, current: () => job, transitions, claim: () => claim! };
}
test('runner forwards an exact termination proof only after successful disposal and preserves report uncertainty', async () => {
  const f = fixture(); let disposed = false, inspected = 0; let proof: PlaybackTerminationProof | undefined;
  await executeJob(f.id, f.store, f.provider(async context => ({ alreadyRecognized: false, handle: {},
    dispose: async () => { disposed = true; }, terminationProof: () => { inspected++; assert.equal(disposed, true);
      return proof ??= createPlaybackTerminationProof(context.claim, { runtimeStopped: true, dispatchFenced: true, callbacksDrained: true }); },
  })), undefined, 2, limits);
  assert.equal(inspected, 1); assert.equal(f.current().status, 'needs_verification'); assert.equal(f.current().executionOutcome, 'interrupted');
  assert.equal(f.current().errorCode, 'PLAYBACK_REPORT_UNKNOWN'); assert.equal(f.current().schoolResult, null);
  assert.equal(f.transitions.at(-1)?.options.terminationProof, proof); inspectPlaybackTerminationProof(proof!, f.claim());
});
test('runner cannot turn a failed or unconfirmed cleanup into termination evidence', async () => {
  for (const mode of ['failed', 'unconfirmed'] as const) {
    const f = fixture(); let inspected = 0;
    await executeJob(f.id, f.store, f.provider(async context => ({ alreadyRecognized: false, handle: {},
      dispose: async () => { if (mode === 'failed') throw new Error('synthetic close failure'); },
      terminationProof: () => { inspected++; return mode === 'unconfirmed' ? null : createPlaybackTerminationProof(context.claim,
        { runtimeStopped: true, dispatchFenced: true, callbacksDrained: true }); },
    })), undefined, 2, limits);
    assert.equal(inspected, mode === 'failed' ? 0 : 1); assert.equal(f.transitions.at(-1)?.options.terminationProof, undefined);
    assert.equal(f.current().status, 'needs_verification'); assert.equal(f.current().schoolResult, null);
  }
});
test('a handle arriving after preparation timeout is disposed without creating late termination proof', async () => {
  const f = fixture(); let finish!: (value: PreparedPlayback) => void, disposed = 0, inspected = 0;
  const wait = new Promise<PreparedPlayback>(resolve => { finish = resolve; });
  await executeJob(f.id, f.store, f.provider(async () => wait), undefined, 2, limits);
  assert.equal(f.current().status, 'needs_verification'); assert.equal(f.transitions.at(-1)?.options.terminationProof, undefined);
  finish({ alreadyRecognized: false, handle: {}, dispose: async () => { disposed++; }, terminationProof: () => { inspected++; return null; } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, 1); assert.equal(inspected, 0); assert.equal(f.transitions.at(-1)?.options.terminationProof, undefined);
});
