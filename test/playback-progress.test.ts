import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlaybackProgressRecorder, publicPlaybackProgress, publicJobPlaybackProgress, validPlaybackObservation, validPlaybackReportAck,
  type PlaybackObservation, type PlaybackProgressRepository, type PlaybackReportAck } from '../src/playback-progress.js';
import type { WorkerClaim } from '../src/playback-authority.js';
const claim: WorkerClaim = Object.freeze({ jobId: 'job-a', userId: 'owner-a', courseId: '1', lectureId: '2',
  acceptedGeneration: '00000000-0000-4000-8000-000000000001', executionTokenHash: 'a'.repeat(64) });
const observation: PlaybackObservation = { observedAt: '2026-11-09T00:00:00.000Z', positionSeconds: 25,
  durationSeconds: 100, percent: 25, paused: false, ended: false };
const sample = (positionSeconds = 25, ended = false) => ({ positionSeconds, durationSeconds: 100, playbackRate: 1, paused: false, ended, seeking: false, visible: true });
const ack: PlaybackReportAck = { event: 'update', acknowledgedAt: '2026-11-09T00:00:01.000Z' };
function fixture(options: { reject?: boolean; throw?: boolean; block?: Promise<void> } = {}) {
  let clock = Date.parse(observation.observedAt);
  const observations: PlaybackObservation[] = [], acknowledgements: PlaybackReportAck[] = [];
  let inFlight = 0, maxInFlight = 0;
  const repository: PlaybackProgressRepository = {
    async recordPlaybackObservation(received, value) {
      assert.deepEqual(received, claim); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { await options.block; if (options.throw) throw new Error('synthetic telemetry database error'); observations.push(value); return !options.reject; }
      finally { inFlight--; }
    },
    async recordPlaybackReportAck(received, value) { assert.deepEqual(received, claim); acknowledgements.push(value); return !options.reject; },
  };
  return { recorder: createPlaybackProgressRecorder(repository, { now: () => clock, intervalMs: 10 }), observations, acknowledgements,
    advance: (value: number) => { clock += value; }, concurrency: () => maxInFlight };
}
test('observations expose real percent and report ACK separately without private fields', () => {
  assert.deepEqual(publicPlaybackProgress(observation, ack), { ...observation, lastReport: ack });
  assert.deepEqual(publicPlaybackProgress(observation, null), { ...observation, lastReport: null });
  assert.equal(publicPlaybackProgress(null, ack), null);
  assert.equal(publicJobPlaybackProgress({ ...observation, lastReport: ack, executionTokenHash: 'secret' }), null);
  assert.deepEqual(publicJobPlaybackProgress({ ...observation, lastReport: ack }), { ...observation, lastReport: ack });
  assert.equal(publicPlaybackProgress({ ...observation, executionTokenHash: 'secret' }, ack), null);
  assert.equal(publicPlaybackProgress(observation, { ...ack, schoolUrl: 'secret' })?.lastReport, null);
});
test('non-finite, fabricated percent, overlong, negative and wrong-shape observations are rejected', () => {
  for (const patch of [{ positionSeconds: -1 }, { durationSeconds: 0 }, { durationSeconds: 15000 },
    { positionSeconds: NaN }, { percent: Infinity }, { percent: 50 }, { paused: 'false' }, { observedAt: 'invalid' }, { ended: true }, { observedAt: '2026-02-30T00:00:00.000Z' }])
    assert.equal(validPlaybackObservation({ ...observation, ...patch }), false);
  assert.equal(validPlaybackObservation({ ...observation, positionSeconds: 100.2, percent: 100 }), true);
  assert.equal(validPlaybackObservation({ ...observation, positionSeconds: 100.3, percent: 100 }), false);
  assert.equal(validPlaybackReportAck({ ...ack, event: 'unknown' }), false);
});
test('sampler writes coalesce while in flight and final flush persists the latest actual sample', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ block: blocked });
  f.recorder.observe(claim, sample(10)); f.recorder.observe(claim, sample(20)); f.recorder.observe(claim, sample(30));
  assert.equal(f.observations.length, 0); release(); await delay(0); f.advance(20);
  await f.recorder.flushAndStop(claim);
  assert.deepEqual(f.observations.map(x => x.positionSeconds), [10, 30]); assert.equal(f.concurrency(), 1);
  f.recorder.observe(claim, sample(40)); f.recorder.acknowledge(claim, 'ended'); await delay(15);
  assert.deepEqual(f.observations.map(x => x.positionSeconds), [10, 30]); assert.equal(f.acknowledgements.length, 0);
});
test('ended and real report ACK bypass the display throttle but never claim school completion', async () => {
  const f = fixture(); f.recorder.observe(claim, sample(0)); await delay(0);
  f.advance(2); f.recorder.observe(claim, sample(100, true)); f.recorder.acknowledge(claim, 'ended');
  await f.recorder.flushAndStop(claim);
  assert.equal(f.observations.at(-1)?.percent, 100); assert.equal(f.observations.at(-1)?.ended, true);
  assert.equal(f.acknowledgements.at(-1)?.event, 'ended');
  assert.doesNotMatch(JSON.stringify(f.observations), /recognized|schoolCompleted|attendance|userId/);
});
test('no observation is fabricated for ACK-only playback and invalid media observations never write', async () => {
  const f = fixture(); f.recorder.acknowledge(claim, 'playing');
  f.recorder.observe(claim, { ...sample(), seeking: true }); f.recorder.observe(claim, { ...sample(), playbackRate: 2 });
  await f.recorder.flushAndStop(claim); assert.equal(f.observations.length, 0); assert.equal(f.acknowledgements.length, 1);
});
test('telemetry failures cannot throw into media/report flow, and lost claims stop later persistence', async () => {
  const failing = fixture({ throw: true }); assert.doesNotThrow(() => failing.recorder.observe(claim, sample()));
  await failing.recorder.flushAndStop(claim);
  const revoked = fixture({ reject: true }); revoked.recorder.observe(claim, sample(10)); await delay(0);
  revoked.recorder.observe(claim, sample(20)); revoked.recorder.acknowledge(claim, 'update'); await revoked.recorder.flushAndStop(claim);
  assert.equal(revoked.observations.length, 1); assert.equal(revoked.acknowledgements.length, 0);
});
