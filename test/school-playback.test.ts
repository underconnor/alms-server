import { inspectPlaybackTerminationProof } from '../src/playback-termination.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.js';
import { SchoolVideoReportError } from '@alms/ssu-api';
import { rememberVideoReportPreparation, videoReportDiagnostic, type workerVideoReportDiagnostic } from '../src/video-report-diagnostics.js';
import { createSchoolPlayback, type SchoolPlaybackClaim, type SchoolPlaybackInput } from '../src/school-playback.js';
import type { PreparedSchoolVideo } from '../src/school-video-session.js';
import type { PlaybackLeaseScope } from '../src/manual-video-lease.js';
import type { SchoolResult } from '../src/domain.js';

const signal = () => AbortSignal.timeout(5000), noop = async () => {};
const schoolResult: SchoolResult = { observedAt: '2026-01-01T00:00:00Z', progressPercent: 100, attendance: 'unknown', recognized: null };
const observed = { positionSeconds: 0, durationSeconds: 600, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
const evidence = { ended: true as const, browserClosed: true as const, processExited: true as const };
function fixture(reportFailure?: (diagnostic: ReturnType<typeof workerVideoReportDiagnostic>) => void) {
  const claim: SchoolPlaybackClaim = { jobId: randomUUID(), userId: randomUUID(), courseId: '10', lectureId: '20',
    acceptedGeneration: randomUUID(), executionTokenHash: 'a'.repeat(64) };
  const target = { courseId: claim.courseId, lectureId: claim.lectureId }, context = { userId: claim.userId, claim };
  let generation = claim.acceptedGeneration, browserLoggedIn = true, current = true, status = 'running', finalChecks = 0, leaseAvailable = true, leaseCurrent = true, closed = false;
  let prepareCalls = 0, mediaCalls = 0, freshCalls = 0, observeCalls = 0, reportCalls = 0, disposeCalls = 0, releaseCalls = 0;
  let input: SchoolPlaybackInput | undefined, acquired: PlaybackLeaseScope | undefined;
  let reportHook = async (_event: string, _signal: AbortSignal) => {};
  const diagnostics: ReturnType<typeof workerVideoReportDiagnostic>[] = [];
  let playHook = async (value: SchoolPlaybackInput, running: AbortSignal) => {
    value.observe(observed); await value.report('playing', running);
    value.observe({ ...observed, positionSeconds: 600, ended: true, paused: true }); await value.report('ended', running); return evidence;
  };
  let disposeHook = async () => {}, transport: 'acknowledged' | 'unknown' = 'acknowledged', reportState: 'ready' | 'closed' | null = null;
  const validate = async (provided: SchoolPlaybackClaim, supplied: AbortSignal) => {
    supplied.throwIfAborted(); assert.deepEqual(provided, claim);
    if (!current) throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', 'changed');
    // Deliberately no ALMS session dependency: a browser logout is not a worker revocation.
  };
  const driver: PreparedSchoolVideo = {
    generation, encryptedSession: 'synthetic-private-envelope', baseline: 80, durationSeconds: 600,
    validate: async supplied => { supplied.throwIfAborted(); if (generation !== claim.acceptedGeneration) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'changed'); },
    authority: async (guard, supplied) => { await guard(); await driver.validate(supplied); return { generation, encryptedSession: 'synthetic-private-envelope' }; },
    prepareMedia: async (guard, supplied) => { await guard(); await driver.validate(supplied); mediaCalls++; return { contentId: 'synthetic',
      mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents/ssu1000001/synthetic/contents/media_files/video.mp4', validate: noop }; },
    readFresh: async (guard, supplied) => { await guard(); await driver.validate(supplied); freshCalls++; return schoolResult; },
    observe: () => { if (closed) throw new Error('closed'); observeCalls++; },
    report: async (event, guard, supplied) => { await guard(); reportCalls++; await reportHook(event, supplied); supplied.throwIfAborted();
      return { transport, school: schoolResult, state: reportState ?? (event === 'ended' || transport === 'unknown' ? 'closed' : 'ready') }; },
    close: () => { closed = true; },
  };
  const adapter = createSchoolPlayback({
    school: { prepare: async (scope, guard, supplied, expected) => {
      prepareCalls++; assert.deepEqual(scope, { owner: claim.userId, courseId: '10', moduleItemId: '20' });
      await guard(); if (expected !== undefined && expected !== generation) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'changed');
      await driver.validate(supplied); return driver;
    } },
    leases: { acquire: async (scope, authorization, supplied) => {
      supplied.throwIfAborted(); assert.deepEqual(authorization, { encryptedSession: 'synthetic-private-envelope' });
      assert.equal(scope.kind, 'worker'); acquired = scope; return leaseAvailable;
    }, renew: async (scope, supplied) => { supplied.throwIfAborted(); assert.deepEqual(scope, acquired); return leaseCurrent; },
    release: async (scope, supplied) => { supplied.throwIfAborted(); assert.deepEqual(scope, acquired); releaseCalls++; } },
    runtime: { createSource: value => { input = value; return value; }, play: (value, supplied) => playHook(value, supplied),
      dispose: async () => { disposeCalls++; await disposeHook(); } },
    validateClaim: async (claim, supplied) => { await validate(claim, supplied); if (status !== 'running') throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', 'not executing'); },
    validateFinalClaim: async (claim, supplied) => { await validate(claim, supplied); finalChecks++; if (!['running', 'reconciling', 'cancel_requested'].includes(status)) throw new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', 'not reconciling'); },
    createAdmission: (scope, value) => { assert.deepEqual(scope, { userId: claim.userId, ...target }); assert.equal(value.generation, generation); return { kind: 'admission' as const }; },
    createFinalProof: (scope, value) => { assert.deepEqual(scope, claim); assert.equal(value.generation, generation); return { kind: 'final' as const }; },
    reportFailure: diagnostic => { diagnostics.push(diagnostic); reportFailure?.(diagnostic); },
  });
  return { adapter, claim, target, context, driver, diagnostics, input: () => input!, counts: () => ({ prepareCalls, mediaCalls, freshCalls, observeCalls, reportCalls, disposeCalls, releaseCalls }),
    prepare: () => adapter.preparePlayback(context, target, signal()), browserLoggedIn: () => browserLoggedIn,
    logout: () => { browserLoggedIn = false; }, reauthenticate: () => { generation = randomUUID(); }, revoke: () => { current = false; }, setStatus: (value: string) => { status = value; }, finalChecks: () => finalChecks,
    conflict: () => { leaseAvailable = false; }, loseLease: () => { leaseCurrent = false; },
    unknown: () => { transport = 'unknown'; }, playWith: (hook: typeof playHook) => { playHook = hook; },
    setReportState: (value: 'ready' | 'closed') => { reportState = value; },
    reportWith: (hook: typeof reportHook) => { reportHook = hook; }, disposeWith: (hook: typeof disposeHook) => { disposeHook = hook; },
  };
}
test('admission checks school and supported media without acquiring a lease or starting reports', async () => {
  const f = fixture(), proof = await f.adapter.authorizePlayback({ userId: f.claim.userId }, f.target, { signal: signal(), validate: noop });
  assert.deepEqual(proof, { kind: 'admission' }); assert.equal(f.counts().mediaCalls, 1); assert.equal(f.counts().reportCalls, 0);
  assert.equal(f.counts().disposeCalls, 0); assert.equal(f.counts().releaseCalls, 0);
});
test('owner, target and accepted generation are immutable worker preparation requirements', async () => {
  for (const field of ['userId','courseId','lectureId']) {
    const f = fixture(); await assert.rejects(f.adapter.preparePlayback({ ...f.context, claim: { ...f.claim, [field]: 'other' } }, f.target, signal()));
    assert.equal(f.counts().prepareCalls, 0);
  }
  const f = fixture(); f.reauthenticate(); await assert.rejects(f.prepare(), { code: 'SCHOOL_AUTH_REQUIRED' }); assert.equal(f.counts().reportCalls, 0);
});
test('browser logout preserves the accepted worker claim and explicit ended stays distinct from school recognition', async () => {
  const f = fixture(), prepared = await f.prepare(); f.logout(); assert.equal(f.browserLoggedIn(), false);
  await f.adapter.play(prepared, signal()); const result = await f.adapter.playbackLearningStatus(prepared, signal());
  assert.equal(result.recognized, null); assert.equal(prepared.alreadyRecognized, false);
  await prepared.dispose(); await prepared.dispose(); assert.equal(f.counts().releaseCalls, 1); assert.equal(f.counts().disposeCalls, 1);
  assert.deepEqual(await f.adapter.validatePlayback(prepared, signal()), { kind: 'final' });
  assert.deepEqual(f.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(prepared), /synthetic-private|https|generation|token|userId/);
});
test('disposed playback can read same-generation results but cannot cross a new login or revoked claim', async () => {
  const f = fixture(), prepared = await f.prepare(); await prepared.dispose();
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).recognized, null);
  f.reauthenticate(); await assert.rejects(f.adapter.playbackLearningStatus(prepared, signal()), { code: 'SCHOOL_AUTH_REQUIRED' });
  await assert.rejects(f.adapter.validatePlayback(prepared, signal()), { code: 'SCHOOL_AUTH_REQUIRED' });
  const g = fixture(), other = await g.prepare(); await other.dispose(); g.revoke();
  await assert.rejects(g.adapter.validatePlayback(other, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
});
test('a shared lease conflict never starts runtime or reports and never releases the other holder', async () => {
  const f = fixture(); f.conflict(); await assert.rejects(f.prepare(), { code: 'PLAYBACK_BUSY' });
  assert.equal(f.counts().reportCalls, 0); assert.equal(f.counts().releaseCalls, 0); assert.equal(f.counts().disposeCalls, 0);
});
test('lost claim or lease aborts before playback and report starts', async () => {
  for (const mode of ['claim','lease']) {
    const f = fixture(), prepared = await f.prepare(); mode === 'claim' ? f.revoke() : f.loseLease();
    await assert.rejects(f.adapter.play(prepared, signal())); assert.equal(f.counts().reportCalls, 0); assert.equal(f.counts().disposeCalls, 1);
  }
});
test('runtime ended alone cannot substitute for an acknowledged actual ended report', async () => {
  const f = fixture(), prepared = await f.prepare(); f.playWith(async () => evidence);
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_CLEANUP_FAILED' });
  assert.equal(f.counts().reportCalls, 0);
});
test('unknown school acknowledgement preserves the lease and permits only a later fresh read', async () => {
  const f = fixture(), prepared = await f.prepare(); f.unknown();
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_REPORT_UNKNOWN' });
  assert.equal(f.counts().reportCalls, 1); assert.equal(f.counts().releaseCalls, 0);
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).recognized, null);
  await assert.rejects(f.adapter.play(prepared, signal())); assert.equal(f.counts().reportCalls, 1);
  assert.deepEqual(f.diagnostics, [{ event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'post_report', code: 'unknown', mayHaveWritten: true,
    outcome: { reason:'transport_unknown', transport:'unknown', controllerPhase:'closed', transmissionCode:'unknown',
      publishedStillTrue:null, openedStillTrue:null, omitProgressStillFalse:null, durationExactlyMatches:null } }]);
});

test('acknowledged nonterminal closure and unclosed terminal stay uncertain with distinct fixed reasons', async () => {
  for (const event of ['playing','ended'] as const) {
    const f=fixture(), prepared=await f.prepare(); f.setReportState(event==='playing'?'closed':'ready');
    f.playWith(async (input,running)=>{input.observe(observed);await input.report(event,running);return evidence;});
    await assert.rejects(f.adapter.play(prepared,signal()),{code:'PLAYBACK_REPORT_UNKNOWN'});
    assert.equal(f.counts().reportCalls,1);assert.equal(f.counts().releaseCalls,0);assert.equal(f.counts().disposeCalls,1);
    assert.equal(f.diagnostics.length,1);assert.equal(f.diagnostics[0]!.mayHaveWritten,true);
    assert.deepEqual(f.diagnostics[0]!.outcome,{reason:event==='playing'?'nonterminal_controller_closed':'terminal_controller_open',
      transport:'acknowledged',controllerPhase:event==='playing'?'closed':'ready',transmissionCode:'none',
      publishedStillTrue:null,openedStillTrue:null,omitProgressStillFalse:null,durationExactlyMatches:null});
    await assert.rejects(f.adapter.play(prepared,signal()));assert.equal(f.counts().reportCalls,1);
  }
});

test('one periodic report failure preserves sanitized SDK evidence through runtime normalization and cleanup', async () => {
  const f = fixture(), prepared = await f.prepare();
  const source = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  Object.assign(source, { url: 'https://private.invalid/?token=private-token', body: 'private-body', cause: new Error('private-stack') });
  const context = { event: 'update' as const, controllerPhase: 'ready' as const, controllerAttempt: 'previous' as const,
    observationState: 'playing' as const, positionDelta: 'advanced' as const };
  rememberVideoReportPreparation(source, 'manual_event', true, context);
  f.reportWith(async event => { if (event === 'update') throw source; });
  f.playWith(async (input, running) => {
    input.observe(observed); await input.report('playing', running);
    try { await input.report('update', running); } catch { throw new Error('REPORT_FAILED'); }
    return evidence;
  });
  await assert.rejects(f.adapter.play(prepared, signal()), error => {
    assert.equal((error as AppError).code, 'PLAYBACK_REPORT_UNKNOWN');
    assert.deepEqual(videoReportDiagnostic(error), { stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true, context });
    assert.doesNotMatch(JSON.stringify(error), /private|refresh|context/); return true;
  });
  assert.deepEqual(f.diagnostics, [{ event: 'worker_video_report_failed', reportEvent: 'update', stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true, context }]);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private|token|url|body|stack|userId|courseId|jobId/);
  assert.equal(f.counts().reportCalls, 2); assert.equal(f.counts().disposeCalls, 1); assert.equal(f.counts().releaseCalls, 0);
  await prepared.dispose(); assert.equal(f.diagnostics.length, 1);
});

