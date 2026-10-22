import { SchoolError, SchoolVideoReportError, type SchoolVideoReportResponseFailureKind } from '@alms/ssu-api';
import { AppError } from './errors.js';
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
  code: typeof codes[number]; mayHaveWritten: boolean | null; context?: VideoReportContext; outcome?: VideoReportOutcome }>;
const stages = ['validation','transmission','refresh'] as const;
const failures = new WeakMap<object, Diagnostic>();
const outcomeReasons = ['transport_unknown','nonterminal_controller_closed','terminal_controller_open'] as const;
const responseKinds = ['content_type','declared_length','missing_body','body_limit','length_mismatch','utf8',
  'ack_body','ack_callback','ack_envelope','ack_json','ack_schema','ack_result_rejected','ack_invalid_playback_rate','ack_error_code'] as const;
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
  failures.set(error, Object.freeze({ ...videoReportDiagnostic(error), outcome }));
}
export function videoReportDiagnostic(error: unknown): Diagnostic {
  if (error && typeof error === 'object') { const saved = failures.get(error); if (saved) return saved; }
  const value = error instanceof SchoolError || error instanceof AppError ? error.code : 'unknown';
  return Object.freeze({ stage: error instanceof SchoolVideoReportError && stages.includes(error.stage) ? error.stage : 'unknown',
    code: codes.includes(value as typeof codes[number]) ? value as typeof codes[number] : 'unknown',
    mayHaveWritten: error instanceof SchoolVideoReportError && typeof error.mayHaveWritten === 'boolean' ? error.mayHaveWritten : null });
}
export function rememberVideoReportDiagnostic(target: object, source: unknown): void {
  failures.set(target, videoReportDiagnostic(source));
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
  }));
}
