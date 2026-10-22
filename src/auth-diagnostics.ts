import { SchoolError, SchoolSsoVerificationError } from '@alms/ssu-api';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

const stages = ['callback_validation', 'callback_binding', 'provider_verification', 'lms_preparation', 'lms_exchange',
  'school_identity', 'provider_session', 'identity_binding', 'session_issue', 'callback_response', 'unknown'] as const;
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response',
  'forbidden_target', 'unsupported', 'invalid_request', 'invalid_callback', 'school_auth_failed',
  'school_auth_unavailable', 'school_upstream_unavailable', 'internal_error', 'unknown'] as const;
export type AuthFailureStage = typeof stages[number];
const verificationStages = ['input', 'sso_entry', 'portal_page', 'identity_parse'] as const;
const identityShapes = ['missing_student', 'missing_name', 'missing_both', 'id_mismatch'] as const;
const portalShapes = ['identity_markup', 'password_form', 'literal_navigation', 'frame_shell', 'mixed', 'unknown', 'inspection_limited'] as const;
const portalMarkupKeys = ['identityContainerPresent', 'studentRowPresent', 'studentValuePresent', 'nameValuePresent', 'passwordFormPresent'] as const;
type PortalMarkup = Readonly<Record<typeof portalMarkupKeys[number], boolean>>;
const navigationPlacements = ['none', 'outer_statement', 'nested_or_expression', 'mixed', 'inspection_limited'] as const;
const navigationTargets = ['none', 'saint_sso_entry', 'saint_identity_page', 'other', 'mixed', 'inspection_limited'] as const;
type PortalNavigation = Readonly<{scriptPlacement: typeof navigationPlacements[number]; scriptTarget: typeof navigationTargets[number];
  formTarget: typeof navigationTargets[number]; metaRefreshTarget: typeof navigationTargets[number]}>;
const exchangeStages = ['preparation', 'certificate', 'canvas_frame', 'canvas_form', 'canvas_submit', 'bootstrap', 'unknown'] as const;
const schoolCodes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response', 'forbidden_target', 'unsupported'] as const;
const parseReasons = ['form_target', 'form_count', 'csrf_shape', 'identity_mismatch', 'issued_payload_count',
  'issued_payload_format', 'key_format', 'decrypt_failed', 'decoded_value_invalid'] as const;
const origins = ['lms', 'canvas', 'saint', 'smartid', 'ecc', 'other'] as const;
const pathRoles = ['lms_home', 'lms_login', 'lms_gateway', 'lms_callback', 'canvas_frame', 'canvas_login',
  'canvas_home', 'canvas_dashboard', 'saint_sso_entry', 'saint_identity_page', 'smartid_login', 'other'] as const;
type ExchangeDiagnostic = Readonly<{status: 'ready'} | {status: 'failed'; stage: typeof exchangeStages[number];
  code: typeof schoolCodes[number]; canvasParseReason?: typeof parseReasons[number]}>;
export type AuthHttpTraceEntry = Readonly<{method: 'GET' | 'POST'; origin: typeof origins[number];
  pathRole: typeof pathRoles[number]; status: number}>;
export type AuthCallbackContext = Readonly<{lmsExchange?: ExchangeDiagnostic; schoolTrace?: readonly AuthHttpTraceEntry[]}>;
export type AuthFailureDiagnostic = Readonly<{ stage: AuthFailureStage; code: typeof codes[number];
  verificationStage?: typeof verificationStages[number]; identityShape?: typeof identityShapes[number];
  portalShape?: typeof portalShapes[number]; portalMarkup?: PortalMarkup; portalNavigation?: PortalNavigation }> & AuthCallbackContext;

function context(value: AuthCallbackContext): AuthCallbackContext {
  const exchange = value.lmsExchange;
  let lmsExchange: ExchangeDiagnostic | undefined;
  if (exchange?.status === 'ready') lmsExchange = Object.freeze({status: 'ready'});
  else if (exchange?.status === 'failed' && exchangeStages.includes(exchange.stage) && schoolCodes.includes(exchange.code)) {
    lmsExchange = Object.freeze({status: 'failed', stage: exchange.stage, code: exchange.code,
      ...(exchange.stage === 'canvas_form' && parseReasons.includes(exchange.canvasParseReason!) ? {canvasParseReason: exchange.canvasParseReason} : {})});
  }
  const schoolTrace = Array.isArray(value.schoolTrace) ? Object.freeze(value.schoolTrace.slice(0, 20).flatMap(row =>
    row && ['GET', 'POST'].includes(row.method) && origins.includes(row.origin) && pathRoles.includes(row.pathRole)
      && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599
      ? [Object.freeze({method: row.method, origin: row.origin, pathRole: row.pathRole, status: row.status})] : [])) : undefined;
  return Object.freeze({...(lmsExchange ? {lmsExchange} : {}), ...(schoolTrace ? {schoolTrace} : {})});
}

// Successful provider results carry context privately until the callback finishes issuing its session.
const contexts = new WeakMap<object, AuthCallbackContext>();
export function rememberAuthContext(value: object, evidence: AuthCallbackContext): void { contexts.set(value, context(evidence)); }
export function authCallbackContext(value: object): AuthCallbackContext { return contexts.get(value) ?? Object.freeze({}); }

export function authFetchDestination(value: unknown): 'document' | 'iframe' | 'empty' | 'other' | 'unknown' {
  if (value === undefined || value === '') return 'unknown';
  if (value === 'document' || value === 'iframe' || value === 'empty') return value;
  return 'other';
}