test('an unsent baseline conflict remains conservative while its false possible-write fact survives', async () => {
  const f = fixture(), prepared = await f.prepare();
  const source = new AppError(409, 'PLAYBACK_OBSERVATION_INVALID', 'private-message');
  rememberVideoReportPreparation(source, 'baseline', false);
  f.reportWith(async () => { throw source; });
  await assert.rejects(f.adapter.play(prepared, signal()), error => {
    assert.equal((error as AppError).code, 'PLAYBACK_REPORT_UNKNOWN');
    assert.deepEqual(videoReportDiagnostic(error), { stage: 'baseline', code: 'PLAYBACK_OBSERVATION_INVALID', mayHaveWritten: false }); return true;
  });
  assert.deepEqual(f.diagnostics, [{ event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'baseline', code: 'PLAYBACK_OBSERVATION_INVALID', mayHaveWritten: false }]);
  assert.equal(f.counts().reportCalls, 1); assert.equal(f.counts().releaseCalls, 0);
});

test('a throwing diagnostic observer cannot alter report uncertainty or runtime cleanup', async () => {
  const f = fixture(() => { throw new Error('observer failed'); }), prepared = await f.prepare();
  f.reportWith(async () => { throw new SchoolVideoReportError('unexpected_response', 'transmission', true); });
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_REPORT_UNKNOWN' });
  assert.equal(f.diagnostics.length, 1); assert.equal(f.counts().reportCalls, 1);
  assert.equal(f.counts().disposeCalls, 1); assert.equal(f.counts().releaseCalls, 0);
});
test('observations continue during one pending report while a second report is rejected', async () => {
  const f = fixture(), prepared = await f.prepare(); let release!: () => void;
  f.reportWith(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.input().report('playing', signal());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.input().observe(observed); await assert.rejects(f.input().report('update', signal()));
  release(); await first; assert.equal(f.counts().reportCalls, 1); assert.equal(f.counts().observeCalls, 1);
  await prepared.dispose();
});
test('cancellation aborts report signal immediately and retains the uncertain shared lease', async () => {
  const f = fixture(), prepared = await f.prepare(); let reportSignal: AbortSignal | undefined;
  f.reportWith((_event, supplied) => { reportSignal = supplied; return new Promise<void>((_resolve, reject) => supplied.addEventListener('abort', () => reject(supplied.reason), { once: true })); });
  const first = f.input().report('playing', signal()); const rejected = assert.rejects(first);
  while (!reportSignal) await new Promise(resolve => setImmediate(resolve));
  await prepared.dispose(); assert.equal(reportSignal.aborted, true); await rejected;
  assert.equal(f.counts().releaseCalls, 0); assert.equal(f.counts().disposeCalls, 1);
});
test('failed runtime cleanup remains a rejection and cannot release the execution lease', async () => {
  const f = fixture(), prepared = await f.prepare(); f.disposeWith(async () => { throw new Error('unconfirmed'); });
  await assert.rejects(prepared.dispose(), { code: 'PLAYBACK_CLEANUP_FAILED' });
  await assert.rejects(prepared.dispose(), { code: 'PLAYBACK_CLEANUP_FAILED' }); assert.equal(f.counts().releaseCalls, 0);
});
test('authentication failure after entering a report remains uncertain without retrying', async () => {
  const f = fixture(), prepared = await f.prepare();
  f.reportWith(async () => { throw { code: 'authentication_required' }; });
  f.playWith(async (input, running) => {
    try { await input.report('playing', running); } catch { throw new Error('REPORT_FAILED'); }
    return evidence;
  });
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_REPORT_UNKNOWN' }); assert.equal(f.counts().reportCalls, 1);
});

test('worker adapter reuses the real SDK school preparation and report path without a browser session', async () => {
  const { fixture: schoolFixture, context: scope } = await import('./helpers/school-video-fixture.js');
  const f = await schoolFixture();
  const claim: SchoolPlaybackClaim = { jobId: randomUUID(), userId: scope.owner, courseId: scope.courseId, lectureId: scope.moduleItemId,
    acceptedGeneration: f.generation(), executionTokenHash: 'c'.repeat(64) };
  let released = 0, admissions = 0;
  const adapter = createSchoolPlayback({ school: f.sessions,
    validateClaim: async (value, supplied) => { supplied.throwIfAborted(); assert.deepEqual(value, claim); },
    validateFinalClaim: async (value, supplied) => { supplied.throwIfAborted(); assert.deepEqual(value, claim); },
    createAdmission: () => { admissions++; return {}; }, createFinalProof: (value, proof) => {
      assert.deepEqual(value, claim); assert.equal(proof.generation, f.generation()); assert.equal(proof.encryptedSession, f.encrypted()); return { valid: true };
    },
    leases: { acquire: async (value, proof) => { assert.equal(value.kind, 'worker'); assert.equal(proof.almsTokenHash, undefined);
      assert.equal(proof.encryptedSession, f.encrypted()); return true; }, renew: async () => true, release: async () => { released++; } },
    runtime: { createSource: (value: SchoolPlaybackInput) => value,
      play: async (value, supplied) => { value.observe(observed); await value.report('playing', supplied); throw new AppError(499, 'TEST_STOP', 'synthetic stop'); },
      dispose: async () => {} },
  });
  const prepared = await adapter.preparePlayback({ userId: claim.userId, claim }, { courseId: claim.courseId, lectureId: claim.lectureId }, signal());
  assert.equal(f.counts().requests, 9); assert.equal(f.counts().reports, 0);
  await assert.rejects(adapter.play(prepared, signal()), { code: 'TEST_STOP' });
  assert.equal(f.counts().reports, 1); assert.equal(f.counts().invalidated, 1); assert.equal(released, 1);
  const result = await adapter.playbackLearningStatus(prepared, signal()); assert.equal(result.recognized, null);
  assert.deepEqual(await adapter.validatePlayback(prepared, signal()), { valid: true }); assert.equal(admissions, 0);
  assert.equal(f.counts().reports, 1);
});

test('a local controller close failure still stops runtime and cannot release its lease', async () => {
  const f = fixture(), prepared = await f.prepare(); f.driver.close = () => { throw new Error('close failed'); };
  await assert.rejects(prepared.dispose(), { code: 'PLAYBACK_CLEANUP_FAILED' });
  assert.equal(f.counts().disposeCalls, 1); assert.equal(f.counts().releaseCalls, 0);
});

test('prepared school handles resolving after caller cancellation are closed before media or lease work', async () => {
  const f = fixture(), controller = new AbortController(); let release!: (value: PreparedSchoolVideo) => void;
  let closed = 0, media = 0, lease = 0;
  const driver = { ...f.driver, close: () => { closed++; }, prepareMedia: async () => { media++; throw new Error('late media'); } };
  const adapter = createSchoolPlayback({ school: { prepare: () => new Promise<PreparedSchoolVideo>(resolve => { release = resolve; }) },
    leases: { acquire: async () => { lease++; return true; }, renew: async () => true, release: noop },
    runtime: { createSource: (value: SchoolPlaybackInput) => value, play: async () => evidence, dispose: noop },
    validateClaim: noop, validateFinalClaim: noop, createAdmission: () => ({}), createFinalProof: () => ({}) });
  const pending = adapter.preparePlayback(f.context, f.target, controller.signal); const rejected = assert.rejects(pending);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected; release(driver); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(media, 0); assert.equal(lease, 0);
});

test('runtime error normalization does not hide the original claim loss', async () => {
  const f = fixture(), prepared = await f.prepare();
  f.playWith(async (input, running) => {
    f.revoke();
    try { await input.validate(running); } catch { throw new Error('GUARD_FAILED'); }
    return evidence;
  });
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
});

test('proven school authentication failure before reporting requests reauthentication', async () => {
  const f = fixture(), prepared = await f.prepare();
  f.driver.authority = async () => { throw { code: 'authentication_required' }; };
  await assert.rejects(f.adapter.play(prepared, signal()), { code: 'SCHOOL_AUTH_REQUIRED' }); assert.equal(f.counts().reportCalls, 0);
});

test('cancel_requested never authorizes a new school report but allows read-only reconciliation after disposal', async () => {
  const f = fixture(), prepared = await f.prepare(); f.setStatus('cancel_requested');
  await assert.rejects(f.input().report('playing', signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.equal(f.counts().reportCalls, 0); assert.equal(f.finalChecks(), 0);
  await assert.rejects(f.adapter.playbackLearningStatus(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  await prepared.dispose();
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).recognized, null);
  await f.adapter.validatePlayback(prepared, signal()); assert.ok(f.finalChecks() > 0);
  await assert.rejects(f.input().report('playing', signal())); assert.throws(() => f.input().observe(observed));
  assert.equal(f.counts().reportCalls, 0);
});
test('normal play closes execution before the runner enters reconciliation', async () => {
  const f = fixture(), prepared = await f.prepare(); await f.adapter.play(prepared, signal());
  assert.equal(f.counts().disposeCalls, 1); f.setStatus('reconciling');
  await f.adapter.validatePlayback(prepared, signal());
  assert.equal((await f.adapter.playbackLearningStatus(prepared, signal())).recognized, null);
  await assert.rejects(f.input().report('update', signal())); assert.equal(f.counts().reportCalls, 2);
});
test('unconfirmed runtime cleanup cannot use final-only authority', async () => {
  const f = fixture(), prepared = await f.prepare(); f.disposeWith(async () => { throw new Error('still alive'); });
  await assert.rejects(prepared.dispose()); f.setStatus('cancel_requested');
  await assert.rejects(f.adapter.validatePlayback(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  await assert.rejects(f.adapter.playbackLearningStatus(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  assert.equal(f.finalChecks(), 0);
});

test('periodic validation remains strict while cleanup is still settling', async () => {
  const f = fixture(), prepared = await f.prepare(); let finish!: () => void;
  f.disposeWith(() => new Promise<void>(resolve => { finish = resolve; }));
  const playing = f.adapter.play(prepared, signal());
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.adapter.validatePlayback(prepared, signal()); assert.equal(f.finalChecks(), 0);
  await assert.rejects(f.adapter.playbackLearningStatus(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  f.setStatus('reconciling');
  await assert.rejects(f.adapter.validatePlayback(prepared, signal()), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
  finish(); await playing;
  await f.adapter.validatePlayback(prepared, signal()); assert.ok(f.finalChecks() > 0);
});


test('termination proof is exact-claim, opaque and requires confirmed shutdown', async () => {
  const f = fixture(), prepared = await f.prepare();
  assert.equal(prepared.terminationProof?.(), null);
  await f.adapter.play(prepared, signal());
  const proof = prepared.terminationProof?.(); assert.ok(proof);
  assert.ok(inspectPlaybackTerminationProof(proof, f.claim));
  assert.throws(() => inspectPlaybackTerminationProof(proof, { ...f.claim, executionTokenHash: 'b'.repeat(64) }), {code:'JOB_SETTLEMENT_UNSAFE'});
  assert.equal(JSON.stringify(proof).includes(f.claim.jobId), false);
  assert.equal(prepared.terminationProof?.(), proof);
  await assert.rejects(f.input().report('playing', signal()));
});

test('unknown school acknowledgement still permits termination evidence only after runtime closure', async () => {
  const f = fixture(), prepared = await f.prepare(); f.unknown();
  await assert.rejects(f.adapter.play(prepared, signal()));
  assert.ok(prepared.terminationProof?.()); assert.equal(f.counts().releaseCalls, 0);
});

test('a report that outlives its bounded caller blocks termination proof until actual callback drains', async () => {
  const f = fixture(), prepared = await f.prepare(); let release!: () => void;
  f.reportWith(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.input().report('playing', signal()); const rejected = assert.rejects(pending);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await prepared.dispose(); await rejected;
  assert.equal(prepared.terminationProof?.(), null);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(prepared.terminationProof?.()); assert.equal(f.counts().releaseCalls, 0);
});

test('unsettled runtime play blocks proof even when dispose claims success', async () => {
  const f = fixture(), prepared = await f.prepare(); let finish!: () => void;
  f.playWith(() => new Promise<typeof evidence>(resolve => { finish = () => resolve(evidence); }));
  const playing = f.adapter.play(prepared, signal()); const rejected = assert.rejects(playing);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await prepared.dispose(); assert.equal(prepared.terminationProof?.(), null);
  finish(); await rejected; assert.ok(prepared.terminationProof?.());
});

test('runtime or driver cleanup failure never produces termination proof', async () => {
  for (const stage of ['runtime','driver']) {
    const f = fixture(), prepared = await f.prepare();
    if (stage === 'runtime') f.disposeWith(async () => { throw new Error('still running'); });
    else f.driver.close = () => { throw new Error('not closed'); };
    await assert.rejects(prepared.dispose()); assert.equal(prepared.terminationProof?.(), null);
  }
});
