import { boundedWorkerOperation } from './worker-bounds.js';
import { AppError,notFound } from './errors.js';
import { limits,publicOperation,publicUpload,type ReleaseAuthority,type SubmissionSchool,type SubmissionRepository,type SubmissionInput,type UploadInput,type Validate,type StoredOperation,type SchoolOptions } from './assignment-submission-types.js';
import type { Readable } from 'node:stream';
import { assignmentSubmissionFailureDiagnostic, type AssignmentSubmissionFailureDiagnostic } from './assignment-submission-diagnostics.js';
import { submissionFeature } from './feature-support.js';
const busy=()=>new AppError(409,'SUBMISSION_BUSY','진행 중인 제출 결과를 먼저 확인해 주세요.');
export class AssignmentSubmissionService {
 private running=new Set<Promise<void>>();private executing=new Set<string>(); private closing=false;private shutdown=new AbortController();private closePromise:Promise<void>|undefined;
 constructor(private repo:SubmissionRepository,private school:SubmissionSchool,private onFailure?:(diagnostic:AssignmentSubmissionFailureDiagnostic)=>void){}
 private observeFailure(error:unknown,stage:AssignmentSubmissionFailureDiagnostic['stage'],outcome:AssignmentSubmissionFailureDiagnostic['outcome'],mayHaveWritten:boolean,operationId?:string){
  const diagnostic=assignmentSubmissionFailureDiagnostic(error,{stage,outcome,mayHaveWritten,operationId});try{this.onFailure?.(diagnostic);}catch{/* Logging cannot change state, authority or retry behavior. */}return diagnostic;
 }
 private permitted(options:SchoolOptions,input?:SubmissionInput){
  if(!options.supported||options.blockedReason)throw new AppError(409,'SUBMISSION_BLOCKED','현재 학교 제출 조건을 확인할 수 없거나 제출할 수 없는 과제입니다.');
  if(input&&(!options.modes.includes(input.submissionType)||options.expectedAttempt!==input.expectedAttempt))throw new AppError(409,'SUBMISSION_CHANGED','학교 제출 조건이 바뀌었습니다. 내용을 다시 확인해 주세요.');
  if(input&&options.pledge.digest!==input.pledgeDigest)throw new AppError(409,'SUBMISSION_CHANGED','학교 확인 문구가 변경됐습니다. 내용을 다시 확인해 주세요.');
  if(input&&options.pledge.required&&!input.pledgeAccepted)throw new AppError(400,'PLEDGE_REQUIRED','학교에서 요구하는 본인 작성 확인을 선택해 주세요.');
 }
 private checkFile(options:SchoolOptions,file:UploadInput){if(!options.modes.includes('online_upload'))throw new AppError(409,'SUBMISSION_BLOCKED','파일 제출을 지원하지 않는 과제입니다.');const ext=file.fileName.includes('.')?file.fileName.split('.').pop()!.toLowerCase():'';
  if(options.allowedExtensions?.length&&!options.allowedExtensions.map(x=>x.toLowerCase()).includes(ext))throw new AppError(400,'FILE_TYPE_NOT_ALLOWED','학교에서 허용한 확장자의 파일을 선택해 주세요.');}
 async options(owner:string,c:string,a:string,validate:Validate,signal:AbortSignal){await this.repo.cleanup();const options=await this.school.options(owner,c,a,validate,signal);const currentOperation=await this.repo.current(owner,c,a);await validate();const {generation,...publicOptions}=options;return {...publicOptions,maxFileBytes:limits.maxFileBytes,maxFiles:limits.maxFiles,maxTotalBytes:limits.maxTotalBytes,currentOperation,
  featureSupport:{assignment_submission:submissionFeature(options,!!currentOperation&&!currentOperation.recovery?.release&&['preparing','sending','needs_confirmation'].includes(currentOperation.state))}};}
 async reserve(owner:string,c:string,a:string,input:UploadInput,validate:Validate,signal:AbortSignal){const options=await this.school.options(owner,c,a,validate,signal);this.permitted(options);this.checkFile(options,input);await validate();return publicUpload(await this.repo.reserve(owner,c,a,options.generation,input));}
 async receive(owner:string,c:string,a:string,id:string,stream:Readable,validate:Validate,signal:AbortSignal){return publicUpload(await this.repo.receive(owner,c,a,id,stream,validate,signal));}
 async cancel(owner:string,c:string,a:string,id:string){await this.repo.cancel(owner,c,a,id);}
 async current(owner:string,c:string,a:string,key?:string){await this.repo.cleanup();return this.repo.current(owner,c,a,key);}
 async status(owner:string,c:string,a:string,id:string){await this.repo.cleanup();const value=await this.repo.get(owner,c,a,id);if(!value)throw notFound();return publicOperation(value);}
 async submit(owner:string,c:string,a:string,key:string,input:SubmissionInput,validate:Validate){
  if(this.closing)throw new AppError(503,'SERVICE_RESTARTING','서버가 재시작 중입니다. 잠시 후 다시 확인해 주세요.');
  await validate();const existing=await this.repo.existing(owner,c,a,key,input);if(existing)return existing;
  // All new work must pass fresh school conditions.
  const signal=AbortSignal.any([AbortSignal.timeout(25000),this.shutdown.signal]),options=await this.school.options(owner,c,a,validate,signal);this.permitted(options,input);await validate();signal.throwIfAborted();
  if(this.closing)throw new AppError(503,'SERVICE_RESTARTING','서버가 재시작 중입니다. 잠시 후 다시 확인해 주세요.');
  const made=await this.repo.create(owner,c,a,options.generation,key,input);
  if(made.created){const task=this.run(owner,c,a,made.operation.id,validate);this.running.add(task);void task.finally(()=>this.running.delete(task)).catch(()=>{});}
  return made.operation;
 }
 private async run(owner:string,c:string,a:string,id:string,validate:Validate){
  this.executing.add(id);
  let op:StoredOperation|null=null,mayHaveWritten=false,stage:AssignmentSubmissionFailureDiagnostic['stage']='conditions',failure:AssignmentSubmissionFailureDiagnostic|undefined;
  const signal=AbortSignal.any([AbortSignal.timeout(4*60*1000),this.shutdown.signal]);
  try{signal.throwIfAborted();op=await this.repo.claim(owner,c,a,id);if(!op?.workerToken)return;if(!op.input)throw new Error('missing_submission_input');const token=op.workerToken;
   const options=await this.school.options(owner,c,a,validate,signal);if(options.generation!==op.generation)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');this.permitted(options,op.input);
   const files=await this.repo.files(owner,c,a,op.generation,op.input.uploadIds??[]);for(const file of files)this.checkFile(options,file);await validate();signal.throwIfAborted();
   const beforeUpload=async()=>{await validate();signal.throwIfAborted();await this.repo.save(owner,id,token,'sending',null);mayHaveWritten=true;stage='upload';};
   const beforeWrite=async(receipt:unknown)=>{await validate();signal.throwIfAborted();await this.repo.save(owner,id,token,'sending',null,receipt);mayHaveWritten=true;stage='submit';};
   const result=await this.school.submit(owner,c,a,op.generation,op.input,files,validate,beforeUpload,beforeWrite,signal);
   await this.repo.save(owner,id,token,result.state,result.state==='confirmed'?null:'RESULT_UNCONFIRMED',result.privateReceipt,result.receipt);
   if(result.state==='needs_confirmation')failure=this.observeFailure(undefined,'reconcile','unknown',mayHaveWritten,id);
   // Invalidation is a follow-up to confirmed school state. A failed cache clear cannot repeat a submission.
   if(result.state==='confirmed')await this.school.invalidate(owner,c).catch(()=>{});
  }catch(error){if(op?.workerToken){const e=error as {outcome?:unknown;code?:unknown};const unknown=e.outcome==='unknown'||mayHaveWritten&&e.outcome!=='not_sent'&&e.outcome!=='rejected';const code=unknown?'RESULT_UNCONFIRMED':['AUTH_REQUIRED','SCHOOL_AUTH_REQUIRED','authentication_required','identity_mismatch'].includes(String(e.code))?'AUTH_REQUIRED':e.code==='SCHOOL_SESSION_CHANGED'?'SCHOOL_SESSION_CHANGED':'SUBMISSION_REJECTED';await this.repo.save(owner,id,op.workerToken,unknown?'needs_confirmation':'rejected',code).catch(()=>{});failure=this.observeFailure(error,stage,unknown?'unknown':'rejected',mayHaveWritten,id);}}
  finally{if(op){await this.repo.releaseFiles(owner,op.input?.uploadIds??[]).catch(()=>{});if(op.workerToken)await this.repo.finishExecution(owner,id,op.workerToken,failure).catch(()=>{});}this.executing.delete(id);}
 }
 async reconcile(owner:string,c:string,a:string,id:string,validate:Validate){
  await validate();await this.repo.cleanup();const current=await this.repo.get(owner,c,a,id);if(!current)throw notFound();if(current.state==='confirmed'||current.state==='rejected'||current.release)return publicOperation(current);if(current.state!=='needs_confirmation'||this.executing.has(id))throw busy();
  const op=await this.repo.claimConfirmation(owner,c,a,id);if(!op?.workerToken)throw busy();
  try{const signal=AbortSignal.any([AbortSignal.timeout(90000),this.shutdown.signal]);
   if(op.privateReceipt){
    try{const result=await this.school.reconcile(owner,c,a,op.privateReceipt,validate,signal);await validate();if(result.state==='confirmed'){await this.repo.save(owner,id,op.workerToken,'confirmed',null,result.privateReceipt,result.receipt);await this.school.invalidate(owner,c).catch(()=>{});return this.status(owner,c,a,id);}}
    catch(error){this.observeFailure(error,'reconcile','unknown',false,id);}
   }
   // Exact-receipt reads may refresh the cookie jar. Capture the observation proof afterwards.
   const proof=await this.school.observe(owner,c,a,validate,signal);await validate();signal.throwIfAborted();await this.repo.observe(owner,c,a,id,op.workerToken,proof);await this.school.invalidate(owner,c).catch(()=>{});
  }catch(error){await this.repo.releaseConfirmation(owner,id,op.workerToken).catch(()=>{});this.observeFailure(error,'reconcile','unknown',false,id);throw error;}
  return this.status(owner,c,a,id);
 }
 async release(owner:string,c:string,a:string,id:string,observedAt:string,validate:Validate,authority:ReleaseAuthority){
  await validate();if(this.closing)throw new AppError(503,'SERVICE_RESTARTING','서버가 재시작 중입니다. 잠시 후 다시 확인해 주세요.');
  await this.repo.cleanup();const current=await this.repo.get(owner,c,a,id);if(!current)throw notFound();if(current.release)return publicOperation(current);
  if(current.state!=='needs_confirmation'||this.executing.has(id))throw busy();
  if(current.schoolObservation?.observedAt!==observedAt)throw new AppError(409,'RECOVERY_CHANGED','학교 기록을 다시 확인한 뒤 작업을 정리해 주세요.');
  const op=await this.repo.claimConfirmation(owner,c,a,id);if(!op?.workerToken)throw busy();
  try{const signal=AbortSignal.any([AbortSignal.timeout(90000),this.shutdown.signal]),proof=await this.school.observe(owner,c,a,validate,signal);await validate();signal.throwIfAborted();await this.repo.release(owner,c,a,id,op.workerToken,observedAt,proof,authority);await this.school.invalidate(owner,c).catch(()=>{});}
  catch(error){await this.repo.releaseConfirmation(owner,id,op.workerToken).catch(()=>{});throw error;}
  return this.status(owner,c,a,id);
 }
 stop(){this.closing=true;this.shutdown.abort();}
 close():Promise<void>{this.stop();return this.closePromise??=boundedWorkerOperation(()=>Promise.allSettled([...this.running]),{timeoutMs:7000}).then(()=>{},()=>{});}
}
