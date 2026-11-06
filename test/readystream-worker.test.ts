import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.js';
import { createSchoolPlayback, type SchoolPlaybackClaim, type SchoolPlaybackInput,
  type WorkerVideoReportAcknowledgement } from '../src/school-playback.js';
import { inspectPlaybackTerminationProof } from '../src/playback-termination.js';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';
import { readystreamXml } from './helpers/readystream-fixture.js';

const target = { courseId: context.courseId, lectureId: context.moduleItemId };
const ended = { ended: true as const, browserClosed: true as const, processExited: true as const };
async function worker(options: { acknowledge?: (value: WorkerVideoReportAcknowledgement) => void } = {}) {
  const owner = randomUUID();
  const school = await fixture({ workerOnly: true, allowReadystreamWorker: true, owner }); school.setType('readystream');
  const claim: SchoolPlaybackClaim = { jobId: randomUUID(), userId: owner, ...target,
    acceptedGeneration: school.generation(), executionTokenHash: 'c'.repeat(64) };
  let current = true, leaseAvailable = true, admissions = 0, acquired = 0, released = 0, created = 0, disposed = 0;
  let play = async (_input: SchoolPlaybackInput, _signal: AbortSignal) => ended;
  const acknowledgements: WorkerVideoReportAcknowledgement[] = [];
  const validate = async (received: SchoolPlaybackClaim, supplied: AbortSignal) => {
    supplied.throwIfAborted(); assert.deepEqual(received, claim);
    if (!current) throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', 'synthetic revocation');
  };
  const adapter = createSchoolPlayback({ school: school.sessions, validateClaim: validate, validateFinalClaim: validate,
    createAdmission: (scope, proof) => {
      assert.deepEqual(scope, { userId: owner, ...target });
      assert.equal(proof.generation, school.generation()); assert.equal(proof.encryptedSession, school.encrypted());
      admissions++; return { admitted: true };
    },
    createFinalProof: (received, proof) => {
      assert.deepEqual(received, claim); assert.equal(proof.generation, school.generation()); return { current: true };
    },
    leases: { acquire: async (scope, proof) => {
      acquired++; assert.equal(scope.kind, 'worker'); assert.equal(scope.owner, owner);
      assert.equal(scope.generation, claim.acceptedGeneration); assert.equal(proof.encryptedSession, school.encrypted());
      assert.equal(proof.almsTokenHash, undefined); return leaseAvailable;
    }, renew: async () => true, release: async () => { released++; } },
    runtime: { createSource: (input: SchoolPlaybackInput) => { created++; return input; },
      play: (input, supplied) => play(input, supplied), dispose: async () => { disposed++; } },
    reportAcknowledged: value => { acknowledgements.push(value); options.acknowledge?.(value); },
  });
  return { school, adapter, claim, acknowledgements,
    setPlay: (next: typeof play) => { play = next; }, conflict: () => { leaseAvailable = false; }, revoke: () => { current = false; },
    counts: () => ({ admissions, acquired, released, created, disposed }),
    admit: () => adapter.authorizePlayback({ userId: owner }, target, { signal: signal(), validate: noop }),
    prepare: () => adapter.preparePlayback({ userId: owner, claim }, target, signal()) };
}

test('trusted worker admission validates Readystream media without opening a lease, runtime or school report', async () => {
  const f = await worker();
  assert.deepEqual(await f.admit(), { admitted: true });
  assert.deepEqual(f.counts(), { admissions: 1, acquired: 0, released: 0, created: 0, disposed: 0 });
  assert.equal(f.school.counts().reports, 0); assert.equal(f.school.counts().starts, 0);
  assert.equal(f.school.paths.filter(path => path === '/em/synthetic-video').length, 1);
  assert.deepEqual(f.acknowledgements, []);
});

test('Readystream SDK reports start, five-minute update and actual terminal observation before fresh school reconciliation', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = await worker();
  f.setPlay(async (input, supplied) => {
    input.observe({ ...observation, paused: true });
    input.observe(observation); await input.report('playing', supplied);
    for (let second = 1; second <= 600; second++) {
      now = second * 1_000;
      input.observe({ ...observation, positionSeconds: second, ended: second === 600, paused: second === 600 });
      if (second === 300) await input.report('update', supplied);
    }
    await input.report('ended', supplied); return ended;
  });
  const prepared = await f.prepare(); assert.equal(prepared.alreadyRecognized, false);
  await f.adapter.play(prepared, signal());
  assert.equal(f.school.counts().reports, 3); assert.equal(f.school.counts().starts, 0);
  assert.deepEqual(f.acknowledgements, ['playing', 'update', 'ended'].map(reportEvent => ({
    event: 'worker_video_report_acknowledged', reportEvent, resourceType: 'readystream',
    controllerState: reportEvent === 'ended' ? 'closed' : 'ready', transport: 'acknowledged' })));
  assert.ok(f.acknowledgements.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(f.acknowledgements), /synthetic|https|token|courseId|jobId|position|90000001/);
  f.school.setDetails({ attendance_data: { progress: 600, last_at: 600, completed: true, attendance_status: 'attendance' } });
  const fresh = await f.adapter.playbackLearningStatus(prepared, signal());
  assert.equal(fresh.progressPercent, 100); assert.equal(fresh.evidence?.completed, true);
  assert.equal(fresh.evidence?.resourceType, 'readystream'); assert.equal(fresh.evidence?.schoolAttendanceStatus, 'attendance');
  assert.equal(fresh.attendance, 'unknown'); assert.equal(fresh.recognized, null);
  assert.deepEqual(f.counts(), { admissions: 0, acquired: 1, released: 1, created: 1, disposed: 1 });
  inspectPlaybackTerminationProof(prepared.terminationProof!(), f.claim);
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.equal(f.school.counts().reports, 3);
});

