import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { AssignmentSubmissionFailureDiagnostic } from './assignment-submission-diagnostics.js';
export const limits = { maxFileBytes:20*1024*1024,maxFiles:5,maxTotalBytes:40*1024*1024,ownerBytes:80*1024*1024,totalBytes:512*1024*1024,ownerFiles:25,totalFiles:1000,maxOperationsPerOwner:1000,maxOperations:10000,ttlMs:60*60*1000 };
export const mode = z.enum(['online_upload','online_text_entry','online_url']);
export const uploadInput = z.object({fileName:z.string().min(1).max(255).refine(s=>!/[\\/\x00-\x1f\x7f]/.test(s)&&s!=='.'&&s!=='..'&&s.trim()===s),contentType:z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).max(128),sizeBytes:z.number().int().min(1).max(limits.maxFileBytes)}).strict();
export const submissionInput = z.object({submissionType:mode,expectedAttempt:z.number().int().min(0).nullable(),pledgeAccepted:z.boolean(),pledgeDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),uploadIds:z.array(z.uuid()).max(limits.maxFiles).optional(),text:z.string().max(100000).refine(s=>Buffer.byteLength(s)<=120000).optional(),url:z.url().max(2048).optional()}).strict().superRefine((x,c)=>{
 const valid=x.submissionType==='online_upload'?!!x.uploadIds?.length&&new Set(x.uploadIds).size===x.uploadIds.length&&x.text===undefined&&x.url===undefined:x.submissionType==='online_text_entry'?!!x.text?.trim()&&x.url===undefined&&!x.uploadIds:!!x.url&&/^https?:\/\//.test(x.url)&&!x.text&&!x.uploadIds;
 if(!valid)c.addIssue({code:'custom',message:'Invalid submission content'});
});
export type SubmissionInput=z.infer<typeof submissionInput>;
export type UploadInput=z.infer<typeof uploadInput>;
export type OperationState='preparing'|'sending'|'confirmed'|'rejected'|'needs_confirmation';
export type Receipt={attempt:number|null;submittedAt:string|null};
export type SchoolObservation={workflowState:'unsubmitted'|'submitted'|'graded'|'pending_review'|'unknown';attempt:number|null;submittedAt:string|null;observedAt:string;attribution:'unattributed'};
export type RecoveryRelease={kind:'upload_failed_before_submit'|'school_submission_present';releasedAt:string};
export type Recovery={schoolObservation:SchoolObservation|null;release:RecoveryRelease|null;releaseAvailable:boolean};
export type ObservationProof={observation:SchoolObservation;generation:string;encryptedSession:string};
export type ReleaseAuthority={sessionHash:string;csrfToken:string};
export type Operation={id:string;courseId:string;assignmentId:string;state:OperationState;submissionType:z.infer<typeof mode>;createdAt:string;updatedAt:string;errorCode:string|null;receipt:Receipt|null;reconciliationAvailable?:boolean;recovery?:Recovery};
export type StoredOperation=Operation&{owner:string;generation:string;input:SubmissionInput|null;privateReceipt:unknown|null;workerToken:string|null;leaseExpiresAt:string|null;executionProtocol?:number|null;writeStartedAt?:string|null;executionFinishedAt?:string|null;schoolObservation?:SchoolObservation|null;observationGeneration?:string|null;release?:RecoveryRelease|null};
export type Upload={id:string;status:'reserved'|'uploading'|'ready'|'consumed';fileName:string;contentType:string;sizeBytes:number;expiresAt:string;generation:string;sha256:string|null};
export type SchoolOptions={supported:boolean;modes:z.infer<typeof mode>[];blockedReason:string|null;allowedExtensions:string[]|null;expectedAttempt:number|null;pledge:{required:boolean;text:string|null;digest:string|null};generation:string};
export type Validate=()=>Promise<void>;
export interface SubmissionSchool {
 options(owner:string,course:string,assignment:string,validate:Validate,signal:AbortSignal):Promise<SchoolOptions>;
 submit(owner:string,course:string,assignment:string,generation:string,input:SubmissionInput,files:Array<{fileName:string;contentType:string;bytes:Uint8Array}>,validate:Validate,beforeUpload:Validate,beforeWrite:(receipt:unknown)=>Promise<void>,signal:AbortSignal):Promise<{state:'confirmed'|'needs_confirmation';privateReceipt:unknown;receipt:Receipt|null}>;
 reconcile(owner:string,course:string,assignment:string,receipt:unknown,validate:Validate,signal:AbortSignal):Promise<{state:'confirmed'|'needs_confirmation';privateReceipt:unknown;receipt:Receipt|null}>;
 observe(owner:string,course:string,assignment:string,validate:Validate,signal:AbortSignal):Promise<ObservationProof>;
 invalidate(owner:string,course:string):Promise<void>;
}
export interface SubmissionRepository {
 reserve(owner:string,course:string,assignment:string,generation:string,input:UploadInput):Promise<Upload>;
 receive(owner:string,course:string,assignment:string,id:string,source:Readable,validate:Validate,signal:AbortSignal):Promise<Upload>;
 cancel(owner:string,course:string,assignment:string,id:string):Promise<void>;
 files(owner:string,course:string,assignment:string,generation:string,ids:string[]):Promise<Array<Upload&{bytes:Uint8Array}>>;
 existing(owner:string,course:string,assignment:string,key:string,input:SubmissionInput):Promise<Operation|null>;
 create(owner:string,course:string,assignment:string,generation:string,key:string,input:SubmissionInput):Promise<{operation:Operation;created:boolean}>;
 current(owner:string,course:string,assignment:string,idempotencyKey?:string):Promise<Operation|null>;
 get(owner:string,course:string,assignment:string,id:string):Promise<StoredOperation|null>;
 claim(owner:string,course:string,assignment:string,id:string):Promise<StoredOperation|null>;
 claimConfirmation(owner:string,course:string,assignment:string,id:string):Promise<StoredOperation|null>;
 save(owner:string,id:string,token:string,state:OperationState,error:string|null,privateReceipt?:unknown,receipt?:Receipt|null):Promise<void>;
 finishExecution(owner:string,id:string,token:string,diagnostic?:AssignmentSubmissionFailureDiagnostic):Promise<void>;
 observe(owner:string,course:string,assignment:string,id:string,token:string,proof:ObservationProof):Promise<void>;
 releaseConfirmation(owner:string,id:string,token:string):Promise<void>;
 release(owner:string,course:string,assignment:string,id:string,token:string,observedAt:string,proof:ObservationProof,authority:ReleaseAuthority):Promise<void>;
 releaseFiles(owner:string,ids:string[]):Promise<void>;
 cleanup():Promise<void>;
}
export function publicOperation(o:Operation):Operation {
 const stored=o as StoredOperation;
 const recovery=Object.hasOwn(o,'schoolObservation')?{schoolObservation:stored.schoolObservation??null,release:stored.release??null,releaseAvailable:canRelease(stored)}:o.recovery;
 const available=o.state==='needs_confirmation'&&!recovery?.release?true:false;
 return {id:o.id,courseId:o.courseId,assignmentId:o.assignmentId,state:o.state,submissionType:o.submissionType,createdAt:o.createdAt,updatedAt:o.updatedAt,errorCode:o.errorCode,receipt:o.receipt,
  reconciliationAvailable:available,...(recovery?{recovery}:{})};
}
export function schoolSubmissionPresent(o:SchoolObservation){return ['submitted','graded','pending_review'].includes(o.workflowState)&&o.attempt!==null&&o.attempt>0&&o.submittedAt!==null;}
export function canRelease(o:StoredOperation,now=Date.now()){
 const observed=o.schoolObservation;if(o.state!=='needs_confirmation'||o.release||!observed||now-Date.parse(observed.observedAt)>5*60*1000||Date.parse(observed.observedAt)>now+1000)return false;
 if(o.leaseExpiresAt&&Date.parse(o.leaseExpiresAt)>now)return false;
 return schoolSubmissionPresent(observed)||(o.executionProtocol===1&&!!o.executionFinishedAt&&!o.writeStartedAt&&!o.privateReceipt&&observed.workflowState==='unsubmitted');
}
export function publicUpload(u:Upload){return {id:u.id,status:u.status,fileName:u.fileName,sizeBytes:u.sizeBytes,expiresAt:u.expiresAt};}