/** Observe response metadata only. Arguments, response, errors and request count are left unchanged. */
export function createAuthHttpTrace(fetcher: typeof fetch): {fetch: typeof fetch; snapshot: () => readonly AuthHttpTraceEntry[]} {
  const rows: AuthHttpTraceEntry[] = [];
  const observed: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    try {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (rows.length < 20 && (method === 'GET' || method === 'POST') && Number.isInteger(response.status)
        && response.status >= 100 && response.status <= 599) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const originNames: Record<string, AuthHttpTraceEntry['origin']> = {'https://lms.ssu.ac.kr': 'lms', 'https://canvas.ssu.ac.kr': 'canvas',
          'https://saint.ssu.ac.kr': 'saint', 'https://smartid.ssu.ac.kr': 'smartid', 'https://ecc.ssu.ac.kr': 'ecc'};
        const origin = originNames[url.origin] ?? 'other';
        const roles: Record<string, AuthHttpTraceEntry['pathRole']> = {
          'lms:/mypage': 'lms_home', 'lms:/xn-sso/login.php': 'lms_login', 'lms:/xn-sso/gw.php': 'lms_gateway',
          'lms:/xn-sso/gw-cb.php': 'lms_callback', 'canvas:/learningx/login/from_cc': 'canvas_frame',
          'canvas:/login/canvas': 'canvas_login', 'canvas:/': 'canvas_home', 'canvas:/learningx/dashboard': 'canvas_dashboard',
          'saint:/webSSO/sso.jsp': 'saint_sso_entry', 'saint:/webSSUMain/main_student.jsp': 'saint_identity_page',
          'smartid:/Symtra_sso/smln.asp': 'smartid_login',
        };
        rows.push(Object.freeze({method, origin, pathRole: roles[origin + ':' + url.pathname] ?? 'other', status: response.status}));
      }
    } catch { /* Diagnostics cannot change transport success or its failure. */ }
    return response;
  };
  return {fetch: observed, snapshot: () => Object.freeze([...rows])};
}

// Evidence is request-local and never becomes an enumerable error field or stored school data.
const failures = new WeakMap<object, AuthFailureDiagnostic>();
function fixed(stage: unknown, code: unknown, evidence: Partial<AuthFailureDiagnostic> = {}): AuthFailureDiagnostic {
  const verificationStage = verificationStages.includes(evidence.verificationStage!) ? evidence.verificationStage : undefined;
  const identityShape = verificationStage === 'identity_parse' && identityShapes.includes(evidence.identityShape!)
    && ((code === 'identity_mismatch' && evidence.identityShape === 'id_mismatch')
      || (code === 'authentication_required' && evidence.identityShape !== 'id_mismatch')) ? evidence.identityShape : undefined;
  const portal = identityShape && portalShapes.includes(evidence.portalShape!) && evidence.portalMarkup
    && !Array.isArray(evidence.portalMarkup) && portalMarkupKeys.every(key => typeof evidence.portalMarkup![key] === 'boolean')
    ? {portalShape: evidence.portalShape, portalMarkup: Object.freeze(Object.fromEntries(
      portalMarkupKeys.map(key => [key, evidence.portalMarkup![key]])) as unknown as PortalMarkup)} : undefined;
  const navigation = evidence.portalNavigation;
  const portalNavigation = portal && navigation && !Array.isArray(navigation) && navigationPlacements.includes(navigation.scriptPlacement)
    && [navigation.scriptTarget, navigation.formTarget, navigation.metaRefreshTarget].every(value => navigationTargets.includes(value))
    ? Object.freeze({scriptPlacement: navigation.scriptPlacement, scriptTarget: navigation.scriptTarget,
      formTarget: navigation.formTarget, metaRefreshTarget: navigation.metaRefreshTarget}) : undefined;
  return Object.freeze({
    stage: stages.includes(stage as AuthFailureStage) ? stage as AuthFailureStage : 'unknown',
    code: codes.includes(code as typeof codes[number]) ? code as typeof codes[number] : 'unknown',
    ...(verificationStage ? {verificationStage} : {}),
    ...(identityShape ? {identityShape} : {}),
    ...portal,
    ...(portalNavigation ? {portalNavigation} : {}),
    ...context(evidence),
  });
}
export function rememberAuthFailure(error: unknown, diagnostic: AuthFailureDiagnostic): void {
  if (typeof error === 'object' && error !== null) failures.set(error, fixed(diagnostic.stage, diagnostic.code, diagnostic));
}
export function authFailureDiagnostic(error: unknown, fallback: AuthFailureStage = 'unknown'): AuthFailureDiagnostic {
  if (typeof error === 'object' && error !== null) {
    const stored = failures.get(error); if (stored) return stored;
  }
  if (error instanceof SchoolSsoVerificationError) return fixed(fallback, error.code,
    {verificationStage: error.verificationStage, identityShape: error.identityShape, portalShape: error.portalShape, portalMarkup: error.portalMarkup, portalNavigation: error.portalNavigation});
  if (error instanceof SchoolError) return fixed(fallback, error.code);
  if (error instanceof ZodError) return fixed(fallback, 'invalid_request');
  if (error instanceof AppError) {
    const code: Record<string, typeof codes[number]> = {
      INVALID_REQUEST: 'invalid_request', INVALID_CALLBACK: 'invalid_callback', SCHOOL_AUTH_FAILED: 'school_auth_failed',
      SCHOOL_AUTH_UNAVAILABLE: 'school_auth_unavailable', SCHOOL_UPSTREAM_UNAVAILABLE: 'school_upstream_unavailable',
      INTERNAL_ERROR: 'internal_error',
    };
    return fixed(fallback, code[error.code]);
  }
  return fixed(fallback, 'unknown');
}