test('unknown Readystream acknowledgement never emits success, retries or frees the possibly active lease', async () => {
  const f = await worker(); f.school.setAck(false);
  f.setPlay(async (input, supplied) => { input.observe(observation); await input.report('playing', supplied); return ended; });
  const prepared = await f.prepare();
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_REPORT_UNKNOWN' });
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.equal(f.school.counts().reports, 1); assert.equal(f.school.counts().starts, 0);
  assert.deepEqual(f.acknowledgements, []); assert.equal(f.counts().released, 0); assert.equal(f.counts().disposed, 1);
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).recognized, null);
});

test('trusted worker still rejects unproven course, media, identity and enrollment before admission or execution', async () => {
  for (const mode of ['legacy', 'unknown', 'slides', 'duration', 'foreign', 'identity', 'enrollment']) {
    const f = await worker();
    if (mode === 'legacy') f.school.setPureCanvas(false);
    if (mode === 'unknown') f.school.setPureCanvas(null);
    if (mode === 'slides') f.school.setXml(readystreamXml().replace('</story>', '<slides/></story>'));
    if (mode === 'duration') f.school.setXml(readystreamXml('synthetic-video', 601));
    if (mode === 'foreign') f.school.setXml(readystreamXml('other-video'));
    if (mode === 'identity') f.school.setProfile(false);
    if (mode === 'enrollment') f.school.setOwned(false);
    await assert.rejects(f.admit(), undefined, mode);
    assert.deepEqual(f.counts(), { admissions: 0, acquired: 0, released: 0, created: 0, disposed: 0 }, mode);
    assert.equal(f.school.counts().reports, 0, mode); assert.equal(f.school.counts().starts, 0, mode);
  }
});

test('Readystream owner lease conflict and changed school generation prevent every school report', async () => {
  const conflict = await worker(); conflict.conflict();
  await assert.rejects(conflict.prepare(), { code: 'PLAYBACK_BUSY' });
  assert.equal(conflict.counts().created, 0); assert.equal(conflict.counts().released, 0);
  assert.equal(conflict.school.counts().reports, 0);
  const changed = await worker(); const prepared = await changed.prepare(); changed.school.reset();
  await assert.rejects(changed.adapter.play(prepared, signal()), { code: 'SCHOOL_AUTH_REQUIRED' });
  assert.equal(changed.school.counts().reports, 0); assert.deepEqual(changed.acknowledgements, []);
});

test('Readystream admission and execution cannot borrow another owner, target or revoked claim', async () => {
  const f = await worker();
  await assert.rejects(f.adapter.authorizePlayback({ userId: randomUUID() }, target,
    { signal: signal(), validate: noop }), { code: 'SCHOOL_AUTH_REQUIRED' });
  await assert.rejects(f.adapter.preparePlayback({ userId: f.claim.userId, claim: f.claim },
    { ...target, lectureId: '21' }, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  f.revoke(); await assert.rejects(f.prepare(), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.deepEqual(f.counts(), { admissions: 0, acquired: 0, released: 0, created: 0, disposed: 0 });
  assert.equal(f.school.counts().reports, 0); assert.deepEqual(f.acknowledgements, []);
});

test('a throwing acknowledged-report observer cannot change authority, terminal cleanup or school results', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = await worker({ acknowledge: () => { throw new Error('synthetic telemetry error'); } });
  f.setPlay(async (input, supplied) => {
    input.observe(observation); await input.report('playing', supplied);
    for (let second = 1; second <= 600; second++) {
      now = second * 1_000;
      input.observe({ ...observation, positionSeconds: second, ended: second === 600, paused: second === 600 });
    }
    await input.report('ended', supplied); return ended;
  });
  const prepared = await f.prepare(); await f.adapter.play(prepared, signal());
  assert.equal(f.school.counts().reports, 2); assert.equal(f.counts().released, 1); assert.equal(f.counts().disposed, 1);
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).progressPercent, 100);
  assert.equal(f.acknowledgements.length, 2);
});
