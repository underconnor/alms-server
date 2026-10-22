import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import type { Store } from './store.js';
import { AppError } from './errors.js';
import { assignmentId } from './assignments.js';
import { submissionInput,uploadInput } from './assignment-submission-types.js';
import type { AssignmentSubmissionService } from './assignment-submission-service.js';
import { timingSafeEqual } from 'node:crypto';
export async function registerAssignmentSubmission(app:FastifyInstance,store:Store,authenticate:(request:FastifyRequest)=>Promise<void>,service?:AssignmentSubmissionService){
 const base='/v1/courses/:id/assignments/:assignmentId';
 const params=z.object({id:assignmentId,assignmentId,uploadId:z.uuid().optional(),operationId:z.uuid().optional()}).strict();
 const empty=z.object({}).strict();
 const target=(r:FastifyRequest,allowKey=false)=>{if(allowKey)z.object({idempotencyKey:z.uuid().optional()}).strict().parse(r.query);else empty.parse(r.query);const p=params.parse(r.params);return {owner:r.session!.user.id,c:p.id,a:p.assignmentId,upload:p.uploadId,operation:p.operationId};};
 const available=()=>{if(!service)throw new AppError(503,'SUBMISSION_UNAVAILABLE','과제 제출을 준비 중입니다. 잠시 후 다시 확인해 주세요.');return service;};
 const validation=(r:FastifyRequest)=>async()=>{const latest=await store.getSession(r.session!.tokenHash);const token=latest?.csrfToken??'',expected=r.session!.csrfToken;if(!latest||latest.user.id!==r.session!.user.id||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))throw new AppError(401,'AUTH_REQUIRED','다시 로그인해 주세요.');};
 const route={preHandler:authenticate};
 app.get(base+'/submission-options',route,async r=>{const t=target(r);return available().options(t.owner,t.c,t.a,validation(r),AbortSignal.timeout(90000));});
 app.get(base+'/submissions/current',route,async r=>{const t=target(r,true),result=await available().current(t.owner,t.c,t.a,(r.query as {idempotencyKey?:string}).idempotencyKey);await validation(r)();return result;});
 app.get(base+'/submissions/:operationId',route,async r=>{const t=target(r),result=await available().status(t.owner,t.c,t.a,t.operation!);await validation(r)();return result;});
 app.post(base+'/uploads',route,async(r,reply)=>{const t=target(r),value=uploadInput.parse(r.body);return reply.code(201).send(await available().reserve(t.owner,t.c,t.a,value,validation(r),AbortSignal.timeout(90000)));});
 app.post(base+'/uploads/:uploadId/cancel',route,async(r,reply)=>{const t=target(r);empty.parse(r.body);await available().cancel(t.owner,t.c,t.a,t.upload!);return reply.code(204).send();});
 await app.register(async scope=>{
  scope.addContentTypeParser('application/octet-stream',(request,payload,done)=>done(null,payload));
  // Authenticate before consuming a potentially large stream. No global JSON body limit is widened.
  scope.post(base+'/uploads/:uploadId/content',{onRequest:authenticate,bodyLimit:20*1024*1024},async(r,reply)=>{const t=target(r);if(!r.body||typeof (r.body as Readable)[Symbol.asyncIterator]!=='function')throw new AppError(415,'INVALID_UPLOAD','파일 형식을 확인해 주세요.');const signal=AbortSignal.timeout(120000);const value=await available().receive(t.owner,t.c,t.a,t.upload!,r.body as Readable,validation(r),signal);return reply.send(value);});
 });
 app.post(base+'/submissions',{...route,bodyLimit:150000},async(r,reply)=>{const t=target(r),key=z.uuid().parse(r.headers['idempotency-key']),input=submissionInput.parse(r.body);const result=await available().submit(t.owner,t.c,t.a,key,input,validation(r));await validation(r)();return reply.code(202).send(result);});
 app.post(base+'/submissions/:operationId/reconcile',route,async r=>{const t=target(r);empty.parse(r.body);const result=await available().reconcile(t.owner,t.c,t.a,t.operation!,validation(r));await validation(r)();return result;});
 app.post(base+'/submissions/:operationId/release',route,async r=>{const t=target(r),input=z.object({observedAt:z.iso.datetime({offset:true})}).strict().parse(r.body);const result=await available().release(t.owner,t.c,t.a,t.operation!,input.observedAt,validation(r),{sessionHash:r.session!.tokenHash,csrfToken:r.session!.csrfToken});await validation(r)();return result;});
 if(service)app.addHook('onClose',()=>service.close());
}
