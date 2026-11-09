import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, SchoolVideoReportError } from '@alms/ssu-api';
import { AppError } from '../src/errors.js';
import { videoReportDiagnostic, rememberVideoReportDiagnostic, rememberVideoReportPreparation, workerVideoReportDiagnostic,
  rememberVideoReportResult, rememberVideoReportOutcomeFailure, rememberVideoReportTransmission, rememberVideoRuntimeFailure,
  rememberVideoReportFailureContext } from '../src/video-report-diagnostics.js';
test('school report stage and possible write survive normalization without source data', () => {
  const source = new SchoolVideoReportError('unexpected_response','refresh',true);
  Object.assign(source,{ url:'https://private.invalid/?token=secret',body:'private',cause:new Error('secret') });
  const exposed = new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');
  rememberVideoReportDiagnostic(exposed,source);
  assert.deepEqual(videoReportDiagnostic(exposed),{stage:'refresh',code:'unexpected_response',mayHaveWritten:true});
  assert.equal(JSON.stringify(videoReportDiagnostic(exposed)).includes('secret'),false);
  assert.equal(JSON.stringify(exposed).includes('refresh'),false);
});
test('unrecognized objects cannot inject diagnostics or payloads into logs', () => {
  assert.deepEqual(videoReportDiagnostic({code:'secret',stage:'secret',mayHaveWritten:true}),{stage:'unknown',code:'unknown',mayHaveWritten:null});
  assert.deepEqual(videoReportDiagnostic(new SchoolError('unsupported')),{stage:'unknown',code:'unsupported',mayHaveWritten:null});
  assert.deepEqual(videoReportDiagnostic(new AppError(409,'PLAYBACK_OBSERVATION_INVALID','private')),{stage:'unknown',code:'PLAYBACK_OBSERVATION_INVALID',mayHaveWritten:null});
});

test('worker diagnostic envelope permits only fixed report events and copies no arbitrary source fields', () => {
  const result = workerVideoReportDiagnostic({ code: 'private-code', event: 'private-event', url: 'private-url', cause: 'private-cause' }, 'private-event' as any);
  assert.deepEqual(result, { event: 'worker_video_report_failed', reportEvent: 'unknown', stage: 'unknown', code: 'unknown', mayHaveWritten: null });
  assert.equal(Object.isFrozen(result), true); assert.doesNotMatch(JSON.stringify(result), /private|url|cause/);
});

test('even modified library errors cannot inject arbitrary stage or write fields', () => {
  const source = new SchoolVideoReportError('unsupported','validation',false);
  Object.assign(source,{ stage:'https://private.invalid/secret',mayHaveWritten:'secret' });
  assert.deepEqual(videoReportDiagnostic(source),{stage:'unknown',code:'unsupported',mayHaveWritten:null});
});


test('preflight diagnostics allowlist and copy fixed context without serializing source values', () => {
  const error = new SchoolError('unsupported');
  const context = { event: 'update' as const, controllerPhase: 'ready' as const, controllerAttempt: 'none' as const,
    observationState: 'playing' as const, positionDelta: 'advanced' as const, rawUrl: 'private-url', position: 123.456 };
  rememberVideoReportPreparation(error, 'manual_event', false, context);
  const exposed = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoReportDiagnostic(exposed, error);
  Object.assign(context, { event: 'private-payload' });
  assert.deepEqual(videoReportDiagnostic(exposed), { stage: 'manual_event', code: 'unsupported', mayHaveWritten: false,
    context: { event: 'update', controllerPhase: 'ready', controllerAttempt: 'none', observationState: 'playing', positionDelta: 'advanced' } });
  assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(exposed)), /private|123/);
  assert.doesNotMatch(JSON.stringify(exposed), /manual_event|context/);
});

test('invalid preflight stages and context cannot inject arbitrary diagnostic fields', () => {
  const error = new SchoolError('unsupported');
  rememberVideoReportPreparation(error, 'private-stage' as any, 'private-write' as any, {
    event: 'private-event', controllerPhase: 'ready', controllerAttempt: 'none', observationState: 'playing', positionDelta: 'advanced',
  } as any);
  assert.deepEqual(videoReportDiagnostic(error), { stage: 'unknown', code: 'unsupported', mayHaveWritten: null });
});

