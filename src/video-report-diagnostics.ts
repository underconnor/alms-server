import { SchoolError, SchoolVideoReportError, type SchoolVideoReportResponseFailureKind, type SchoolVideoObservationFailureKind } from '@alms/ssu-api';
import { AppError } from './errors.js';
import type { ControlledPlaybackFailure, ControlledPlaybackFailureOrigin, ControlledPlaybackSnapshotReason } from './controlled-playback-runtime.js';
const codes = ['authentication_required','identity_mismatch','upstream_unavailable','unexpected_response','forbidden_target','unsupported',
  'AUTH_REQUIRED','SCHOOL_AUTH_REQUIRED','SCHOOL_SESSION_CHANGED','PLAYBACK_OBSERVATION_INVALID','PLAYBACK_SESSION_EXPIRED','PLAYBACK_BUSY','NOT_FOUND','unknown'] as const;
const preparationStages = ['guard','session','identity','enrollment','launch','target','baseline','manual_event','post_report','cache_invalidation'] as const;
export type VideoReportPreparationStage = typeof preparationStages[number];
const eventValues = ['playing','update','unload','ended'] as const;
const phaseValues = ['ready','reporting','needs_verification','closed'] as const;
const attemptValues = ['none','previous'] as const;
const observationValues = ['missing','playing','paused','ended'] as const;
const deltaValues = ['unknown','unchanged','advanced','regressed'] as const;
export type VideoReportContext = Readonly<{ event: typeof eventValues[number]; controllerPhase: typeof phaseValues[number];
  controllerAttempt: typeof attemptValues[number]; observationState: typeof observationValues[number]; positionDelta: typeof deltaValues[number] }>;
type Diagnostic = Readonly<{ stage: 'validation' | 'transmission' | 'refresh' | 'unknown' | VideoReportPreparationStage;
  code: typeof codes[number]; mayHaveWritten: boolean | null; context?: VideoReportContext; outcome?: VideoReportOutcome;
  transmission?: VideoReportTransmission; runtimeFirstFailure?: ControlledPlaybackFailure;
  runtimeFirstFailureOrigin?: ControlledPlaybackFailureOrigin; runtimeSnapshotReason?: ControlledPlaybackSnapshotReason;
  runtimeObservationFailure?: SchoolVideoObservationFailureKind; reportFailure?: VideoReportFailureContext }>;
const stages = ['validation','transmission','refresh'] as const;
const failures = new WeakMap<object, Diagnostic>();
const outcomeReasons = ['transport_unknown','nonterminal_controller_closed','terminal_controller_open'] as const;
const responseKinds = ['content_type','declared_length','missing_body','body_limit','length_mismatch','utf8',
  'ack_body','ack_callback','ack_envelope','ack_json','ack_schema','ack_result_rejected','ack_invalid_playback_rate','ack_error_code'] as const;
const runtimeCodes: readonly ControlledPlaybackFailure[] = ['SOURCE_INVALID','SOURCE_USED','ABORTED','LAUNCH_FAILED','ROUTE_BLOCKED',
  'MEDIA_INVALID','START_TIMEOUT','STALLED','GUARD_FAILED','REPORT_FAILED','BEFORE_PLAY_FAILED','EXECUTION_TIMEOUT','CLEANUP_FAILED'];
export type VideoReportTransmission = Readonly<{ outcome: 'acknowledged' | 'failed'; code: typeof codes[number] | 'none';
  responseFailure?: SchoolVideoReportResponseFailureKind }>;
const runtimeOrigins: readonly ControlledPlaybackFailureOrigin[] = ['media_proxy_failure','media_snapshot_invalid','observation_rejected',
  'route_blocked','periodic_guard_failed','report_failed','other'];
const snapshotReasons: readonly ControlledPlaybackSnapshotReason[] = ['sampling_gap','position_reverse','position_advance','visibility','seeking',
  'media_error','media_shape','inactive_playback','initial_playback','terminal_evidence','capture_failed'];
const observationFailures: readonly SchoolVideoObservationFailureKind[] = ['playback_shape','visibility','client_cumulative','initial_position',
  'initial_baseline','duration','server_clock','timing_value','timing_mode','client_clock_reverse','observation_gap','client_clock_ahead',
  'clock_residual','pair_clock_drift','position_reverse','pair_progress','inactive_progress','lifetime_server_progress','lifetime_client_progress'];
const reportPhases = ['preflight','pre_transport_guard','transmission','post_transport_guard','fresh_read','post_refresh_guard',
  'post_report','session_persist','cache_invalidation'] as const;
export type VideoReportPhase = typeof reportPhases[number];
export type VideoReportFailureContext = Readonly<{ phase: VideoReportPhase; reportSignalAborted: boolean; lifetimeAborted: boolean }>;
type ResultFacts = Readonly<{ controllerPhase: typeof phaseValues[number]; transmissionCode: typeof codes[number] | 'none';
  publishedStillTrue: boolean; openedStillTrue: boolean; omitProgressStillFalse: boolean; durationExactlyMatches: boolean;
  responseFailure?: SchoolVideoReportResponseFailureKind }>;
