import { SchoolError } from '@alms/ssu-api';
import { AppError } from './errors.js';

const operations = ['list', 'detail', 'unknown'] as const;
const stages = ['owned_catalog', 'cache_proof', 'school_read', 'projection', 'final_session', 'unknown'] as const;
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response', 'forbidden_target', 'unsupported',
  'AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED', 'SCHOOL_SESSION_CHANGED', 'NOT_FOUND', 'INVALID_REQUEST', 'RATE_LIMITED',
  'ASSIGNMENTS_UNAVAILABLE', 'SCHOOL_PROVIDER_UNAVAILABLE', 'SCHOOL_UPSTREAM_UNAVAILABLE', 'INTERNAL_ERROR', 'unknown'] as const;
export type AssignmentReadOperation = 'list' | 'detail';
export type AssignmentReadFailureStage = typeof stages[number];
export type AssignmentReadFailureDiagnostic = Readonly<{ operation: typeof operations[number]; stage: AssignmentReadFailureStage; code: typeof codes[number] }>;
export type AssignmentReadTrace = { operation: AssignmentReadOperation; stage: AssignmentReadFailureStage; scope: object };
const failures = new WeakMap<object, AssignmentReadFailureDiagnostic>();
const scopedFailures = new WeakMap<object, WeakMap<object, AssignmentReadFailureDiagnostic>>();
function fixed(operation: unknown, stage: unknown, code: unknown): AssignmentReadFailureDiagnostic {
  return Object.freeze({ operation: operations.includes(operation as typeof operations[number]) ? operation as typeof operations[number] : 'unknown',
    stage: stages.includes(stage as AssignmentReadFailureStage) ? stage as AssignmentReadFailureStage : 'unknown',
    code: codes.includes(code as typeof codes[number]) ? code as typeof codes[number] : 'unknown' });
}
/** Only allowlisted facts are copied; nothing is added to enumerable/public error fields. */
export function rememberAssignmentReadFailure(error: unknown, diagnostic: AssignmentReadFailureDiagnostic, scope?: object): void {
  try { if (typeof error === 'object' && error !== null) {
    const safe = fixed(diagnostic.operation, diagnostic.stage, diagnostic.code);
    if (scope) { const entries = scopedFailures.get(error) ?? new WeakMap<object, AssignmentReadFailureDiagnostic>(); entries.set(scope, safe); scopedFailures.set(error, entries); }
    else failures.set(error, safe);
  } }
  catch { /* Diagnostics must not replace the original failure. */ }
}
export function assignmentReadFailureDiagnostic(error: unknown, operation: AssignmentReadOperation, stage: AssignmentReadFailureStage = 'unknown', scope?: object, useSaved = true): AssignmentReadFailureDiagnostic {
  try {
    if (useSaved && typeof error === 'object' && error !== null) { const saved = scope ? scopedFailures.get(error)?.get(scope) : failures.get(error); if (saved) return saved; }
    return fixed(operation, stage, error instanceof SchoolError || error instanceof AppError ? error.code : 'unknown');
  } catch { return fixed(operation, stage, 'unknown'); }
}