test('SDK validation and possible writes cannot be overwritten by a preflight fallback', () => {
  const error = new SchoolVideoReportError('unexpected_response', 'refresh', true);
  rememberVideoReportPreparation(error, 'manual_event', false);
  assert.deepEqual(videoReportDiagnostic(error), { stage: 'refresh', code: 'unexpected_response', mayHaveWritten: true });
  const before = new SchoolVideoReportError('unsupported', 'validation', false);
  rememberVideoReportPreparation(before, 'manual_event', false);
  assert.deepEqual(videoReportDiagnostic(before), { stage: 'validation', code: 'unsupported', mayHaveWritten: false });
});

test('post-report facts are copied privately and remain fixed through error normalization', () => {
  const result={transport:'unknown' as const,state:'closed' as const,url:'private-url',school:{body:'private-body'}};
  const facts={controllerPhase:'closed' as const,transmissionCode:'authentication_required' as const,
    publishedStillTrue:true,openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true,body:'private-body'};
  rememberVideoReportResult(result,facts);Object.assign(facts,{transmissionCode:'private-code',openedStillTrue:false});
  const error=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');rememberVideoReportPreparation(error,'post_report',true);
  rememberVideoReportOutcomeFailure(error,result,'transport_unknown');
  rememberVideoReportPreparation(error,'manual_event',false);
  const exposed=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');rememberVideoReportDiagnostic(exposed,error);
  assert.deepEqual(videoReportDiagnostic(exposed),{stage:'post_report',code:'unknown',mayHaveWritten:true,
    outcome:{reason:'transport_unknown',transport:'unknown',controllerPhase:'closed',transmissionCode:'authentication_required',
      publishedStillTrue:true,openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true}});
  assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(exposed)),/private|url|body/);
  assert.doesNotMatch(JSON.stringify(exposed),/outcome|transmissionCode/);
});

test('untrusted result fields and malformed private facts cannot inject diagnostic values', () => {
  const result={transport:'unknown' as const,state:'closed' as const,controllerPhase:'private',transmissionCode:'private'};
  const error=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');rememberVideoReportPreparation(error,'post_report',true);
  rememberVideoReportResult(result,{controllerPhase:'private',transmissionCode:'private',publishedStillTrue:'private',
    openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true} as any);
  rememberVideoReportOutcomeFailure(error,result,'transport_unknown');
  assert.equal(videoReportDiagnostic(error).outcome?.controllerPhase,'closed');
  assert.equal(videoReportDiagnostic(error).outcome?.transmissionCode,'unknown');
  assert.equal(videoReportDiagnostic(error).outcome?.publishedStillTrue,null);
  assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(error)),/private/);
  const ignored=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');
  rememberVideoReportOutcomeFailure(ignored,{transport:'private',state:'closed'} as any,'private' as any);
  assert.equal(videoReportDiagnostic(ignored).outcome,undefined);
});

test('response failure classification is copied only from private allowlisted result facts', () => {
  for(const responseFailure of ['ack_result_rejected','content_type','private-response'] as const){
    const result={transport:'unknown' as const,state:'closed' as const,responseFailure:'private-injected'};
    const facts={controllerPhase:'closed' as const,transmissionCode:'unexpected_response' as const,publishedStillTrue:true,
      openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true,responseFailure};
    rememberVideoReportResult(result,facts as any);Object.assign(facts,{responseFailure:'private-mutated'});
    const error=new AppError(503,'PLAYBACK_REPORT_UNKNOWN','fixed');rememberVideoReportPreparation(error,'post_report',true);
    rememberVideoReportOutcomeFailure(error,result,'transport_unknown');
    assert.equal(videoReportDiagnostic(error).outcome?.responseFailure,responseFailure==='private-response'?undefined:responseFailure);
    assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(error)),/private/);
  }
});

test('strict transmission facts survive a later refresh failure and normalization as an immutable separate fact', () => {
  const source = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  const facts = { outcome: 'failed' as const, code: 'unexpected_response' as const, responseFailure: 'ack_result_rejected' as const,
    url: 'private-url', body: 'private-body' };
  rememberVideoReportTransmission(source, facts);
  Object.assign(facts, { code: 'private-code', responseFailure: 'private-failure' });
  rememberVideoReportTransmission(source, { outcome: 'acknowledged', code: 'none' });
  rememberVideoReportPreparation(source, 'manual_event', true);
  const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoReportDiagnostic(error, source);
  assert.deepEqual(videoReportDiagnostic(error), { stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true,
    transmission: { outcome: 'failed', code: 'unexpected_response', responseFailure: 'ack_result_rejected' } });
  assert.equal(Object.isFrozen(videoReportDiagnostic(error).transmission), true);
  assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(error)), /private|url|body/);
  assert.doesNotMatch(JSON.stringify(error), /transmission|responseFailure/);
});

