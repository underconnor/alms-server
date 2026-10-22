import { boundedWorkerOperation } from './worker-bounds.js';
import { normalizeSchoolReadError } from './school-read.js';
import { z } from 'zod';
import { SchoolHttpClient,initializeLearningxClient,SchoolError } from '@alms/ssu-api';
import { decryptSchoolSession,encryptSchoolSession } from './crypto.js';
import { withSchoolSessionLock } from './school-session-lock.js';
import { AppError } from './errors.js';
import type { SubmissionSchool,SubmissionInput,Validate,Receipt,SchoolObservation } from './assignment-submission-types.js';
import { publicAssignmentDetail } from './assignments.js';
import type { PgStore } from './store.js';
import type { SchoolReadCache } from './school-read-cache.js';
// SDK types are inferred after its reviewed release is installed in vendor.
const sessionSchema=z.object({version:z.literal(1),generation:z.uuid(),identity:z.object({studentId:z.string().regex(/^\d{6,12}$/)}).passthrough(),jar:z.unknown()}).passthrough();
export function createAssignmentSubmissionSchool(store:PgStore,key:Buffer,invalidateRead:(owner:string,course:string)=>Promise<void>,cache?:SchoolReadCache):SubmissionSchool {
 async function session(owner:string){const raw=await store.getEncryptedSchoolSession(owner,'ssu');if(!raw)throw new AppError(401,'SCHOOL_AUTH_REQUIRED','학교 인증을 다시 확인해 주세요.');try{return {raw,value:sessionSchema.parse(decryptSchoolSession(raw,key,owner,'ssu'))};}catch{throw new AppError(401,'SCHOOL_AUTH_REQUIRED','학교 인증을 다시 확인해 주세요.');}}
 async function execute<T>(owner:string,generation:string|undefined,validate:Validate,signal:AbortSignal,run:(client:Awaited<ReturnType<typeof initializeLearningxClient>>,validate:Validate,generation:string)=>Promise<T>):Promise<T>{
  return boundedWorkerOperation(boundedSignal=>{signal=boundedSignal;return withSchoolSessionLock(owner,async()=>{await validate();signal.throwIfAborted();const before=await session(owner);if(generation&&before.value.generation!==generation)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');
   const current=async()=>{await validate();signal.throwIfAborted();const after=await session(owner);if(after.value.generation!==before.value.generation||after.value.identity.studentId!==before.value.identity.studentId)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');};
   const guardedFetch:typeof fetch=async(input,init)=>{await current();const response=await fetch(input,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});return response;};
   const http=SchoolHttpClient.fromSessionJar(before.value.jar,guardedFetch);const client=await initializeLearningxClient(http,before.value.identity.studentId);await current();
   const result=await run(client,current,before.value.generation);await current();
   // Jar persistence is best effort after a school result. Generation changes are never hidden.
   const latest=await session(owner);if(latest.value.generation!==before.value.generation)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');
   const updated=encryptSchoolSession({...latest.value,jar:await http.jar.serialize()},key,owner,'ssu');await store.replaceEncryptedSchoolSession(owner,'ssu',latest.raw,updated).catch(()=>{});await current();return result;
  });},{signal,timeoutMs:240000});
 }
 const receipt=(submission:{attempt:number|null;submittedAt:string|null}|null):Receipt|null=>submission?{attempt:submission.attempt,submittedAt:submission.submittedAt}:null;
 return {
  options:async(owner,c,a,validate,signal)=>execute(owner,undefined,validate,signal,async(client,_current,generation)=>({...await client.assignmentSubmissionOptions(c,a,{signal}),generation})).catch(normalizeSchoolReadError),
  submit:async(owner,c,a,generation,input,files,validate,beforeUpload,beforeWrite,signal)=>execute(owner,generation,validate,signal,async(client,current)=>{
   const content={submissionType:input.submissionType,expectedAttempt:input.expectedAttempt,pledgeDigest:input.pledgeDigest,pledgeAcceptedAt:input.pledgeAccepted?new Date().toISOString():null,...(input.submissionType==='online_upload'?{files}:input.submissionType==='online_text_entry'?{text:input.text}:{url:input.url})};
   const result=await client.submitAssignment(c,a,content,{signal,beforeUpload:async()=>{await current();await beforeUpload();},beforeWrite:async r=>{await current();await beforeWrite(r);}});return {state:result.state,privateReceipt:result.receipt,receipt:receipt(result.submission)};
  }),
  reconcile:async(owner,c,a,privateReceipt,validate,signal)=>execute(owner,undefined,validate,signal,async(client,current)=>{
   await current();const result=await client.reconcileAssignmentSubmission(c,a,privateReceipt as Parameters<typeof client.reconcileAssignmentSubmission>[2],{signal});return {state:result.state,privateReceipt:result.receipt,receipt:receipt(result.submission)};
  }),
  observe:async(owner,c,a,validate,signal)=>{
   const result=await execute(owner,undefined,validate,signal,async(client,_current,generation)=>{
    const detail=publicAssignmentDetail(await client.assignmentDetail(c,a,signal),c,a),submission=detail.submission;
    const observation:SchoolObservation={workflowState:submission?.workflowState??'unknown',attempt:submission?.attempt??null,submittedAt:submission?.submittedAt??null,observedAt:new Date().toISOString(),attribution:'unattributed'};
    return {observation,generation};
   }).catch(normalizeSchoolReadError);
   await validate();const latest=await session(owner);if(latest.value.generation!==result.generation)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');
   return {...result,encryptedSession:latest.raw};
  },
  invalidate:async(owner,c)=>{await invalidateRead(owner,c);if(cache)await cache.delete(owner,'ssu');},
 };
}
