import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPlaybackLogProjection } from '../src/playback-log-projection.js';
import { workerVideoReportDiagnostic, rememberVideoReportPreparation, rememberVideoReportTransmission,
  rememberVideoRuntimeFailure } from '../src/video-report-diagnostics.js';
import { AppError } from '../src/errors.js';
const from = '2026-10-12T11:36:56.194Z', until = '2026-10-12T12:08:12.249441Z';
const line = (row: unknown, time = '2026-10-12T12:04:33.685928123Z') => time + ' ' + JSON.stringify(row);
const secret = { url: 'https://private.invalid/?token=private-token', userId: 'private-user', jobId: 'private-job',
  contentId: 'private-content', token: 'private-token', body: 'private-body', stack: 'private-stack', headers: { cookie: 'private-cookie' } };

test('GET job verification is counted with admission while unsupported methods and raw paths are excluded', () => {
  const p = createPlaybackLogProjection('api', { from, until });
  p.push(line({ route: '/v1/jobs', method: 'POST', statusCode: 202, elapsedMs: 12.348, ...secret }));
  p.push(line({ route: '/v1/jobs/:id/verify', method: 'GET', statusCode: 200, elapsedMs: 2622.501, ...secret }));
  p.push(line({ route: '/v1/courses/:id/activities/:activityId/learning-status', method: 'GET', statusCode: 401 }));
  for (const row of [
    { route: '/v1/jobs/:id/verify', method: 'POST', statusCode: 200 },
    { route: '/v1/jobs/private-id/verify', method: 'GET', statusCode: 200 },
    { route: '/v1/jobs', method: 'GET', statusCode: true },
    { route: '/v1/jobs', method: 'GET', statusCode: 200.5 },
    { route: '/v1/jobs', method: 'DELETE', statusCode: 204 },
  ]) p.push(line(row));
  const result = p.result();
  assert.equal(result.admissionPost202Count, 1); assert.equal(result.jobVerify200Count, 1);
  assert.equal(result.activityVerify200Count, 0); assert.equal(result.selectedRouteErrorCount, 1);
  assert.equal(result.records.length, 3); assert.equal(result.ignoredLineCount, 5);
  assert.deepEqual(result.records[1], { role: 'job_verify', method: 'GET', status: 200, time: '2026-10-12T12:04:33.685928123Z', elapsedMs: 2622.5 });
  assert.doesNotMatch(JSON.stringify(result), /private|cookie|headers|\/v1\/jobs/);
  assert.equal(result.reportAckCount, null); assert.equal(result.reportAttemptCount, null);
});

test('worker diagnostics preserve the deployed fixed envelope and discard hostile context or new unknown fields', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const error = new AppError(409, 'SCHOOL_SESSION_CHANGED', 'private-message');
  const context = { event: 'update' as const, controllerPhase: 'ready' as const, controllerAttempt: 'previous' as const,
    observationState: 'playing' as const, positionDelta: 'advanced' as const };
  rememberVideoReportPreparation(error, 'post_report', true, context);
  const deployed = workerVideoReportDiagnostic(error, 'update');
  p.push(line({ ...deployed, ...secret, context: { ...context, privateExtra: 'private-body' } }));
  p.push(line({ event: 'worker_video_report_failed', reportEvent: secret.token, stage: secret.url, code: secret.body,
    mayHaveWritten: 1, context: { ...context, event: secret.token }, ...secret }));
  p.push(line({ event: 'worker_ready', ...secret }));
  const result = p.result();
  assert.equal(result.workerReportFailureCount, 2); assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0], { ...deployed, time: '2026-10-12T12:04:33.685928123Z' });
  assert.deepEqual(result.records[1], { event: 'worker_video_report_failed', time: '2026-10-12T12:04:33.685928123Z',
    reportEvent: 'unknown', stage: 'unknown', code: 'unknown', mayHaveWritten: null });
  assert.doesNotMatch(JSON.stringify(result), /private|cookie|headers|userId|jobId|contentId|stack|body|token/);
});

test('exact UTC window accepts boundaries and ignores malformed, out-of-window, oversized and cross-source lines', () => {
  const p = createPlaybackLogProjection('api', { from, until });
  const row = { route: '/v1/jobs/:id', method: 'GET', statusCode: 200, elapsedMs: 'private' };
  p.push(line(row, from)); p.push(line(row, until));
  for (const time of ['2026-10-12T11:36:56.193999999Z', '2026-10-12T12:08:12.249441001Z', '2026-02-30T12:04:33Z',
    '2026-10-12T12:04:33+09:00', '2026-10-12T12:04:33.1234567890Z']) p.push(line(row, time));
  p.push('not JSON'); p.push(line([])); p.push(from + ' {"raw":"private"');
  p.push('a'.repeat(1_048_577));
  p.push(line({ event: 'worker_video_report_failed', reportEvent: 'ended', stage: 'refresh', code: 'unknown', mayHaveWritten: true }));
  assert.equal(p.result().matchedRecordCount, 2); assert.equal(p.result().ignoredLineCount, 10);
  assert.ok(p.result().records.every(record => !('elapsedMs' in record)));
  for (const window of [{ from: '2026-02-30T00:00:00Z', until }, { from: until, until: from },
    { from, until: '2026-10-14T00:00:00Z' }, { from, until, recordLimit: 0 }, { from, until, recordLimit: 10_001 }])
    assert.throws(() => createPlaybackLogProjection('api', window), /PLAYBACK_LOG_WINDOW_INVALID/);
});