type VideoReportOutcome = Readonly<{ reason: typeof outcomeReasons[number]; transport: 'acknowledged' | 'unknown';
  controllerPhase: typeof phaseValues[number]; transmissionCode: typeof codes[number] | 'none';
  publishedStillTrue: boolean | null; openedStillTrue: boolean | null; omitProgressStillFalse: boolean | null; durationExactlyMatches: boolean | null;
  responseFailure?: SchoolVideoReportResponseFailureKind }>;
// Result facts stay process-private. They never change the report result or HTTP response.
const resultFacts = new WeakMap<object, ResultFacts>();
export function rememberVideoReportResult(result: object, facts: ResultFacts): void {
  if (!phaseValues.includes(facts.controllerPhase) || ![...codes,'none'].includes(facts.transmissionCode)
    || ![facts.publishedStillTrue,facts.openedStillTrue,facts.omitProgressStillFalse,facts.durationExactlyMatches].every(value => typeof value === 'boolean')) return;
  resultFacts.set(result, Object.freeze({ controllerPhase: facts.controllerPhase, transmissionCode: facts.transmissionCode,
    publishedStillTrue: facts.publishedStillTrue, openedStillTrue: facts.openedStillTrue,
    omitProgressStillFalse: facts.omitProgressStillFalse, durationExactlyMatches: facts.durationExactlyMatches,
    ...(typeof facts.responseFailure === 'string' && responseKinds.includes(facts.responseFailure) ? { responseFailure: facts.responseFailure } : {}) }));
}
/** Distinguish post-report stop reasons without exposing payloads or treating an ACK as school completion. */
export function rememberVideoReportOutcomeFailure(error: object, result: { transport: 'acknowledged' | 'unknown'; state: 'ready' | 'closed' },
  reason: typeof outcomeReasons[number]): void {
  if (!outcomeReasons.includes(reason) || !['acknowledged','unknown'].includes(result.transport) || !['ready','closed'].includes(result.state)) return;
  const facts = resultFacts.get(result);
  const outcome: VideoReportOutcome = Object.freeze({ reason, transport: result.transport, controllerPhase: facts?.controllerPhase ?? result.state,
    transmissionCode: facts?.transmissionCode ?? (result.transport === 'acknowledged' ? 'none' : 'unknown'),
    publishedStillTrue: facts?.publishedStillTrue ?? null, openedStillTrue: facts?.openedStillTrue ?? null,
    omitProgressStillFalse: facts?.omitProgressStillFalse ?? null, durationExactlyMatches: facts?.durationExactlyMatches ?? null,
    ...(facts?.responseFailure ? { responseFailure: facts.responseFailure } : {}) });
  const previous = videoReportDiagnostic(error), transmission = previous.transmission ?? failures.get(result)?.transmission;
  failures.set(error, Object.freeze({ ...previous, ...(transmission ? { transmission } : {}), outcome }));
}
export function videoReportDiagnostic(error: unknown): Diagnostic {
  if (error && typeof error === 'object') { const saved = failures.get(error); if (saved) return saved; }
  const value = error instanceof SchoolError || error instanceof AppError ? error.code : 'unknown';
  return Object.freeze({ stage: error instanceof SchoolVideoReportError && stages.includes(error.stage) ? error.stage : 'unknown',
    code: codes.includes(value as typeof codes[number]) ? value as typeof codes[number] : 'unknown',
    mayHaveWritten: error instanceof SchoolVideoReportError && typeof error.mayHaveWritten === 'boolean' ? error.mayHaveWritten : null });
}
export function rememberVideoReportDiagnostic(target: object, source: unknown): void {
  const previous = failures.get(target);
  const sourceDiagnostic = videoReportDiagnostic(source);
  const { runtimeFirstFailureOrigin: _sourceOrigin, runtimeSnapshotReason: _sourceSnapshot,
    runtimeObservationFailure: _sourceObservation, ...sourceFacts } = sourceDiagnostic;
  const runtimeFacts = previous?.runtimeFirstFailure ? previous : sourceDiagnostic;
  failures.set(target, Object.freeze({ ...sourceFacts,
    ...(previous?.transmission ? { transmission: previous.transmission } : {}),
    ...(previous?.runtimeFirstFailure ? { runtimeFirstFailure: previous.runtimeFirstFailure } : {}),
    ...(runtimeFacts.runtimeFirstFailureOrigin ? { runtimeFirstFailureOrigin: runtimeFacts.runtimeFirstFailureOrigin } : {}),
    ...(runtimeFacts.runtimeSnapshotReason ? { runtimeSnapshotReason: runtimeFacts.runtimeSnapshotReason } : {}),
    ...(runtimeFacts.runtimeObservationFailure ? { runtimeObservationFailure: runtimeFacts.runtimeObservationFailure } : {}),
    ...(previous?.reportFailure ? { reportFailure: previous.reportFailure } : {}) }));
}

