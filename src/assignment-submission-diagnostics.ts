import { SchoolError, SchoolAssignmentWriteError } from '@alms/ssu-api';
import { AppError } from './errors.js';

const stages = ['conditions', 'upload', 'submit', 'verify', 'reconcile', 'unknown'] as const;
const outcomes = ['not_sent', 'rejected', 'unknown'] as const;
const uploadSteps=['prepare','initialize_request','initialize_response','receiver_request','completion_target','completion_request','completion_response','metadata'] as const;
const codes = ['authentication_required', 'identity_mismatch', 'upstream_unavailable', 'unexpected_response', 'forbidden_target', 'unsupported',
  'AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED', 'SCHOOL_SESSION_CHANGED', 'SUBMISSION_BLOCKED', 'SUBMISSION_CHANGED', 'PLEDGE_REQUIRED',
  'FILE_TYPE_NOT_ALLOWED', 'UPLOAD_EXPIRED', 'UPLOAD_INCOMPLETE', 'UPLOAD_TOO_LARGE', 'OPERATION_CHANGED', 'RESULT_UNCONFIRMED', 'unknown'] as const;
export type AssignmentSubmissionFailureDiagnostic = Readonly<{ event: 'assignment_submission_failed';
  stage: typeof stages[number]; outcome: typeof outcomes[number]; code: typeof codes[number]; mayHaveWritten: boolean;
  uploadStep:typeof uploadSteps[number]|null;finalSubmissionMayHaveWritten:boolean|null;operationId:string|null }>;

/** Observed fixed fields only. Never retains an error, payload, URL, owner or file name. */
export function assignmentSubmissionFailureDiagnostic(error: unknown, context: {
  stage?: AssignmentSubmissionFailureDiagnostic['stage']; outcome: AssignmentSubmissionFailureDiagnostic['outcome']; mayHaveWritten: boolean;operationId?:string;
}): AssignmentSubmissionFailureDiagnostic {
  let stage = context.stage ?? 'unknown', outcome = context.outcome, code: AssignmentSubmissionFailureDiagnostic['code'] = 'unknown';
  let uploadStep:AssignmentSubmissionFailureDiagnostic['uploadStep']=null,finalSubmissionMayHaveWritten:boolean|null=null;
  try {
    if (error instanceof SchoolAssignmentWriteError) {
      if (stages.includes(error.stage)) stage = error.stage;
      if (outcomes.includes(error.outcome)) outcome = error.outcome;
      const extra=error as SchoolAssignmentWriteError&{uploadStep?:unknown;finalSubmissionMayHaveWritten?:unknown};
      if(typeof extra.uploadStep==='string'&&uploadSteps.includes(extra.uploadStep as typeof uploadSteps[number]))uploadStep=extra.uploadStep as typeof uploadSteps[number];
      if(typeof extra.finalSubmissionMayHaveWritten==='boolean')finalSubmissionMayHaveWritten=extra.finalSubmissionMayHaveWritten;
    }
    if (error instanceof SchoolError || error instanceof AppError) {
      if (typeof error.code === 'string' && codes.includes(error.code as AssignmentSubmissionFailureDiagnostic['code'])) code = error.code as AssignmentSubmissionFailureDiagnostic['code'];
    }
  } catch { /* Diagnostic access cannot replace the original failure. */ }
  return Object.freeze({ event: 'assignment_submission_failed', stage: stages.includes(stage) ? stage : 'unknown',
    outcome: outcomes.includes(outcome) ? outcome : 'unknown', code, mayHaveWritten: context.mayHaveWritten === true,uploadStep,finalSubmissionMayHaveWritten,
    operationId:typeof context.operationId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(context.operationId)?context.operationId:null });
}