test('bounded retained records keep full selected counters and do not report a truncated zero-error window', () => {
  const p = createPlaybackLogProjection('api', { from, until, recordLimit: 1 });
  p.push(line({ route: '/v1/jobs/:id', method: 'GET', statusCode: 200 }));
  p.push(line({ route: '/v1/jobs/:id/verify', method: 'GET', statusCode: 500 }));
  assert.equal(p.result().records.length, 1); assert.equal(p.result().matchedRecordCount, 2);
  assert.equal(p.result().recordLimitReached, true); assert.equal(p.result().selectedRouteErrorCount, 1);
});

test('capture window and emitted facts are snapshots rather than mutable caller references', () => {
  const window = { from, until }, p = createPlaybackLogProjection('api', window);
  window.from = 'private-window'; window.until = 'private-window';
  p.push(line({ route: '/v1/jobs/:id/verify', method: 'GET', statusCode: 200 }));
  const first = p.result();
  assert.throws(() => { first.records[0]!.time = 'private-time'; }, TypeError);
  first.records.length = 0;
  assert.equal(p.result().windowStartUtc, from); assert.equal(p.result().windowEndUtc, until);
  assert.equal(p.result().records.length, 1); assert.doesNotMatch(JSON.stringify(p.result()), /private/);
});

test('CLI only projects supplied stdin and reports invalid arguments without echoing private input', () => {
  const command = ['--import', 'tsx', 'scripts/project-playback-logs.mjs'];
  const direct = spawnSync(process.execPath, [...command, '--source', 'api', '--from', from, '--until', until],
    { cwd: process.cwd(), input: line({ route: '/v1/jobs/:id/verify', method: 'GET', statusCode: 200, ...secret }), encoding: 'utf8' });
  assert.equal(direct.status, 0); assert.equal(JSON.parse(direct.stdout).jobVerify200Count, 1);
  assert.doesNotMatch(direct.stdout + direct.stderr, /private/);
  const invalid = spawnSync(process.execPath, [...command, '--source', 'private-source'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /PLAYBACK_LOG_INPUT_INVALID/); assert.doesNotMatch(invalid.stderr, /private/);
});

test('post-report outcome projection retains fixed reasons and rejects injected enum, boolean and extra fields', () => {
  const p=createPlaybackLogProjection('worker',{from,until});
  const row={event:'worker_video_report_failed',reportEvent:'playing',stage:'post_report',code:'unknown',mayHaveWritten:true};
  const outcome={reason:'transport_unknown',transport:'unknown',controllerPhase:'closed',transmissionCode:'unexpected_response',
    publishedStillTrue:true,openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true};
  p.push(line({...row,outcome:{...outcome,...secret},...secret}));
  for(const altered of [{reason:['transport_unknown'],body:'private-body'},{transmissionCode:'private-code'},
    {openedStillTrue:'private-body'},{controllerPhase:['closed'],body:'private-body'}])p.push(line({...row,outcome:{...outcome,...altered}}));
  assert.deepEqual((p.result().records[0] as any).outcome,outcome);
  assert.ok(p.result().records.slice(1).every(value=>!('outcome' in value)));
  assert.equal(p.result().workerReportFailureCount,5);assert.equal(p.result().reportAckCount,null);
  assert.doesNotMatch(JSON.stringify(p.result()),/private|url|headers|userId|jobId|contentId|stack|body|token/);
});

test('response failure projection preserves new fixed classifications and old log compatibility', () => {
  const p=createPlaybackLogProjection('worker',{from,until}),base={event:'worker_video_report_failed',reportEvent:'playing',stage:'post_report',code:'unknown',mayHaveWritten:true};
  const outcome={reason:'transport_unknown',transport:'unknown',controllerPhase:'closed',transmissionCode:'unexpected_response',
    publishedStillTrue:true,openedStillTrue:true,omitProgressStillFalse:true,durationExactlyMatches:true};
  for(const value of [undefined,'ack_result_rejected','content_type','private-value',['ack_result_rejected']])p.push(line({...base,outcome:{...outcome,responseFailure:value,body:'private-body'}}));
  assert.deepEqual((p.result().records[0] as any).outcome,outcome);
  assert.equal((p.result().records[1] as any).outcome.responseFailure,'ack_result_rejected');
  assert.equal((p.result().records[2] as any).outcome.responseFailure,'content_type');
  assert.equal((p.result().records[3] as any).outcome.responseFailure,undefined);assert.equal((p.result().records[4] as any).outcome.responseFailure,undefined);
  assert.doesNotMatch(JSON.stringify(p.result()),/private|"body"/);assert.equal(p.result().reportAckCount,null);
});

test('worker log projection keeps independent strict transmission and first runtime facts without source data', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  for (const outcome of ['acknowledged', 'failed'] as const) {
    const error = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'private-error');
    rememberVideoReportPreparation(error, 'manual_event', true);
    rememberVideoReportTransmission(error, outcome === 'acknowledged' ? { outcome, code: 'none' }
      : { outcome, code: 'unexpected_response', responseFailure: 'ack_result_rejected' });
    rememberVideoRuntimeFailure(error, 'MEDIA_INVALID');
    const deployed = workerVideoReportDiagnostic(error, 'playing');
    p.push(line({ ...deployed, ...secret, transmission: { ...deployed.transmission, ...secret } }));
    assert.deepEqual(p.result().records.at(-1), { ...deployed, time: '2026-10-12T12:04:33.685928123Z' });
    assert.equal(Object.isFrozen((p.result().records.at(-1) as any).transmission), true);
  }
  assert.equal(p.result().workerReportFailureCount, 2); assert.equal(p.result().reportAckCount, null);
  assert.doesNotMatch(JSON.stringify(p.result()), /private|url|headers|userId|jobId|contentId|stack|body|token/);
});