/** The strict transport result is independent of the SDK's later fresh read or authority checks. */
export function rememberVideoReportTransmission(target: object, facts: VideoReportTransmission): void {
  const previous = videoReportDiagnostic(target);
  if (previous.transmission || !facts || !['acknowledged','failed'].includes(facts.outcome) || ![...codes,'none'].includes(facts.code)
    || facts.outcome === 'acknowledged' && (facts.code !== 'none' || facts.responseFailure !== undefined)
    || facts.outcome === 'failed' && facts.code === 'none'
    || facts.responseFailure !== undefined && !responseKinds.includes(facts.responseFailure)) return;
  const transmission: VideoReportTransmission = Object.freeze({ outcome: facts.outcome, code: facts.code,
    ...(facts.responseFailure ? { responseFailure: facts.responseFailure } : {}) });
  failures.set(target, Object.freeze({ ...previous, transmission }));
}

/** First runtime stop only. This is diagnostic evidence, never permission to retry a school report. */
export function rememberVideoRuntimeFailure(target: object, code: ControlledPlaybackFailure, origin?: ControlledPlaybackFailureOrigin,
  snapshotReason?: ControlledPlaybackSnapshotReason, observationFailure?: SchoolVideoObservationFailureKind): void {
  const previous = videoReportDiagnostic(target);
  if (previous.runtimeFirstFailure || !runtimeCodes.includes(code)) return;
  failures.set(target, Object.freeze({ ...previous, runtimeFirstFailure: code,
    ...(origin !== undefined && runtimeOrigins.includes(origin) ? { runtimeFirstFailureOrigin: origin } : {}),
    ...(origin === 'media_snapshot_invalid' && snapshotReason !== undefined && snapshotReasons.includes(snapshotReason)
      ? { runtimeSnapshotReason: snapshotReason } : {}),
    ...(origin === 'observation_rejected' && observationFailure !== undefined && observationFailures.includes(observationFailure)
      ? { runtimeObservationFailure: observationFailure } : {}) }));
}

/** Snapshot at the failure boundary, before outer cleanup can abort the driver's lifetime. */
export function rememberVideoReportFailureContext(target: object, facts: VideoReportFailureContext): void {
  const previous = videoReportDiagnostic(target);
  if (previous.reportFailure || !facts || !reportPhases.includes(facts.phase)
    || typeof facts.reportSignalAborted !== 'boolean' || typeof facts.lifetimeAborted !== 'boolean') return;
  const reportFailure: VideoReportFailureContext = Object.freeze({ phase: facts.phase,
    reportSignalAborted: facts.reportSignalAborted, lifetimeAborted: facts.lifetimeAborted });
  failures.set(target, Object.freeze({ ...previous, reportFailure }));
}

/** Worker log envelope: only fixed values, never the claim, report payload or original error. */
export function workerVideoReportDiagnostic(error: unknown, reportEvent: 'playing' | 'update' | 'ended') {
  return Object.freeze({ event: 'worker_video_report_failed' as const,
    reportEvent: ['playing','update','ended'].includes(reportEvent) ? reportEvent : 'unknown' as const,
    ...videoReportDiagnostic(error) });
}

/** Fixed preflight facts only. Callers track the dedicated transport entry, never an HTTP payload. */
export function rememberVideoReportPreparation(error: unknown, stage: VideoReportPreparationStage, mayHaveWritten: boolean,
  context?: VideoReportContext): void {
  if (!error || typeof error !== 'object') return;
  const previous = videoReportDiagnostic(error);
  const safeContext = context && eventValues.includes(context.event) && phaseValues.includes(context.controllerPhase)
    && attemptValues.includes(context.controllerAttempt) && observationValues.includes(context.observationState) && deltaValues.includes(context.positionDelta)
    ? Object.freeze({ event: context.event, controllerPhase: context.controllerPhase, controllerAttempt: context.controllerAttempt,
      observationState: context.observationState, positionDelta: context.positionDelta }) : undefined;
  failures.set(error, Object.freeze({
    stage: previous.stage !== 'unknown' ? previous.stage : preparationStages.includes(stage) ? stage : 'unknown',
    code: previous.code,
    mayHaveWritten: previous.mayHaveWritten === true || mayHaveWritten === true ? true
      : typeof mayHaveWritten === 'boolean' ? mayHaveWritten : previous.mayHaveWritten,
    ...(safeContext ? { context: safeContext } : {}),
    ...(previous.outcome ? { outcome: previous.outcome } : {}),
    ...(previous.transmission ? { transmission: previous.transmission } : {}),
    ...(previous.runtimeFirstFailure ? { runtimeFirstFailure: previous.runtimeFirstFailure } : {}),
    ...(previous.runtimeFirstFailureOrigin ? { runtimeFirstFailureOrigin: previous.runtimeFirstFailureOrigin } : {}),
    ...(previous.runtimeSnapshotReason ? { runtimeSnapshotReason: previous.runtimeSnapshotReason } : {}),
    ...(previous.runtimeObservationFailure ? { runtimeObservationFailure: previous.runtimeObservationFailure } : {}),
    ...(previous.reportFailure ? { reportFailure: previous.reportFailure } : {}),
  }));
}
