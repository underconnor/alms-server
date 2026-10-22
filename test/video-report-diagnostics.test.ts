import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, SchoolVideoReportError } from '@alms/ssu-api';
import { AppError } from '../src/errors.js';
import { videoReportDiagnostic, rememberVideoReportDiagnostic, rememberVideoReportPreparation, workerVideoReportDiagnostic,
  rememberVideoReportResult, rememberVideoReportOutcomeFailure } from '../src/video-report-diagnostics.js';
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