test('malformed transmission and runtime fields cannot invent an ACK in projected logs', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const base = { event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true };
  const samples = [undefined, [], { outcome: ['acknowledged'], code: 'none' }, { outcome: 'acknowledged', code: 'unexpected_response' },
    { outcome: 'acknowledged', code: 'none', responseFailure: 'ack_result_rejected' }, { outcome: 'failed', code: 'none' },
    { outcome: 'private-outcome', code: 'unknown' }, { outcome: 'failed', code: 'private-code' },
    { outcome: 'failed', code: 'unexpected_response', responseFailure: ['ack_result_rejected'] },
    { outcome: 'failed', code: 'unexpected_response', responseFailure: 'private-response' }];
  for (const transmission of samples) p.push(line({ ...base, transmission, runtimeFirstFailure: 'private-runtime', ...secret }));
  assert.ok(p.result().records.every(value => !('transmission' in value) && !('runtimeFirstFailure' in value)));
  assert.equal(p.result().workerReportFailureCount, samples.length); assert.equal(p.result().reportAckCount, null);
  assert.doesNotMatch(JSON.stringify(p.result()), /private|url|body|stack|token/);
});

test('every supported runtime first failure survives projection and unknown values stay absent', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const codes = ['SOURCE_INVALID','SOURCE_USED','ABORTED','LAUNCH_FAILED','ROUTE_BLOCKED','MEDIA_INVALID','START_TIMEOUT',
    'STALLED','GUARD_FAILED','REPORT_FAILED','BEFORE_PLAY_FAILED','EXECUTION_TIMEOUT','CLEANUP_FAILED'];
  const base = { event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'refresh', code: 'unknown', mayHaveWritten: true };
  for (const runtimeFirstFailure of [...codes, ['MEDIA_INVALID'], 'private-runtime']) p.push(line({ ...base, runtimeFirstFailure }));
  assert.deepEqual(p.result().records.slice(0, codes.length).map(value => (value as any).runtimeFirstFailure), codes);
  assert.ok(p.result().records.slice(codes.length).every(value => !('runtimeFirstFailure' in value)));
  assert.doesNotMatch(JSON.stringify(p.result()), /private/);
});

test('report failure phases and cancellation snapshots are projected only from complete fixed fields', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const base = { event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'refresh', code: 'upstream_unavailable', mayHaveWritten: true };
  const phases = ['preflight','pre_transport_guard','transmission','post_transport_guard','fresh_read','post_refresh_guard','post_report','session_persist','cache_invalidation'];
  for (const phase of phases) p.push(line({ ...base, reportFailure: { phase, reportSignalAborted: true, lifetimeAborted: false, ...secret } }));
  assert.deepEqual(p.result().records.map(value => (value as any).reportFailure), phases.map(phase => ({ phase, reportSignalAborted: true, lifetimeAborted: false })));
  assert.ok(p.result().records.every(value => Object.isFrozen((value as any).reportFailure)));
  for (const reportFailure of [null, [], { phase: ['fresh_read'], reportSignalAborted: false, lifetimeAborted: false },
    { phase: 'private-phase', reportSignalAborted: false, lifetimeAborted: false },
    { phase: 'fresh_read', reportSignalAborted: 'false', lifetimeAborted: false },
    { phase: 'fresh_read', reportSignalAborted: false }]) p.push(line({ ...base, reportFailure }));
  assert.ok(p.result().records.slice(phases.length).every(value => !('reportFailure' in value)));
  assert.doesNotMatch(JSON.stringify(p.result()), /private|url|stack|token|body/);
});

