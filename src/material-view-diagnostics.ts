import { SchoolError, SchoolMaterialViewError } from '@alms/ssu-api';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

const stages = ['validation', 'callback', 'refresh', 'finalization', 'unknown'] as const;
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response',
  'forbidden_target', 'unsupported', 'invalid_request', 'auth_required', 'csrf_invalid', 'session_changed',
  'not_found', 'rate_limited', 'provider_unavailable', 'internal_error', 'unknown'] as const;
export type MaterialViewFailureStage = typeof stages[number];
export type MaterialViewFailureDiagnostic = Readonly<{ stage: MaterialViewFailureStage; code: typeof codes[number] }>;

// Request-scoped diagnostics never become enumerable error fields, public DTOs or stored school data.
const failures = new WeakMap<object, MaterialViewFailureDiagnostic>();
function fixed(stage: unknown, code: unknown): MaterialViewFailureDiagnostic {
  return Object.freeze({
    stage: stages.includes(stage as MaterialViewFailureStage) ? stage as MaterialViewFailureStage : 'unknown',
    code: codes.includes(code as typeof codes[number]) ? code as typeof codes[number] : 'unknown',
  });
}
export function rememberMaterialViewFailure(error: unknown, diagnostic: MaterialViewFailureDiagnostic): void {
  if (typeof error === 'object' && error !== null) failures.set(error, fixed(diagnostic.stage, diagnostic.code));
}
export function materialViewFailureDiagnostic(error: unknown, fallback?: MaterialViewFailureStage): MaterialViewFailureDiagnostic {
  if (fallback === undefined && typeof error === 'object' && error !== null) {
    const stored = failures.get(error); if (stored) return stored;
  }
  if (error instanceof SchoolMaterialViewError) return fixed(error.stage, error.code);
  if (error instanceof SchoolError) return fixed(fallback, error.code);
  if (error instanceof ZodError) return fixed(fallback ?? 'validation', 'invalid_request');
  if (error instanceof AppError) {
    const code: Record<string, typeof codes[number]> = {
      INVALID_REQUEST: 'invalid_request', AUTH_REQUIRED: 'auth_required', SCHOOL_AUTH_REQUIRED: 'auth_required', CSRF_INVALID: 'csrf_invalid',
      SCHOOL_SESSION_CHANGED: 'session_changed', NOT_FOUND: 'not_found', RATE_LIMITED: 'rate_limited',
      MATERIAL_VIEW_UNAVAILABLE: 'provider_unavailable', SCHOOL_PROVIDER_UNAVAILABLE: 'provider_unavailable',
      SCHOOL_UPSTREAM_UNAVAILABLE: 'upstream_unavailable', INTERNAL_ERROR: 'internal_error',
    };
    // Authentication/body/rate failures may occur before the reader is entered.
    const beforeReader = ['INVALID_REQUEST', 'AUTH_REQUIRED', 'CSRF_INVALID', 'RATE_LIMITED', 'MATERIAL_VIEW_UNAVAILABLE'];
    return fixed(fallback ?? (beforeReader.includes(error.code) ? 'validation' : 'unknown'), code[error.code]);
  }
  return fixed(fallback, 'unknown');
}
