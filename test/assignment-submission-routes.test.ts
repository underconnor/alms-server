import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { AssignmentSubmissionService } from '../src/assignment-submission-service.js';
const config=loadConfig({DATABASE_URL:'postgres://unused',LOG_LEVEL:'silent',ALLOWED_ORIGINS:'https://lms.flyjung.kr'});
const session={user:{id:'synthetic-owner'},tokenHash:'synthetic',csrfToken:'synthetic-csrf'};
const headers={cookie:'__Host-alms_session='+'a'.repeat(43),origin:'https://lms.flyjung.kr','x-csrf-token':session.csrfToken};
const base='/v1/courses/10/assignments/90',upload=randomUUID(),key=randomUUID();
test('raw uploads require a live session, approved Origin and CSRF before any stream is consumed',async()=>{
 let reads=0;const service={receive:async(_o:unknown,_c:unknown,_a:unknown,_id:unknown,source:AsyncIterable<Buffer>,validate:()=>Promise<void>)=>{await validate();const bytes=[];for await(const chunk of source)bytes.push(chunk);reads++;return {sizeBytes:Buffer.concat(bytes).length};},close:async()=>{}} as unknown as AssignmentSubmissionService;
 const app=await buildApp(config,{getSession:async()=>session} as unknown as Store,undefined,service);
 try{for(const h of [{},{...headers,'x-csrf-token':'wrong'},{...headers,origin:'https://other.test'}]){const r=await app.inject({method:'POST',url:`${base}/uploads/${upload}/content`,headers:{...h,'content-type':'application/octet-stream'},payload:Buffer.from('private')});assert.ok([401,403].includes(r.statusCode));}assert.equal(reads,0);
 const ok=await app.inject({method:'POST',url:`${base}/uploads/${upload}/content`,headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('synthetic-file')});assert.equal(ok.statusCode,200);assert.deepEqual(ok.json(),{sizeBytes:14});assert.equal(reads,1);assert.equal(ok.headers['cache-control'],'no-store');
 }finally{await app.close();}
});
test('final submissions use strict body and UUID idempotency, reject caller identity and preserve plain Korean input',async()=>{
 let calls=0;const service={submit:async(o:string,c:string,a:string,k:string,input:unknown)=>{calls++;assert.deepEqual([o,c,a,k],['synthetic-owner','10','90',key]);return {input};},close:async()=>{}} as unknown as AssignmentSubmissionService;
 const app=await buildApp(config,{getSession:async()=>session} as unknown as Store,undefined,service);
 const body={submissionType:'online_text_entry',expectedAttempt:null,pledgeAccepted:false,pledgeDigest:null,text:'합성 답안\n<script>private</script>'};
 try{for(const payload of [{...body,userId:'foreign'},{...body,uploadIds:[upload]},{...body,pledgeDigest:'bad'},{...body,text:'가'.repeat(40001)}]){const r=await app.inject({method:'POST',url:base+'/submissions',headers:{...headers,'idempotency-key':key},payload});assert.equal(r.statusCode,400);}
 assert.equal((await app.inject({method:'POST',url:base+'/submissions',headers,payload:body})).statusCode,400);assert.equal(calls,0);
 const ok=await app.inject({method:'POST',url:base+'/submissions',headers:{...headers,'idempotency-key':key},payload:body});assert.equal(ok.statusCode,202);assert.deepEqual(ok.json().input,body);assert.equal(calls,1);
 }finally{await app.close();}
});
test('recovery queries bind exact request key and never accept arbitrary school URLs or foreign operation IDs',async()=>{
 let received:unknown;const service={current:async(...args:unknown[])=>{received=args;return null;},close:async()=>{}} as unknown as AssignmentSubmissionService;
 const app=await buildApp(config,{getSession:async()=>session} as unknown as Store,undefined,service);
 try{const response=await app.inject({url:`${base}/submissions/current?idempotencyKey=${key}`,headers});assert.equal(response.statusCode,200);assert.equal(response.json(),null);assert.deepEqual(received,['synthetic-owner','10','90',key]);
 for(const suffix of ['?userId=foreign','?idempotencyKey=bad',`?idempotencyKey=${key}&idempotencyKey=${key}`])assert.equal((await app.inject({url:base+'/submissions/current'+suffix,headers})).statusCode,400);
 assert.equal((await app.inject({url:'/v1/courses/not-a-course/assignments/90/submissions/current',headers})).statusCode,400);
 }finally{await app.close();}
});
test('session revocation during result read withholds its receipt',async()=>{
 let active=true;const service={current:async()=>{active=false;return {receipt:'private'};},close:async()=>{}} as unknown as AssignmentSubmissionService;
 const app=await buildApp(config,{getSession:async()=>active?session:null} as unknown as Store,undefined,service);
 try{const r=await app.inject({url:base+'/submissions/current',headers});assert.equal(r.statusCode,401);assert.doesNotMatch(r.body,/private/);}finally{await app.close();}
});
test('explicit recovery release binds exact owner, target, observation and ALMS authority; never accepts caller identity',async()=>{
 let calls=0;const op=randomUUID(),at=new Date().toISOString();const service={release:async(o:string,c:string,a:string,id:string,observed:string,validate:()=>Promise<void>,authority:unknown)=>{await validate();calls++;assert.deepEqual([o,c,a,id,observed],['synthetic-owner','10','90',op,at]);assert.deepEqual(authority,{sessionHash:session.tokenHash,csrfToken:session.csrfToken});return {state:'needs_confirmation'};},close:async()=>{}} as unknown as AssignmentSubmissionService;
 const app=await buildApp(config,{getSession:async()=>session} as unknown as Store,undefined,service);const path=`${base}/submissions/${op}/release`;
 try{for(const h of [{},{...headers,origin:'https://foreign.test'},{...headers,'x-csrf-token':'wrong'}])assert.ok([401,403].includes((await app.inject({method:'POST',url:path,headers:h,payload:{observedAt:at}})).statusCode));
 for(const payload of [{},{observedAt:'bad'},{observedAt:at,owner:'foreign'},{observedAt:at,force:true}])assert.equal((await app.inject({method:'POST',url:path,headers,payload})).statusCode,400);
 assert.equal(calls,0);const ok=await app.inject({method:'POST',url:path,headers,payload:{observedAt:at}});assert.equal(ok.statusCode,200);assert.equal(calls,1);assert.equal(ok.headers['cache-control'],'no-store');
 }finally{await app.close();}
});
