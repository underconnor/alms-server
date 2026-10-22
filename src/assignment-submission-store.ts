import { createHash,createHmac,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { Readable } from 'node:stream';
import { encryptSchoolSession,decryptSchoolSession } from './crypto.js';
import { AppError,notFound } from './errors.js';
import type { AssignmentSubmissionFailureDiagnostic } from './assignment-submission-diagnostics.js';
import { limits,publicOperation,schoolSubmissionPresent,type ReleaseAuthority,type ObservationProof,type SubmissionRepository,type UploadInput,type Upload,type SubmissionInput,type StoredOperation,type OperationState,type Receipt,type Validate } from './assignment-submission-types.js';
const conflict=(code='SUBMISSION_BUSY')=>new AppError(409,code,'진행 중인 제출 결과를 먼저 확인해 주세요.');
const instant=(v:Date|string)=>new Date(v).toISOString();
export class PgSubmissionRepository implements SubmissionRepository {
 constructor(private pool:Pool,private key:Buffer){}
 private seal(owner:string,purpose:string,value:unknown){return encryptSchoolSession(value,this.key,owner,`assignment:${purpose}`);}
 private open<T>(owner:string,purpose:string,value:string):T{return decryptSchoolSession(value,this.key,owner,`assignment:${purpose}`) as T;}
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s'");const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 private async lock(c:PoolClient,owner:string){await c.query("SELECT pg_advisory_xact_lock(hashtextextended('assignment:'||$1,0))",[owner]);}
 private upload(r:any):Upload{const meta=this.open<UploadInput>(r.user_id,`upload:${r.id}`,r.metadata_enc);return {id:r.id,status:r.state,...meta,expiresAt:instant(r.expires_at),generation:r.generation,sha256:r.sha256};}
 private operation(r:any):StoredOperation{return {id:r.id,owner:r.user_id,courseId:r.course_id,assignmentId:r.assignment_id,generation:r.generation,state:r.state,submissionType:r.submission_type,createdAt:instant(r.created_at),updatedAt:instant(r.updated_at),errorCode:r.error_code,receipt:r.public_receipt,input:r.input_enc?this.open(r.user_id,`input:${r.id}`,r.input_enc):null,privateReceipt:r.private_receipt_enc?this.open(r.user_id,`receipt:${r.id}`,r.private_receipt_enc):null,workerToken:r.worker_token,leaseExpiresAt:r.lease_expires_at?instant(r.lease_expires_at):null,executionProtocol:r.execution_protocol??null,writeStartedAt:r.final_write_started_at?instant(r.final_write_started_at):null,executionFinishedAt:r.execution_finished_at?instant(r.execution_finished_at):null,schoolObservation:r.school_observation??null,observationGeneration:r.observation_generation??null,release:r.recovery_released_at?{kind:r.recovery_kind,releasedAt:instant(r.recovery_released_at)}:null};}
 async cleanup(){
  // Expired execution leases never replay a school write. Missing receipt requires manual resolution.
  await this.pool.query("UPDATE assignment_operations SET state=CASE WHEN state='preparing' THEN 'rejected' ELSE 'needs_confirmation' END,error_code=CASE WHEN state='preparing' THEN 'PREPARATION_EXPIRED' ELSE 'RESULT_UNCONFIRMED' END,updated_at=now(),worker_token=NULL WHERE state IN ('preparing','sending') AND COALESCE(lease_expires_at,created_at+interval '5 minutes')<now()");
  await this.pool.query('DELETE FROM assignment_uploads WHERE expires_at<now()');
  await this.pool.query("UPDATE assignment_operations SET input_enc=NULL WHERE state IN ('confirmed','rejected') AND input_enc IS NOT NULL AND updated_at<now()-interval '1 day'");
  await this.pool.query("UPDATE assignment_operations SET private_receipt_enc=NULL WHERE state IN ('confirmed','rejected') AND private_receipt_enc IS NOT NULL AND updated_at<now()-interval '7 days'");
 }
 async reserve(owner:string,course:string,assignment:string,generation:string,input:UploadInput):Promise<Upload>{
  return this.tx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('assignment-upload-quota',0))");await this.lock(c,owner);
   await c.query('DELETE FROM assignment_uploads WHERE expires_at<now()');
   const {rows:[q]}=await c.query('SELECT COALESCE(sum(size_bytes),0)::bigint total, COALESCE(sum(size_bytes) FILTER(WHERE user_id=$1),0)::bigint own,count(*) total_count,count(*) FILTER(WHERE user_id=$1) own_count FROM assignment_uploads',[owner]);
   if(Number(q.total)+input.sizeBytes>limits.totalBytes||Number(q.own)+input.sizeBytes>limits.ownerBytes||Number(q.total_count)>=limits.totalFiles||Number(q.own_count)>=limits.ownerFiles)throw new AppError(413,'UPLOAD_QUOTA','준비 중인 파일 용량 한도를 초과했습니다. 기존 파일을 취소해 주세요.');
   const id=randomUUID(),{rows:[row]}=await c.query("INSERT INTO assignment_uploads(id,user_id,course_id,assignment_id,generation,metadata_enc,size_bytes,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',now()+interval '1 hour') RETURNING *",[id,owner,course,assignment,generation,this.seal(owner,`upload:${id}`,input),input.sizeBytes]);return this.upload(row);
  });
 }
 async receive(owner:string,course:string,assignment:string,id:string,source:Readable,validate:Validate,signal:AbortSignal):Promise<Upload>{
  await validate();signal.throwIfAborted();
  const {rows:[row]}=await this.pool.query("UPDATE assignment_uploads SET state='uploading' WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND state='reserved' AND expires_at>now() RETURNING *",[id,owner,course,assignment]);
  if(!row)throw notFound();let size=0,sequence=0,remainder=Buffer.alloc(0);const hash=createHash('sha256');
  const abort=()=>{source.destroy(new Error('upload_aborted'));};signal.addEventListener('abort',abort,{once:true});
  const chunk=async(bytes:Buffer)=>{signal.throwIfAborted();const n=sequence++;const encrypted=this.seal(owner,`chunk:${id}:${n}`,{data:bytes.toString('base64')});
   await this.tx(async c=>{const q=await c.query("UPDATE assignment_uploads SET received_bytes=received_bytes+$3,chunk_count=chunk_count+1 WHERE id=$1 AND user_id=$2 AND state='uploading' AND expires_at>now() AND received_bytes+$3<=size_bytes",[id,owner,bytes.length]);if(q.rowCount!==1)throw conflict('UPLOAD_CHANGED');await c.query('INSERT INTO assignment_upload_chunks(upload_id,sequence,encrypted_data) VALUES($1,$2,$3)',[id,n,encrypted]);});};
  try{
   for await(const incoming of source){signal.throwIfAborted();const part=Buffer.from(incoming);size+=part.length;if(size>row.size_bytes||size>limits.maxFileBytes)throw new AppError(413,'UPLOAD_TOO_LARGE','파일 크기 제한을 초과했습니다.');hash.update(part);remainder=Buffer.concat([remainder,part]);while(remainder.length>=128*1024){await chunk(remainder.subarray(0,128*1024));remainder=remainder.subarray(128*1024);}}
   if(size!==row.size_bytes)throw new AppError(400,'UPLOAD_INCOMPLETE','파일을 모두 받지 못했습니다. 다시 선택해 주세요.');if(remainder.length)await chunk(remainder);await validate();signal.throwIfAborted();
   const {rows:[ready]}=await this.pool.query("UPDATE assignment_uploads SET state='ready',sha256=$3 WHERE id=$1 AND user_id=$2 AND state='uploading' AND received_bytes=size_bytes AND expires_at>now() RETURNING *",[id,owner,hash.digest('hex')]);if(!ready)throw conflict('UPLOAD_CHANGED');return this.upload(ready);
  }catch(error){await this.pool.query("DELETE FROM assignment_uploads WHERE id=$1 AND user_id=$2 AND state='uploading'",[id,owner]);throw error;}
  finally{signal.removeEventListener('abort',abort);}
 }
 async cancel(owner:string,course:string,assignment:string,id:string){await this.pool.query("DELETE FROM assignment_uploads WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND state IN ('reserved','ready')",[id,owner,course,assignment]);}
 async files(owner:string,course:string,assignment:string,generation:string,ids:string[]){
  if(new Set(ids).size!==ids.length||ids.length>limits.maxFiles)throw conflict('INVALID_UPLOAD');const files=[];let total=0;
  for(const id of ids){const {rows:[r]}=await this.pool.query("SELECT * FROM assignment_uploads WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND generation=$5 AND state IN ('ready','consumed') AND expires_at>now()",[id,owner,course,assignment,generation]);if(!r)throw conflict('UPLOAD_EXPIRED');
   total+=r.size_bytes;if(total>limits.maxTotalBytes)throw new AppError(413,'UPLOAD_TOO_LARGE','제출 전체 용량 제한을 초과했습니다.');
   const {rows}=await this.pool.query('SELECT sequence,encrypted_data FROM assignment_upload_chunks WHERE upload_id=$1 ORDER BY sequence',[id]);if(rows.length!==r.chunk_count)throw conflict('UPLOAD_INCOMPLETE');
   const chunks=rows.map((x,i)=>{if(x.sequence!==i)throw conflict('UPLOAD_INCOMPLETE');return Buffer.from(this.open<{data:string}>(owner,`chunk:${id}:${i}`,x.encrypted_data).data,'base64');});const bytes=Buffer.concat(chunks);
   if(bytes.length!==r.size_bytes||createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw conflict('UPLOAD_INCOMPLETE');files.push({...this.upload(r),bytes});
  }return files;
 }
 async existing(owner:string,course:string,assignment:string,key:string,input:SubmissionInput){const {rows:[r]}=await this.pool.query('SELECT * FROM assignment_operations WHERE user_id=$1 AND idempotency_key=$2',[owner,key]);if(!r)return null;const hash=createHmac('sha256',this.key).update(JSON.stringify({course,assignment,input})).digest('hex');if(r.request_hash!==hash)throw conflict('IDEMPOTENCY_CONFLICT');return publicOperation(this.operation(r));}
 async create(owner:string,course:string,assignment:string,generation:string,key:string,input:SubmissionInput){
  const requestHash=createHmac('sha256',this.key).update(JSON.stringify({course,assignment,input})).digest('hex');return this.tx(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('assignment-operation-quota',0))");await this.lock(c,owner);const existing=await c.query('SELECT * FROM assignment_operations WHERE user_id=$1 AND idempotency_key=$2',[owner,key]);if(existing.rows[0]){if(existing.rows[0].request_hash!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT');return {operation:publicOperation(this.operation(existing.rows[0])),created:false};}
   if((await c.query("SELECT id FROM assignment_operations WHERE user_id=$1 AND course_id=$2 AND assignment_id=$3 AND state IN ('preparing','sending','needs_confirmation') AND recovery_released_at IS NULL",[owner,course,assignment])).rowCount)throw conflict();
   const {rows:[quota]}=await c.query("SELECT count(*) total,count(*) FILTER(WHERE user_id=$1) own,count(*) FILTER(WHERE state IN ('preparing','sending')) running FROM assignment_operations",[owner]);if(Number(quota.running)>=2)throw new AppError(409,'SUBMISSION_BLOCKED','다른 제출을 처리 중입니다. 잠시 후 제출 조건을 다시 확인해 주세요.');if(Number(quota.total)>=limits.maxOperations||Number(quota.own)>=limits.maxOperationsPerOwner)throw new AppError(409,'SUBMISSION_BLOCKED','제출 처리 이력 한도에 도달했습니다. 관리자에게 문의해 주세요.');
   let total=0;for(const uploadId of input.uploadIds??[]){const {rows:[u]}=await c.query("UPDATE assignment_uploads SET state='consumed',expires_at=now()+interval '1 hour' WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND generation=$5 AND state='ready' AND expires_at>now() RETURNING size_bytes",[uploadId,owner,course,assignment,generation]);if(!u)throw conflict('UPLOAD_EXPIRED');total+=u.size_bytes;}if(total>limits.maxTotalBytes)throw new AppError(413,'UPLOAD_TOO_LARGE','제출 전체 용량 제한을 초과했습니다.');
   const id=randomUUID(),{rows:[r]}=await c.query("INSERT INTO assignment_operations(id,user_id,course_id,assignment_id,generation,idempotency_key,request_hash,input_enc,submission_type,state,execution_protocol) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'preparing',1) RETURNING *",[id,owner,course,assignment,generation,key,requestHash,this.seal(owner,`input:${id}`,input),input.submissionType]);return {operation:publicOperation(this.operation(r)),created:true};
  });
 }
 async current(owner:string,course:string,assignment:string,idempotencyKey?:string){const {rows:[r]}=await this.pool.query('SELECT * FROM assignment_operations WHERE user_id=$1 AND course_id=$2 AND assignment_id=$3 AND ($4::uuid IS NULL OR idempotency_key=$4) ORDER BY created_at DESC LIMIT 1',[owner,course,assignment,idempotencyKey??null]);return r?publicOperation(this.operation(r)):null;}
 async get(owner:string,course:string,assignment:string,id:string){const {rows:[r]}=await this.pool.query('SELECT * FROM assignment_operations WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4',[id,owner,course,assignment]);return r?this.operation(r):null;}
 async claim(owner:string,course:string,assignment:string,id:string){const {rows:[r]}=await this.pool.query("UPDATE assignment_operations SET worker_token=$5,lease_expires_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND state='preparing' AND worker_token IS NULL RETURNING *",[id,owner,course,assignment,randomUUID()]);return r?this.operation(r):null;}
 async claimConfirmation(owner:string,course:string,assignment:string,id:string){const {rows:[r]}=await this.pool.query("UPDATE assignment_operations SET worker_token=$5,lease_expires_at=now()+interval '2 minutes' WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND state='needs_confirmation' AND recovery_released_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=now()) RETURNING *",[id,owner,course,assignment,randomUUID()]);return r?this.operation(r):null;}
 async save(owner:string,id:string,token:string,state:OperationState,error:string|null,privateReceipt?:unknown,receipt?:Receipt|null){
  const {rowCount}=await this.pool.query("UPDATE assignment_operations SET state=$4,error_code=$5,private_receipt_enc=COALESCE($6,private_receipt_enc),public_receipt=COALESCE($7,public_receipt),final_write_started_at=CASE WHEN execution_protocol=1 AND $6::text IS NOT NULL AND $4='sending' THEN COALESCE(final_write_started_at,now()) ELSE final_write_started_at END,lease_expires_at=CASE WHEN $4 IN ('confirmed','rejected','needs_confirmation') THEN now() ELSE lease_expires_at END,updated_at=now() WHERE id=$1 AND user_id=$2 AND worker_token=$3 AND recovery_released_at IS NULL AND state IN ('preparing','sending','needs_confirmation') AND lease_expires_at>now()",[id,owner,token,state,error,privateReceipt===undefined?null:this.seal(owner,`receipt:${id}`,privateReceipt),receipt??null]);if(rowCount!==1)throw conflict('OPERATION_CHANGED');
 }
 async finishExecution(owner:string,id:string,token:string,diagnostic?:AssignmentSubmissionFailureDiagnostic){await this.pool.query("UPDATE assignment_operations SET execution_finished_at=now(),failure_diagnostic=$4 WHERE id=$1 AND user_id=$2 AND worker_token=$3 AND execution_protocol=1 AND state IN ('confirmed','rejected','needs_confirmation') AND execution_finished_at IS NULL",[id,owner,token,diagnostic??null]);}
 private async proof(c:PoolClient,owner:string,proof:ObservationProof){
  const q=await c.query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 FOR SHARE",[owner,proof.encryptedSession]);
  if(q.rowCount!==1)throw new AppError(409,'SCHOOL_SESSION_CHANGED','학교 인증이 변경됐습니다. 다시 확인해 주세요.');
 }
 async observe(owner:string,course:string,assignment:string,id:string,token:string,proof:ObservationProof){await this.tx(async c=>{await this.proof(c,owner,proof);
  const q=await c.query("UPDATE assignment_operations SET school_observation=$6,observation_generation=$7,lease_expires_at=now() WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND worker_token=$5 AND state='needs_confirmation' AND recovery_released_at IS NULL AND lease_expires_at>now()",[id,owner,course,assignment,token,proof.observation,proof.generation]);if(q.rowCount!==1)throw conflict('OPERATION_CHANGED');
 });}
 async releaseConfirmation(owner:string,id:string,token:string){await this.pool.query("UPDATE assignment_operations SET lease_expires_at=now() WHERE id=$1 AND user_id=$2 AND worker_token=$3 AND state='needs_confirmation'",[id,owner,token]);}
 async release(owner:string,course:string,assignment:string,id:string,token:string,observedAt:string,proof:ObservationProof,authority:ReleaseAuthority){await this.tx(async c=>{
  await this.lock(c,owner);const session=await c.query('SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3 AND expires_at>clock_timestamp() FOR SHARE',[owner,authority.sessionHash,authority.csrfToken]);if(session.rowCount!==1)throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');await this.proof(c,owner,proof);
  const {rows:[row]}=await c.query("SELECT * FROM assignment_operations WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND worker_token=$5 AND state='needs_confirmation' AND recovery_released_at IS NULL AND lease_expires_at>now() FOR UPDATE",[id,owner,course,assignment,token]);
  if(!row)throw conflict('OPERATION_CHANGED');const op=this.operation(row),old=op.schoolObservation,fresh=proof.observation;
  if(!old||old.observedAt!==observedAt||op.observationGeneration!==proof.generation||Date.now()-Date.parse(observedAt)>5*60*1000||Date.parse(observedAt)>Date.now()+1000||old.workflowState!==fresh.workflowState||old.attempt!==fresh.attempt||old.submittedAt!==fresh.submittedAt)throw conflict('RECOVERY_CHANGED');
  const kind=schoolSubmissionPresent(fresh)?'school_submission_present':op.executionProtocol===1&&op.executionFinishedAt&&!op.writeStartedAt&&!op.privateReceipt&&fresh.workflowState==='unsubmitted'?'upload_failed_before_submit':null;
  if(!kind)throw conflict('RECOVERY_UNAVAILABLE');
  const changed=await c.query("UPDATE assignment_operations SET school_observation=$6,observation_generation=$7,recovery_kind=$8,recovery_released_at=now(),lease_expires_at=now() WHERE id=$1 AND user_id=$2 AND course_id=$3 AND assignment_id=$4 AND worker_token=$5 AND EXISTS(SELECT 1 FROM sessions WHERE user_id=$2 AND token_hash=$9 AND csrf_token=$10 AND expires_at>clock_timestamp())",[id,owner,course,assignment,token,fresh,proof.generation,kind,authority.sessionHash,authority.csrfToken]);if(changed.rowCount!==1)throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');
 });}
 async releaseFiles(owner:string,ids:string[]){if(ids.length)await this.pool.query("DELETE FROM assignment_uploads WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='consumed'",[owner,ids]);}
}
