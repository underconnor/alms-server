import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, SchoolAssignmentWriteError } from '@alms/ssu-api';
import { AppError } from '../src/errors.js';
import { assignmentSubmissionFailureDiagnostic } from '../src/assignment-submission-diagnostics.js';

test('school write diagnostics retain exact fixed stage and outcome without private error data', () => {
  for (const stage of ['conditions', 'upload', 'submit', 'verify'] as const) for (const outcome of ['not_sent', 'rejected', 'unknown'] as const) {
    const error = new SchoolAssignmentWriteError(stage, outcome, 'unexpected_response');
    Object.assign(error, { message: 'private name/body/token https://private.invalid/', owner: 'private-owner', cause: new Error('private cause') });
    const result = assignmentSubmissionFailureDiagnostic(error, { outcome: 'unknown', mayHaveWritten: true });
    assert.deepEqual(result, { event: 'assignment_submission_failed', stage, outcome, code: 'unexpected_response', mayHaveWritten: true, uploadStep:null, finalSubmissionMayHaveWritten:(stage==='submit'&&outcome==='unknown')||stage==='verify', operationId:null });
    assert.equal(Object.isFrozen(result), true); assert.doesNotMatch(JSON.stringify(result), /private|body|token|url|cause|stack/i);
  }
});
test('ordinary read failures use explicit read context without claiming a new write', () => {
  const result = assignmentSubmissionFailureDiagnostic(new SchoolError('authentication_required'), { stage: 'reconcile', outcome: 'unknown', mayHaveWritten: false });
  assert.deepEqual(result, { event: 'assignment_submission_failed', stage: 'reconcile', outcome: 'unknown', code: 'authentication_required', mayHaveWritten: false, uploadStep:null, finalSubmissionMayHaveWritten:null, operationId:null });
});
test('arbitrary objects and unlisted application codes cannot inject diagnostic fields', () => {
  for (const error of [new Error('private'), { stage: 'upload', outcome: 'rejected', code: 'authentication_required', url: 'https://private.invalid/' }, new AppError(502, 'private-code', 'private')]) {
    assert.deepEqual(assignmentSubmissionFailureDiagnostic(error, { outcome: 'unknown', mayHaveWritten: false }),
      { event: 'assignment_submission_failed', stage: 'unknown', outcome: 'unknown', code: 'unknown', mayHaveWritten: false, uploadStep:null, finalSubmissionMayHaveWritten:null, operationId:null });
  }
  const throwing = new AppError(502, 'AUTH_REQUIRED', 'private'); Object.defineProperty(throwing, 'code', { get() { throw new Error('private getter'); } });
  assert.equal(assignmentSubmissionFailureDiagnostic(throwing, { outcome: 'unknown', mayHaveWritten: false }).code, 'unknown');
});
test('upload substep and operation correlation accept only fixed values and never retain error payloads',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 for(const uploadStep of ['prepare','initialize_request','initialize_response','receiver_request','completion_target','completion_request','completion_response','metadata']){
  const error=new SchoolAssignmentWriteError('upload','unknown','unexpected_response');Object.assign(error,{uploadStep,finalSubmissionMayHaveWritten:false,fileName:'private.pdf',url:'https://private.invalid/'});
  const value=assignmentSubmissionFailureDiagnostic(error,{outcome:'unknown',mayHaveWritten:true,operationId:id});assert.equal(value.uploadStep,uploadStep);assert.equal(value.finalSubmissionMayHaveWritten,false);assert.equal(value.operationId,id);assert.doesNotMatch(JSON.stringify(value),/private/);
 }
 const error=new SchoolAssignmentWriteError('upload','unknown','unexpected_response');Object.assign(error,{uploadStep:'raw/private/url',finalSubmissionMayHaveWritten:'true'});
 const value=assignmentSubmissionFailureDiagnostic(error,{outcome:'unknown',mayHaveWritten:true,operationId:'private-student-id'});assert.equal(value.uploadStep,null);assert.equal(value.finalSubmissionMayHaveWritten,null);assert.equal(value.operationId,null);
});
test('an older SDK write error without additive diagnostics remains unknown rather than false',()=>{
 const error=new SchoolAssignmentWriteError('upload','unknown','unexpected_response');Object.defineProperties(error,{uploadStep:{value:undefined},finalSubmissionMayHaveWritten:{value:undefined}});
 const value=assignmentSubmissionFailureDiagnostic(error,{outcome:'unknown',mayHaveWritten:true});assert.equal(value.uploadStep,null);assert.equal(value.finalSubmissionMayHaveWritten,null);
});