test('runtime origin projection requires a valid first code and strips unknown origins', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const base = { event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'refresh', code: 'unknown', mayHaveWritten: true };
  const origins = ['media_proxy_failure','media_snapshot_invalid','observation_rejected','route_blocked','periodic_guard_failed','report_failed','other'];
  for (const runtimeFirstFailureOrigin of origins) p.push(line({ ...base, runtimeFirstFailure: 'MEDIA_INVALID', runtimeFirstFailureOrigin }));
  assert.deepEqual(p.result().records.map(value => (value as any).runtimeFirstFailureOrigin), origins);
  for (const fields of [{ runtimeFirstFailureOrigin: 'observation_rejected' },
    { runtimeFirstFailure: 'private-code', runtimeFirstFailureOrigin: 'observation_rejected' },
    { runtimeFirstFailure: 'MEDIA_INVALID', runtimeFirstFailureOrigin: 'private-origin' },
    { runtimeFirstFailure: 'MEDIA_INVALID', runtimeFirstFailureOrigin: ['observation_rejected'] }]) p.push(line({ ...base, ...fields }));
  assert.ok(p.result().records.slice(origins.length).every(value => !('runtimeFirstFailureOrigin' in value)));
  assert.doesNotMatch(JSON.stringify(p.result()), /private/);
});

test('runtime snapshot and SDK observation detail projections require the exact matching origin', () => {
  const p = createPlaybackLogProjection('worker', { from, until });
  const base = { event: 'worker_video_report_failed', reportEvent: 'playing', stage: 'refresh', code: 'unknown', mayHaveWritten: true,
    runtimeFirstFailure: 'MEDIA_INVALID' };
  const snapshots = ['sampling_gap','position_reverse','position_advance','visibility','seeking','media_error','media_shape',
    'inactive_playback','initial_playback','terminal_evidence','capture_failed'];
  const observations = ['playback_shape','visibility','client_cumulative','initial_position','initial_baseline','duration','server_clock',
    'timing_value','timing_mode','client_clock_reverse','observation_gap','client_clock_ahead','clock_residual','pair_clock_drift',
    'position_reverse','pair_progress','inactive_progress','lifetime_server_progress','lifetime_client_progress'];
  for (const runtimeSnapshotReason of snapshots) p.push(line({ ...base, runtimeFirstFailureOrigin: 'media_snapshot_invalid', runtimeSnapshotReason,
    runtimeObservationFailure: 'pair_progress', ...secret }));
  assert.deepEqual(p.result().records.map(value => (value as any).runtimeSnapshotReason), snapshots);
  assert.ok(p.result().records.every(value => !('runtimeObservationFailure' in value)));
  for (const runtimeObservationFailure of observations) p.push(line({ ...base, runtimeFirstFailureOrigin: 'observation_rejected', runtimeObservationFailure,
    runtimeSnapshotReason: 'sampling_gap', ...secret }));
  assert.deepEqual(p.result().records.slice(snapshots.length).map(value => (value as any).runtimeObservationFailure), observations);
  assert.ok(p.result().records.slice(snapshots.length).every(value => !('runtimeSnapshotReason' in value)));
  const validCount = p.result().records.length;
  for (const fields of [
    { runtimeSnapshotReason: 'sampling_gap', runtimeObservationFailure: 'pair_progress' },
    { runtimeFirstFailureOrigin: 'other', runtimeSnapshotReason: 'sampling_gap', runtimeObservationFailure: 'pair_progress' },
    { runtimeFirstFailureOrigin: 'media_snapshot_invalid', runtimeSnapshotReason: 'private-reason' },
    { runtimeFirstFailureOrigin: 'media_snapshot_invalid', runtimeSnapshotReason: ['sampling_gap'] },
    { runtimeFirstFailureOrigin: 'observation_rejected', runtimeObservationFailure: 'private-reason' },
    { runtimeFirstFailureOrigin: 'observation_rejected', runtimeObservationFailure: ['pair_progress'] },
  ]) p.push(line({ ...base, ...fields }));
  assert.ok(p.result().records.slice(validCount).every(value => !('runtimeSnapshotReason' in value) && !('runtimeObservationFailure' in value)));
  assert.doesNotMatch(JSON.stringify(p.result()), /private|url|token|body|stack/);
});
