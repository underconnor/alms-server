import { randomUUID } from 'node:crypto';
import {buildSchoolLoginUrl, SchoolHttpClient, SchoolError, verifySchoolSso, exchangeLmsSso, prepareLmsSso, LmsExchangeError} from '@alms/ssu-api';
import { z } from 'zod';
import {AppError} from './errors.js';
import {unavailableSchoolProvider, type SchoolProvider} from './provider.js';
import { createCombinedDashboard } from './school-dashboard.js';
import type { SaintReader } from './saint-reader.js';
import { createLearningxReads, type LearningxReader } from './school-read.js';
import { authFailureDiagnostic, rememberAuthFailure, rememberAuthContext, createAuthHttpTrace, type AuthFailureStage } from './auth-diagnostics.js';

type AuthOperations = { prepare: typeof prepareLmsSso; exchange: typeof exchangeLmsSso; verify: typeof verifySchoolSso };
const exchangeStage = z.enum(['preparation','certificate','canvas_frame','canvas_form','canvas_submit','bootstrap']);
const schoolErrorCode = z.enum(['authentication_required','identity_mismatch','upstream_unavailable','unexpected_response','forbidden_target','unsupported']);
const canvasParseReason = z.enum(['form_target','form_count','csrf_shape','identity_mismatch','issued_payload_count',
  'issued_payload_format','key_format','decrypt_failed','decoded_value_invalid']);
