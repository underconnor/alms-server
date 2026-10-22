import { before,after,afterEach,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { PgStore } from '../../src/store.js';
import { PgSubmissionRepository } from '../../src/assignment-submission-store.js';
import { submissionInput,limits,type ObservationProof } from '../../src/assignment-submission-types.js';
import { assignmentSubmissionFailureDiagnostic } from '../../src/assignment-submission-diagnostics.js';
import { SchoolAssignmentWriteError } from '@alms/ssu-api';
const url=process.env.TEST_DATABASE_URL;
if(url&&!['/alms_test','/alms_qa'].includes(new URL(url).pathname))throw new Error('Use isolated test database');
describe('durable assignment preparation and exactly-once operation claim',{skip:!url},()=>{
 let pool:Pool,store:PgStore,repo:PgSubmissionRepository;const owners:string[]=[],key=randomBytes(32);
 const input=()=>submissionInput.parse({submissionType:'online_text_entry',expectedAttempt:null,pledgeAccepted:false,pledgeDigest:null,text:'합성 답안 <private>'});
 async function owner(){const s=await store.issueVerifiedSession({provider:'submission-qa',subject:randomUUID()},3600);owners.push(s.user.id);return s.user.id;}
 async function file(o:string,g=randomUUID(),bytes=Buffer.from('synthetic-private-file')){const f=await repo.reserve(o,'10','90',g,{fileName:'synthetic.txt',contentType:'text/plain',sizeBytes:bytes.length});await repo.receive(o,'10','90',f.id,Readable.from([bytes]),async()=>{},AbortSignal.timeout(5000));return {...f,g,bytes};}
 before(async()=>{pool=new Pool({connectionString:url,max:10,statement_timeout:5000});await migrate(pool);await migrate(pool);store=new PgStore(pool);repo=new PgSubmissionRepository(pool,key);});
 afterEach(async()=>{await pool.query("UPDATE assignment_operations SET state='rejected' WHERE user_id=ANY($1::uuid[]) AND state IN ('preparing','sending','needs_confirmation')",[owners]);});
 after(async()=>{if(pool){await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[owners]);await pool.end();}});
 it('encrypts file chunks and isolates owner, target and generation across repository instances',async()=>{
  const a=await owner(),b=await owner(),f=await file(a);const raw=(await pool.query('SELECT encrypted_data FROM assignment_upload_chunks WHERE upload_id=$1',[f.id])).rows[0].encrypted_data;
  assert.doesNotMatch(raw,/synthetic-private-file/);const other=new PgSubmissionRepository(pool,key);
  assert.deepEqual(Buffer.from((await other.files(a,'10','90',f.g,[f.id]))[0]!.bytes),f.bytes);
  for(const args of [[b,'10','90',f.g],[a,'11','90',f.g],[a,'10','91',f.g],[a,'10','90',randomUUID()]])await assert.rejects(other.files(args[0]!,args[1]!,args[2]!,args[3]!,[f.id]));
  assert.equal(await other.get(b,'10','90',randomUUID()),null);
 });
 it('incomplete, oversize, aborted or revoked streams leave no ready bytes',async()=>{
  for(const mode of ['short','large','abort','revoke']){const a=await owner(),u=await repo.reserve(a,'10','90',randomUUID(),{fileName:'f.txt',contentType:'text/plain',sizeBytes:4});let checks=0;const ctl=new AbortController();if(mode==='abort')ctl.abort();
   await assert.rejects(repo.receive(a,'10','90',u.id,Readable.from([Buffer.from(mode==='large'?'12345':mode==='short'?'1':'1234')]),async()=>{if(mode==='revoke'&&++checks===2)throw new Error('revoked');},ctl.signal));
   assert.equal((await pool.query("SELECT 1 FROM assignment_uploads WHERE id=$1 AND state='ready'",[u.id])).rowCount,0);
  }
 });
 it('detects ciphertext corruption before reconstructing a file',async()=>{const a=await owner(),f=await file(a);await pool.query("UPDATE assignment_upload_chunks SET encrypted_data='corrupt' WHERE upload_id=$1",[f.id]);await assert.rejects(repo.files(a,'10','90',f.g,[f.id]));});
 it('two requests with one key create one operation and only one worker can claim it',async()=>{
  const a=await owner(),g=randomUUID(),k=randomUUID(),body=input();const [one,two]=await Promise.all([repo.create(a,'10','90',g,k,body),repo.create(a,'10','90',g,k,body)]);assert.equal(one.operation.id,two.operation.id);assert.equal([one,two].filter(x=>x.created).length,1);
  const claims=await Promise.all([repo.claim(a,'10','90',one.operation.id),repo.claim(a,'10','90',one.operation.id)]);assert.equal(claims.filter(Boolean).length,1);
  await assert.rejects(repo.create(a,'10','90',g,randomUUID(),body),{code:'SUBMISSION_BUSY'});await assert.rejects(repo.existing(a,'10','90',k,{...body,text:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
  const raw=(await pool.query('SELECT input_enc FROM assignment_operations WHERE id=$1',[one.operation.id])).rows[0].input_enc;assert.doesNotMatch(raw,/private|합성/);
 });
 it('durably saves a private receipt and rejects stale worker updates after crash recovery',async()=>{
  const a=await owner(),op=await repo.create(a,'10','90',randomUUID(),randomUUID(),input()),claimed=(await repo.claim(a,'10','90',op.operation.id))!;
  await repo.save(a,claimed.id,claimed.workerToken!,'sending',null,{private:'receipt-qa'});assert.deepEqual((await repo.get(a,'10','90',claimed.id))?.privateReceipt,{private:'receipt-qa'});
  await pool.query("UPDATE assignment_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claimed.id]);await repo.cleanup();assert.equal((await repo.get(a,'10','90',claimed.id))?.state,'needs_confirmation');
  assert.equal(await repo.claim(a,'10','90',claimed.id),null);await assert.rejects(repo.save(a,claimed.id,claimed.workerToken!,'confirmed',null));
  const r=(await repo.claimConfirmation(a,'10','90',claimed.id))!;await repo.save(a,r.id,r.workerToken!,'confirmed',null,undefined,{attempt:1,submittedAt:'2099-01-01T00:00:00.000Z'});const publicValue=await repo.current(a,'10','90');assert.equal(publicValue?.state,'confirmed');assert.doesNotMatch(JSON.stringify(publicValue),/receipt-qa|generation|workerToken|private/);
 });
 it('projects exact reconciliation capability across instances without exposing a receipt or unblocking an uncertain operation',async()=>{
  const a=await owner(),body=input(),made=await repo.create(a,'10','90',randomUUID(),randomUUID(),body),claimed=(await repo.claim(a,'10','90',made.operation.id))!;
  await repo.save(a,claimed.id,claimed.workerToken!,'needs_confirmation','RESULT_UNCONFIRMED');
  const other=new PgSubmissionRepository(pool,key);
  const first=await other.current(a,'10','90');assert.equal(first?.state,'needs_confirmation');assert.equal(first?.reconciliationAvailable,true);
  await assert.rejects(other.create(a,'10','90',randomUUID(),randomUUID(),body),{code:'SUBMISSION_BUSY'});
  const check=(await other.claimConfirmation(a,'10','90',claimed.id))!;
  await other.save(a,check.id,check.workerToken!,'needs_confirmation','RESULT_UNCONFIRMED',{private:'receipt-qa'});
  const second=await repo.current(a,'10','90');assert.equal(second?.reconciliationAvailable,true);assert.equal(second?.state,'needs_confirmation');
  assert.doesNotMatch(JSON.stringify(second),/receipt-qa|generation|workerToken|privateReceipt/);
  await assert.rejects(repo.create(a,'10','90',randomUUID(),randomUUID(),body),{code:'SUBMISSION_BUSY'});
  const final=(await repo.claimConfirmation(a,'10','90',claimed.id))!;
  await repo.save(a,final.id,final.workerToken!,'confirmed',null,undefined,{attempt:1,submittedAt:'2099-01-01T00:00:00.000Z'});
  assert.equal((await other.current(a,'10','90'))?.reconciliationAvailable,false);
 });
 it('does not recreate or resend preparation after a lease expires and purges terminal body after one day',async()=>{
  const a=await owner(),k=randomUUID(),body=input(),made=await repo.create(a,'10','90',randomUUID(),k,body);await pool.query("UPDATE assignment_operations SET created_at=now()-interval '6 minutes' WHERE id=$1",[made.operation.id]);await repo.cleanup();assert.equal((await repo.current(a,'10','90'))?.state,'rejected');assert.equal(await repo.claim(a,'10','90',made.operation.id),null);
  await pool.query("UPDATE assignment_operations SET updated_at=now()-interval '2 days' WHERE id=$1",[made.operation.id]);await repo.cleanup();assert.equal((await repo.get(a,'10','90',made.operation.id))?.input,null);assert.equal((await repo.existing(a,'10','90',k,body))?.id,made.operation.id);
 });
 it('caps concurrent submission preparation across separate owners and instances',async()=>{const ids=await Promise.all([owner(),owner(),owner()]);const other=new PgSubmissionRepository(pool,key);const attempts=await Promise.allSettled(ids.map((id,i)=>(i%2?repo:other).create(id,'10','90',randomUUID(),randomUUID(),input())));assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);assert.equal(attempts.filter(x=>x.status==='rejected').length,1);});
 it('serializes per-owner upload quotas and atomically consumes only matching ready files',async()=>{
  const a=await owner(),g=randomUUID();const results=await Promise.allSettled(Array.from({length:limits.ownerFiles+2},()=>repo.reserve(a,'10','90',g,{fileName:'f.txt',contentType:'text/plain',sizeBytes:1})));assert.equal(results.filter(x=>x.status==='fulfilled').length,limits.ownerFiles);
  const b=await owner(),f=await file(b),body=submissionInput.parse({submissionType:'online_upload',expectedAttempt:null,pledgeAccepted:false,pledgeDigest:null,uploadIds:[f.id]});await assert.rejects(repo.create(a,'10','90',f.g,randomUUID(),body),{code:'UPLOAD_EXPIRED'});
  const made=await repo.create(b,'10','90',f.g,randomUUID(),body);assert.equal(made.created,true);assert.equal((await repo.files(b,'10','90',f.g,[f.id]))[0]!.status,'consumed');await repo.releaseFiles(b,[f.id]);assert.equal((await pool.query('SELECT 1 FROM assignment_upload_chunks WHERE upload_id=$1',[f.id])).rowCount,0);
 });
 async function recoverable(legacy=false,writeStarted=false,finished=true){
  const a=await owner(),g=randomUUID(),sessionHash=randomUUID(),csrfToken=randomUUID(),seal='synthetic-seal-'+randomUUID(),k=randomUUID(),body=input();
  await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,analytics_session_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[sessionHash,a,csrfToken,randomUUID()]);
  await pool.query("INSERT INTO school_sessions(user_id,provider,encrypted_state) VALUES($1,'ssu',$2)",[a,seal]);
  const made=await repo.create(a,'10','90',g,k,body),claimed=(await repo.claim(a,'10','90',made.operation.id))!;
  if(writeStarted)await repo.save(a,claimed.id,claimed.workerToken!,'sending',null,{synthetic:'exact-final-receipt'});
  await repo.save(a,claimed.id,claimed.workerToken!,'needs_confirmation','RESULT_UNCONFIRMED');if(finished)await repo.finishExecution(a,claimed.id,claimed.workerToken!,assignmentSubmissionFailureDiagnostic(new SchoolAssignmentWriteError('upload','unknown','unexpected_response','completion_response'),{outcome:'unknown',mayHaveWritten:true,operationId:claimed.id}));
  if(legacy)await pool.query('UPDATE assignment_operations SET execution_protocol=NULL,execution_finished_at=NULL,final_write_started_at=NULL WHERE id=$1',[claimed.id]);
  const proof:ObservationProof={generation:g,encryptedSession:seal,observation:{workflowState:'submitted',attempt:1,submittedAt:'2026-10-15T00:00:00.000Z',observedAt:new Date().toISOString(),attribution:'unattributed'}};
  const authority={sessionHash,csrfToken};return {a,g,k,body,id:claimed.id,proof,authority,originalToken:claimed.workerToken!};
 }
 async function observe(r:Awaited<ReturnType<typeof recoverable>>){const claim=(await repo.claimConfirmation(r.a,'10','90',r.id))!;await repo.observe(r.a,'10','90',r.id,claim.workerToken!,r.proof);}
 async function release(r:Awaited<ReturnType<typeof recoverable>>,proof=r.proof,authority=r.authority){const claim=(await repo.claimConfirmation(r.a,'10','90',r.id))!;try{await repo.release(r.a,'10','90',r.id,claim.workerToken!,r.proof.observation.observedAt,proof,authority);}finally{await repo.releaseConfirmation(r.a,r.id,claim.workerToken!);}}
 async function original(r:Awaited<ReturnType<typeof recoverable>>){return (await pool.query('SELECT id,user_id,course_id,assignment_id,generation,idempotency_key,request_hash,input_enc,submission_type,state,private_receipt_enc,public_receipt,error_code,created_at,updated_at FROM assignment_operations WHERE id=$1',[r.id])).rows[0];}
 it('legacy receipt-less fresh recheck preserves original history and explicit school-present release permits only a new user request',async()=>{
  const r=await recoverable(true),before=await original(r);await observe(r);const checked=await repo.current(r.a,'10','90');assert.equal(checked?.state,'needs_confirmation');assert.equal(checked?.recovery?.schoolObservation?.attribution,'unattributed');assert.equal(checked?.recovery?.releaseAvailable,true);assert.deepEqual(await original(r),before);
  await assert.rejects(repo.create(r.a,'10','90',r.g,randomUUID(),r.body),{code:'SUBMISSION_BUSY'});await release(r);assert.deepEqual(await original(r),before);
  const after=await repo.current(r.a,'10','90');assert.equal(after?.state,'needs_confirmation');assert.equal(after?.recovery?.release?.kind,'school_submission_present');assert.equal(after?.recovery?.releaseAvailable,false);
  assert.equal((await repo.existing(r.a,'10','90',r.k,r.body))?.id,r.id);assert.equal((await repo.create(r.a,'10','90',r.g,r.k,r.body)).created,false);
  assert.equal((await repo.create(r.a,'10','90',r.g,randomUUID(),r.body)).created,true);
 });
 it('legacy unsubmitted absence never becomes final-write-not-started proof or releases a blocker',async()=>{
  const r=await recoverable(true);r.proof.observation={...r.proof.observation,workflowState:'unsubmitted',attempt:null,submittedAt:null};await observe(r);assert.equal((await repo.current(r.a,'10','90'))?.recovery?.releaseAvailable,false);await assert.rejects(release(r),{code:'RECOVERY_UNAVAILABLE'});assert.equal((await repo.current(r.a,'10','90'))?.recovery?.release,null);
 });
 for(const variant of ['finished_before_final','no_finished_checkpoint','final_started'] as const)it(`new protocol termination gate ${variant} cannot infer submission from an uploaded file`,async()=>{
  const r=await recoverable(false,variant==='final_started',variant!=='no_finished_checkpoint');r.proof.observation={...r.proof.observation,workflowState:'unsubmitted',attempt:null,submittedAt:null};await observe(r);
  if(variant==='finished_before_final'){const diagnostic=(await pool.query('SELECT failure_diagnostic FROM assignment_operations WHERE id=$1',[r.id])).rows[0].failure_diagnostic;assert.equal(diagnostic.operationId,r.id);assert.equal(diagnostic.uploadStep,'completion_response');assert.equal(diagnostic.finalSubmissionMayHaveWritten,false);await release(r);assert.equal((await repo.current(r.a,'10','90'))?.recovery?.release?.kind,'upload_failed_before_submit');}
  else await assert.rejects(release(r),{code:'RECOVERY_UNAVAILABLE'});
 });
 for(const variant of ['session','csrf','expired_session','seal','generation','changed_attempt','stale_observation'] as const)it(`recovery release refuses changed ${variant} authority or observation`,async()=>{
  const r=await recoverable(true);if(variant==='stale_observation')r.proof.observation.observedAt=new Date(Date.now()-300001).toISOString();await observe(r);const before=await original(r),proof={...r.proof,observation:{...r.proof.observation}},authority={...r.authority};
  if(variant==='session')authority.sessionHash=randomUUID();if(variant==='csrf')authority.csrfToken=randomUUID();if(variant==='expired_session')await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[authority.sessionHash]);if(variant==='seal')proof.encryptedSession='different-seal';if(variant==='generation')proof.generation=randomUUID();if(variant==='changed_attempt')proof.observation.attempt=2;
  await assert.rejects(release(r,proof,authority));assert.equal((await repo.current(r.a,'10','90'))?.recovery?.release,null);assert.deepEqual(await original(r),before);
 });
 it('live claims exclude parallel recovery and stale execution token cannot create termination evidence',async()=>{
  const r=await recoverable(false,false,false),claim=(await repo.claimConfirmation(r.a,'10','90',r.id))!;assert.equal(await repo.claimConfirmation(r.a,'10','90',r.id),null);
  await repo.finishExecution(r.a,r.id,r.originalToken);assert.equal((await repo.get(r.a,'10','90',r.id))?.executionFinishedAt,null);
  await repo.observe(r.a,'10','90',r.id,claim.workerToken!,r.proof);assert.equal((await repo.current(r.a,'10','90'))?.recovery?.releaseAvailable,true);
 });
});
