/** Offline projection of timestamped Docker log lines. It never queries a server or school. */
const routeMethods = {
  '/v1/jobs': ['GET', 'POST'],
  '/v1/jobs/:id': ['GET'],
  '/v1/jobs/:id/verify': ['GET'],
  '/v1/courses/:id/activities/:activityId/learning-status': ['GET'],
  '/v1/courses/:id/attendance': ['GET'],
} as const;
const roles = {
  '/v1/jobs': 'jobs', '/v1/jobs/:id': 'job', '/v1/jobs/:id/verify': 'job_verify',
  '/v1/courses/:id/activities/:activityId/learning-status': 'activity_verify',
  '/v1/courses/:id/attendance': 'course_attendance',
} as const;
const stages = ['validation', 'transmission', 'refresh', 'unknown', 'guard', 'session', 'identity', 'enrollment', 'launch',
  'target', 'baseline', 'manual_event', 'post_report', 'cache_invalidation'];
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response', 'forbidden_target', 'unsupported',
  'AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED', 'SCHOOL_SESSION_CHANGED', 'PLAYBACK_OBSERVATION_INVALID', 'PLAYBACK_SESSION_EXPIRED', 'PLAYBACK_BUSY', 'NOT_FOUND', 'unknown'];
const responseKinds = ['content_type','declared_length','missing_body','body_limit','length_mismatch','utf8',
  'ack_body','ack_callback','ack_envelope','ack_json','ack_schema','ack_result_rejected','ack_invalid_playback_rate','ack_error_code'];
const contextValues = {
  event: ['playing', 'update', 'unload', 'ended'], controllerPhase: ['ready', 'reporting', 'needs_verification', 'closed'],
  controllerAttempt: ['none', 'previous'], observationState: ['missing', 'playing', 'paused', 'ended'], positionDelta: ['unknown', 'unchanged', 'advanced', 'regressed'],
};
const fixed = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function timestamp(value: string): bigint | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  const fraction = value.includes('.') ? value.slice(20, -1).padEnd(9, '0') : '000000000';
  return BigInt(parsed - Number(fraction.slice(0, 3))) * 1_000_000n + BigInt(fraction);
}
type RouteRecord = { role: typeof roles[keyof typeof roles]; method: string; status: number; time: string; elapsedMs?: number };
type FailureRecord = { event: 'worker_video_report_failed'; time: string; reportEvent: string; stage: string; code: string;
  mayHaveWritten: boolean | null; context?: Record<string, string>; outcome?: Record<string, string | boolean | null> };

/** Supply logs from one identified source. The caller must separately verify release and capture integrity. */
export function createPlaybackLogProjection(source: 'api' | 'worker', window: { from: string; until: string; recordLimit?: number }) {
  const fromText = window.from, untilText = window.until;
  const from = timestamp(fromText), until = timestamp(untilText), limit = window.recordLimit ?? 10_000;
  if (!['api', 'worker'].includes(source) || from === null || until === null || from > until || until - from > 86_400_000_000_000n
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('PLAYBACK_LOG_WINDOW_INVALID');
  const records: (RouteRecord | FailureRecord)[] = [];
  let matched = 0, ignored = 0, admission = 0, jobVerify = 0, activityVerify = 0, errors = 0, failures = 0;
  return {
    push(line: string): void {
      if (typeof line !== 'string' || line.length > 1_048_576) { ignored++; return; }
      const split = line.indexOf(' ');
      if (split < 0) { ignored++; return; }
      const time = line.slice(0, split), instant = timestamp(time);
      if (instant === null || instant < from || instant > until) { ignored++; return; }
      let row: unknown;
      try { row = JSON.parse(line.slice(split + 1)); } catch { ignored++; return; }
      if (!object(row)) { ignored++; return; }
      let record: RouteRecord | FailureRecord;
      if (source === 'api') {
        if (typeof row.route !== 'string' || !Object.hasOwn(routeMethods, row.route)) { ignored++; return; }
        const route = row.route as keyof typeof routeMethods;
        if (typeof row.method !== 'string' || !(routeMethods[route] as readonly string[]).includes(row.method)
          || !numeric(row.statusCode) || !Number.isInteger(row.statusCode) || row.statusCode < 100 || row.statusCode > 599) { ignored++; return; }
        record = { role: roles[route], method: row.method, status: row.statusCode, time };
        if (numeric(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 18_000_000) record.elapsedMs = Math.round(row.elapsedMs * 100) / 100;
        if (record.role === 'jobs' && record.method === 'POST' && record.status === 202) admission++;
        if (record.role === 'job_verify' && record.status === 200) jobVerify++;
        if (record.role === 'activity_verify' && record.status === 200) activityVerify++;
        if (record.status >= 400) errors++;
      } else {
        if (row.event !== 'worker_video_report_failed') { ignored++; return; }
        record = { event: 'worker_video_report_failed', time, reportEvent: fixed(row.reportEvent, ['playing', 'update', 'ended', 'unknown']),
          stage: fixed(row.stage, stages), code: fixed(row.code, codes), mayHaveWritten: typeof row.mayHaveWritten === 'boolean' ? row.mayHaveWritten : null };
        const context = row.context;
        if (object(context) && Object.entries(contextValues).every(([key, values]) => typeof context[key] === 'string' && values.includes(context[key]))) {
          record.context = Object.freeze(Object.fromEntries(Object.keys(contextValues).map(key => [key, context[key] as string])));
        }
        const outcome = row.outcome, comparisonKeys = ['publishedStillTrue','openedStillTrue','omitProgressStillFalse','durationExactlyMatches'];
        if (object(outcome) && typeof outcome.reason === 'string' && ['transport_unknown','nonterminal_controller_closed','terminal_controller_open'].includes(outcome.reason)
          && typeof outcome.transport === 'string' && ['acknowledged','unknown'].includes(outcome.transport)
          && typeof outcome.controllerPhase === 'string' && contextValues.controllerPhase.includes(outcome.controllerPhase)
          && typeof outcome.transmissionCode === 'string' && [...codes,'none'].includes(outcome.transmissionCode)
          && comparisonKeys.every(key => outcome[key] === null || typeof outcome[key] === 'boolean')) {
          record.outcome = Object.freeze({ reason: outcome.reason as string, transport: outcome.transport as string,
            controllerPhase: outcome.controllerPhase as string, transmissionCode: outcome.transmissionCode as string,
            ...Object.fromEntries(comparisonKeys.map(key => [key, outcome[key] as boolean | null])),
            ...(typeof outcome.responseFailure === 'string' && responseKinds.includes(outcome.responseFailure) ? { responseFailure: outcome.responseFailure } : {}) });
        }
        failures++;
      }
      matched++; if (records.length < limit) records.push(Object.freeze(record));
    },
    result() {
      return { kind: 'local-playback-log-projection' as const, source, windowStartUtc: fromText, windowEndUtc: untilText,
        scope: 'Supplied source logs in the bounded window; multiple requests may be present. Capture and release identity require separate verification.',
        schoolRequestsMade: 0, rawUrlTokenIdentityNonceBodyStackRetained: false, records: [...records], matchedRecordCount: matched, ignoredLineCount: ignored,
        recordLimitReached: matched > records.length, admissionPost202Count: admission, jobVerify200Count: jobVerify, activityVerify200Count: activityVerify,
        selectedRouteErrorCount: errors, workerReportFailureCount: failures, reportAcksProjected: false, reportAckCount: null, reportAttemptCount: null };
    },
  };
}
