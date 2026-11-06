import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createWorkerClaimValidator, withSchoolPlayback } from '../src/playback-bootstrap.js';
import { inspectPlaybackAdmission } from '../src/playback-authority.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { fixture, context, noop, signal } from './helpers/school-video-fixture.js';
import type { Job } from '../src/domain.js';
const claim = { jobId: 'job', userId: 'owner', courseId: '101', lectureId: '201',
  acceptedGeneration: '11111111-1111-4111-8111-111111111111', executionTokenHash: 'a'.repeat(64) };
const row: Job = { id: claim.jobId, userId: claim.userId, courseId: claim.courseId, lectureId: claim.lectureId,
  acceptedGeneration: claim.acceptedGeneration, executionTokenHash: claim.executionTokenHash, executionOutcome: null,
  status: 'running', scheduledFor: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  schoolResult: null, errorCode: null, idempotencyKey: 'synthetic', requestHash: 'synthetic' };
test('playback remains disabled by default and enabling requires the configured school encryption key', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://synthetic' }).playbackEnabled, false);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://synthetic', SSU_PLAYBACK_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://synthetic', SSU_PLAYBACK_ENABLED: 'yes' }));
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://synthetic', SSU_PLAYBACK_ENABLED: 'true', SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }).playbackEnabled, true);
});
test('worker guard does not depend on a browser session and binds every claim field', async () => {
  let current: Job | null = { ...row }; let calls = 0;
  const validate = createWorkerClaimValidator({ getWorkerJob: async received => {
    assert.deepEqual(received, claim); calls++; return current;
  } }, 'final');
  for (const status of ['running', 'reconciling', 'cancel_requested'] as const) {
    current = { ...row, status }; await validate(claim, new AbortController().signal);
  }
  for (const field of ['id','userId','courseId','lectureId','acceptedGeneration','executionTokenHash'] as const) {
    current = { ...row, [field]: 'changed' };
    await assert.rejects(validate(claim, new AbortController().signal), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  }
  for (const status of ['queued','scheduled','completed','needs_verification','cancelled','needs_reauthentication'] as const) {
    current = { ...row, status };
    await assert.rejects(validate(claim, new AbortController().signal), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  }
  current = null;
  await assert.rejects(validate(claim, new AbortController().signal), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.equal(calls,16);
});

test('a cancellation immediately blocks media/report authority while permitting final reconciliation', async () => {
  const store = { getWorkerJob: async () => ({ ...row, status: 'cancel_requested' as const }) };
  await assert.rejects(createWorkerClaimValidator(store, 'execution')(claim, new AbortController().signal), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  await createWorkerClaimValidator(store, 'final')(claim, new AbortController().signal);
});

test('trusted production bootstrap opts into proven Readystream admission without starting Chromium or querying a lease', async t => {
  const f = await fixture({ workerOnly: true }); f.setType('readystream');
  t.mock.method(globalThis, 'fetch', f.fetcher);
  let databaseCalls = 0;
  const store = { ...f.store, pool: { query: () => { databaseCalls++; throw new Error('admission must not query worker leases'); } } };
  // The real trusted bootstrap constructs the SDK preparation, media and admission path.
  // There is deliberately no browser session or worker claim during API admission.
  const provider = withSchoolPlayback(unavailableSchoolProvider, store as any, f.key, noop);
  const target = { courseId: context.courseId, lectureId: context.moduleItemId };
  const admission = await provider.authorizePlayback!({ userId: context.owner }, target, { signal: signal(), validate: noop });
  const proof = inspectPlaybackAdmission(admission, { userId: context.owner, ...target });
  assert.equal(proof.generation, f.generation()); assert.equal(proof.encryptedSession, f.encrypted());
  assert.equal(f.counts().reports, 0); assert.equal(f.counts().starts, 0); assert.equal(databaseCalls, 0);
});
