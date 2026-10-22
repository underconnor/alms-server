import { SchoolError, SchoolVideoPlaybackStartError, inspectSchoolVideoReportResponseFailure } from '@alms/ssu-api';
import { AppError } from './errors.js';

const stages = ['validation', 'transmission', 'refresh', 'unknown'] as const;
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response', 'forbidden_target', 'unsupported',
  'AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED', 'SCHOOL_SESSION_CHANGED', 'PLAYBACK_START_UNAVAILABLE', 'PLAYBACK_START_EXPIRED',
  'PLAYBACK_START_CONSUMED', 'PLAYBACK_BUSY', 'NOT_FOUND', 'unknown'] as const;
const responseKinds = ['content_type', 'declared_length', 'missing_body', 'body_limit', 'length_mismatch', 'utf8',
  'ack_body', 'ack_callback', 'ack_envelope', 'ack_json', 'ack_schema', 'ack_result_rejected', 'ack_invalid_playback_rate', 'ack_error_code'] as const;
export type PlaybackStartFailureDiagnostic = Readonly<{ stage: typeof stages[number]; code: typeof codes[number];
  mayHaveWritten: boolean | null; responseFailure?: typeof responseKinds[number] }>;
const failures = new WeakMap<object, PlaybackStartFailureDiagnostic>();
function fixed(value: PlaybackStartFailureDiagnostic): PlaybackStartFailureDiagnostic {
  return Object.freeze({ stage: stages.includes(value.stage) ? value.stage : 'unknown',
    code: codes.includes(value.code) ? value.code : 'unknown',
    mayHaveWritten: typeof value.mayHaveWritten === 'boolean' ? value.mayHaveWritten : null,
    ...(typeof value.responseFailure === 'string' && responseKinds.includes(value.responseFailure) ? { responseFailure: value.responseFailure } : {}) });
}
/** Fixed facts only; the SDK transport failure is inspected before its controller catches it. */
export function playbackStartFailureDiagnostic(error: unknown, stage: PlaybackStartFailureDiagnostic['stage'] = 'unknown',
  mayHaveWritten: boolean | null = null): PlaybackStartFailureDiagnostic {
  try {
    const sdk = error instanceof SchoolVideoPlaybackStartError ? error : null;
    const response = inspectSchoolVideoReportResponseFailure(error);
    return fixed({ stage: sdk && stages.includes(sdk.stage) ? sdk.stage : stage,
      code: error instanceof SchoolError || error instanceof AppError ? error.code as PlaybackStartFailureDiagnostic['code'] : 'unknown',
      mayHaveWritten: sdk?.mayHaveWritten === true || mayHaveWritten === true ? true
        : typeof sdk?.mayHaveWritten === 'boolean' ? sdk.mayHaveWritten : mayHaveWritten,
      ...(response ? { responseFailure: response.kind } : {}) });
  } catch { return fixed({ stage: 'unknown', code: 'unknown', mayHaveWritten: null }); }
}
/** Process-private attachment: no public result/error fields or original source references. */
export function rememberPlaybackStartDiagnostic(target: unknown, diagnostic: PlaybackStartFailureDiagnostic): void {
  try { if (target && typeof target === 'object') failures.set(target, fixed(diagnostic)); }
  catch { /* A diagnostic cannot replace the original outcome. */ }
}
export function copyPlaybackStartDiagnostic(target: unknown, source: unknown): void {
  try { if (source && typeof source === 'object') { const saved = failures.get(source); if (saved) rememberPlaybackStartDiagnostic(target, saved); } }
  catch { /* A diagnostic cannot replace the original outcome. */ }
}
/** Consumed once by the route, so a cached confirmation never logs a second transmission. */
export function takePlaybackStartDiagnostic(source: unknown): PlaybackStartFailureDiagnostic | null {
  try { if (source && typeof source === 'object') { const saved = failures.get(source); failures.delete(source); return saved ?? null; } }
  catch { /* Only fixed facts are observable. */ }
  return null;
}