test('invalid transmission facts cannot invent an ACK or inject raw values', () => {
  const samples = [
    { outcome: 'private', code: 'none' }, { outcome: 'acknowledged', code: 'unexpected_response' },
    { outcome: 'acknowledged', code: 'none', responseFailure: 'ack_result_rejected' },
    { outcome: 'failed', code: 'none' }, { outcome: 'failed', code: 'private' },
    { outcome: 'failed', code: 'unexpected_response', responseFailure: 'private' },
  ];
  for (const facts of samples) {
    const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
    rememberVideoReportTransmission(error, facts as any);
    assert.equal(videoReportDiagnostic(error).transmission, undefined);
  }
  assert.equal(videoReportDiagnostic({ transmission: { outcome: 'acknowledged', code: 'none' } }).transmission, undefined);
});

test('result normalization keeps a strict ACK fact separate from an unsuccessful post-report outcome', () => {
  const result = { transport: 'acknowledged' as const, state: 'closed' as const };
  rememberVideoReportTransmission(result, { outcome: 'acknowledged', code: 'none' });
  const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
  rememberVideoReportOutcomeFailure(error, result, 'nonterminal_controller_closed');
  assert.deepEqual(videoReportDiagnostic(error).transmission, { outcome: 'acknowledged', code: 'none' });
  assert.equal(videoReportDiagnostic(error).outcome?.reason, 'nonterminal_controller_closed');
  assert.doesNotMatch(JSON.stringify(result), /transmission/);
});

test('first runtime stop is fixed, separate and cannot be overwritten by report normalization', () => {
  const source = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
  rememberVideoRuntimeFailure(error, 'private-runtime-code' as any);
  assert.equal(videoReportDiagnostic(error).runtimeFirstFailure, undefined);
  rememberVideoRuntimeFailure(error, 'MEDIA_INVALID'); rememberVideoRuntimeFailure(error, 'REPORT_FAILED');
  rememberVideoReportDiagnostic(error, source); rememberVideoReportPreparation(error, 'manual_event', true);
  assert.deepEqual(videoReportDiagnostic(error), { stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true,
    runtimeFirstFailure: 'MEDIA_INVALID' });
  assert.equal(videoReportDiagnostic({ runtimeFirstFailure: 'MEDIA_INVALID' }).runtimeFirstFailure, undefined);
  assert.doesNotMatch(JSON.stringify(error), /runtimeFirstFailure/);
});

test('report phase and signal facts are immutable allowlisted snapshots and survive normalization', () => {
  const source = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  const facts = { phase: 'fresh_read' as const, reportSignalAborted: false, lifetimeAborted: false, reason: 'private-reason', url: 'private-url' };
  rememberVideoReportFailureContext(source, facts); Object.assign(facts, { phase: 'private-phase', lifetimeAborted: true });
  rememberVideoReportFailureContext(source, { phase: 'cache_invalidation', reportSignalAborted: true, lifetimeAborted: true });
  const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
  rememberVideoReportDiagnostic(error, source); rememberVideoReportPreparation(error, 'manual_event', true);
  assert.deepEqual(videoReportDiagnostic(error).reportFailure, { phase: 'fresh_read', reportSignalAborted: false, lifetimeAborted: false });
  assert.equal(Object.isFrozen(videoReportDiagnostic(error).reportFailure), true);
  assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(error)), /private|url|reason/);
  assert.doesNotMatch(JSON.stringify(error), /reportFailure|reportSignalAborted/);
  for (const malformed of [{ phase: 'private', reportSignalAborted: false, lifetimeAborted: false },
    { phase: 'fresh_read', reportSignalAborted: 'false', lifetimeAborted: false },
    { phase: ['fresh_read'], reportSignalAborted: false, lifetimeAborted: false }]) {
    const other = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoReportFailureContext(other, malformed as any);
    assert.equal(videoReportDiagnostic(other).reportFailure, undefined);
  }
  assert.equal(videoReportDiagnostic({ reportFailure: { phase: 'fresh_read', reportSignalAborted: false, lifetimeAborted: false } }).reportFailure, undefined);
});