const count = z.number().int().min(0).max(10000).nullable();
// Copy only fixed structural evidence. A future library field must not silently persist a body or URL.
const certificateEvidence = z.object({
  reason: z.enum(['request_failed','school_rejection_page','missing_frame','multiple_frames','invalid_frame']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  finalOrigin: z.enum(['lms','canvas','smartid','saint','other','unknown']),
  iframeCount: count,
  scriptCount: count,
  formCount: count,
  frameCandidateCount: count,
  hasSchoolRejectionText: z.boolean().nullable(),
  scriptNavigation: z.object({
    locationAssignmentPresent: z.boolean(),
    literalRedirectCount: z.number().int().min(0).max(10000),
    literalRedirectOrigin: z.enum(['none','lms','canvas','smartid','saint','other','multiple','unknown']),
    literalRedirectPath: z.enum(['none','lms_gateway','lms_login','lms_callback','lms_home','canvas_from_cc','canvas_login','canvas_dashboard','canvas_callback','other','multiple','unknown']),
  }).strip().optional(),
}).strip();
const canvasFrameEvidence = z.object({
  httpStatus: z.number().int().min(100).max(599),
  formCount: z.number().int().min(0).max(10000),
  iframeCount: z.number().int().min(0).max(10000),
  inlineScriptCount: z.number().int().min(0).max(10000),
  hasLoginCryption: z.boolean(),
  hasCanvasLoginForm: z.boolean(),
  canvasCsrfFieldState: z.enum(['absent','present','empty','multiple','unknown']).optional(),
  learningxTokenPresent: z.boolean(),
  canvasSessionCookiePresent: z.boolean(),
}).strip();
type ExchangeState = ({ status: 'ready' } | {
  status: 'failed'; stage: z.infer<typeof exchangeStage> | 'unknown'; code: z.infer<typeof schoolErrorCode>;
  certificateEvidence?: z.infer<typeof certificateEvidence>;
  canvasParseReason?: z.infer<typeof canvasParseReason>;
}) & { canvasFrameEvidence?: z.infer<typeof canvasFrameEvidence> };

function failedExchange(error: unknown): ExchangeState {
  const stage = exchangeStage.safeParse(error instanceof LmsExchangeError ? error.stage : undefined);
  const code = schoolErrorCode.safeParse(error instanceof SchoolError ? error.code : undefined);
  const evidence = certificateEvidence.safeParse(error instanceof LmsExchangeError ? error.certificateEvidence : undefined);
  // Only the parser's fixed reason may accompany a failed native form stage. Never persist an error object or cause.
  const reason = canvasParseReason.safeParse(error instanceof LmsExchangeError && error.stage === 'canvas_form'
    ? error.canvasParseReason : undefined);
  return { status: 'failed',stage: stage.success ? stage.data : 'unknown',code: code.success ? code.data : 'unexpected_response',
    ...(evidence.success ? { certificateEvidence: evidence.data } : {}),
    ...(reason.success ? { canvasParseReason: reason.data } : {}) };
}
/** The public library owns school transport; this adapter exposes only validated identity. */
export function createSchoolProvider(enabled: boolean, reader?: LearningxReader,
  operations: AuthOperations = { prepare: prepareLmsSso, exchange: exchangeLmsSso, verify: verifySchoolSso }, saint?: SaintReader,
  fetcher: typeof fetch = fetch, playbackSelectable = false): SchoolProvider {
  if (!enabled) return unavailableSchoolProvider;
  return {
    capabilities:{schoolAuthentication:true,schoolRead:Boolean(reader || saint),playback:false,pauseResume:false},
    ...(reader ? createLearningxReads(reader, playbackSelectable) : {}),
    ...(saint ? createCombinedDashboard(saint, reader) : {}),
    auth:{
      providerId:'ssu',
      createLoginUrl:buildSchoolLoginUrl,
      async verifyCallback(artifact){
        const trace = createAuthHttpTrace(fetcher);
        const client=new SchoolHttpClient(undefined, trace.fetch);
        let stage: AuthFailureStage = 'lms_preparation';
        let lmsExchange: ExchangeState | undefined;
        try {
          let frameEvidence: z.infer<typeof canvasFrameEvidence> | undefined;
          try {
            // Keep the established LMS bootstrap as the default. Native Canvas sign-in
            // remains a separate integration until its fresh SSO exchange is verified.
            await operations.prepare(client,{canvasLogin:false});
            stage = 'lms_exchange';
            await operations.exchange(client,artifact,{
              tokenFormat:'api_callback',
              onCanvasFrame: evidence => {
                const parsed = canvasFrameEvidence.safeParse(evidence);
                frameEvidence = parsed.success ? parsed.data : undefined;
              },
            });
            lmsExchange = { status: 'ready' };
          } catch (error) {
            lmsExchange = failedExchange(error);
            // A different Canvas identity is a failed login, even if portal identity later matches.
            if (error instanceof SchoolError && error.code === 'identity_mismatch') throw error;
          }
          if (frameEvidence) lmsExchange.canvasFrameEvidence = frameEvidence;
          stage = 'school_identity';
          const identity=await operations.verify(client,artifact);
          stage = 'provider_session';
          const verified = {subject:identity.studentId,displayName:identity.displayName,
            schoolSession:{version:1,generation:randomUUID(),identity,jar:await client.jar.serialize(),lmsExchange}};
          rememberAuthContext(verified, {lmsExchange, schoolTrace: trace.snapshot()});
          return verified;
        } catch(error){
          if(error instanceof SchoolError){
            const denied=['authentication_required','identity_mismatch'].includes(error.code);
            const normalized = new AppError(denied?401:502,denied?'SCHOOL_AUTH_FAILED':'SCHOOL_UPSTREAM_UNAVAILABLE',
              denied?'학교 인증을 확인할 수 없습니다. 다시 로그인해 주세요.':'학교 로그인 확인 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            rememberAuthFailure(normalized, {...authFailureDiagnostic(error, stage), lmsExchange, schoolTrace: trace.snapshot()});
            throw normalized;
          }
          const normalized = new AppError(502,'SCHOOL_UPSTREAM_UNAVAILABLE','학교 로그인 확인 요청을 처리하지 못했습니다.');
          rememberAuthFailure(normalized, {...authFailureDiagnostic(error, stage), lmsExchange, schoolTrace: trace.snapshot()});
          throw normalized;
        }
      }
    }
  };
}