test('runtime origin remains bound to the first runtime code and does not inherit a later source origin', () => {
  const first = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'), later = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  rememberVideoRuntimeFailure(first, 'MEDIA_INVALID', 'observation_rejected');
  rememberVideoRuntimeFailure(first, 'REPORT_FAILED', 'report_failed');
  rememberVideoRuntimeFailure(later, 'GUARD_FAILED', 'periodic_guard_failed');
  rememberVideoReportDiagnostic(first, later); rememberVideoReportPreparation(first, 'manual_event', true);
  assert.equal(videoReportDiagnostic(first).runtimeFirstFailure, 'MEDIA_INVALID');
  assert.equal(videoReportDiagnostic(first).runtimeFirstFailureOrigin, 'observation_rejected');
  const legacy = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoRuntimeFailure(legacy, 'MEDIA_INVALID');
  rememberVideoReportDiagnostic(legacy, later);
  assert.equal(videoReportDiagnostic(legacy).runtimeFirstFailureOrigin, undefined);
  const invalid = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoRuntimeFailure(invalid, 'MEDIA_INVALID', 'private-origin' as any);
  assert.equal(videoReportDiagnostic(invalid).runtimeFirstFailureOrigin, undefined);
});

test('runtime snapshot and SDK observation details stay fixed and bound to their first matching origin', () => {
  const snapshot = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
  rememberVideoRuntimeFailure(snapshot, 'MEDIA_INVALID', 'media_snapshot_invalid', 'sampling_gap', 'pair_progress');
  rememberVideoRuntimeFailure(snapshot, 'MEDIA_INVALID', 'media_snapshot_invalid', 'position_reverse');
  const other = new SchoolVideoReportError('upstream_unavailable', 'refresh', true);
  rememberVideoRuntimeFailure(other, 'MEDIA_INVALID', 'observation_rejected', undefined, 'pair_progress');
  rememberVideoReportDiagnostic(snapshot, other); rememberVideoReportPreparation(snapshot, 'manual_event', true);
  assert.equal(videoReportDiagnostic(snapshot).runtimeSnapshotReason, 'sampling_gap');
  assert.equal(videoReportDiagnostic(snapshot).runtimeObservationFailure, undefined);
  assert.equal(videoReportDiagnostic(snapshot).runtimeFirstFailureOrigin, 'media_snapshot_invalid');
  const normalized = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoReportDiagnostic(normalized, other);
  assert.equal(videoReportDiagnostic(normalized).runtimeObservationFailure, 'pair_progress');
  assert.equal(videoReportDiagnostic(normalized).runtimeSnapshotReason, undefined);
  const legacy = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoRuntimeFailure(legacy, 'MEDIA_INVALID');
  rememberVideoReportDiagnostic(legacy, other); assert.equal(videoReportDiagnostic(legacy).runtimeObservationFailure, undefined);
  assert.equal(videoReportDiagnostic(legacy).runtimeFirstFailureOrigin, undefined);
});

test('unclassified or mismatched runtime details cannot inject diagnostic facts', () => {
  for (const [origin, snapshotReason, observationFailure] of [
    ['other','sampling_gap','pair_progress'], ['media_snapshot_invalid','private-reason','pair_progress'],
    ['observation_rejected','sampling_gap','private-reason'], ['private-origin','sampling_gap','pair_progress'],
  ]) {
    const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed');
    rememberVideoRuntimeFailure(error, 'MEDIA_INVALID', origin as any, snapshotReason as any, observationFailure as any);
    assert.equal(videoReportDiagnostic(error).runtimeSnapshotReason, undefined);
    assert.equal(videoReportDiagnostic(error).runtimeObservationFailure, undefined);
    assert.doesNotMatch(JSON.stringify(videoReportDiagnostic(error)), /private/);
  }
  assert.equal(videoReportDiagnostic({ runtimeSnapshotReason: 'sampling_gap', runtimeObservationFailure: 'pair_progress' }).runtimeSnapshotReason, undefined);
});
