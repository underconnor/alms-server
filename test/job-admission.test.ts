import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken, type Store } from '../src/store.js';
import { createPlaybackAdmission, inspectPlaybackAdmission } from '../src/playback-authority.js';
import type { SchoolProvider } from '../src/provider.js';
import type { Job } from '../src/domain.js';

const config=loadConfig({DATABASE_URL:'postgres://unused',LOG_LEVEL:'silent'});
const token='a'.repeat(43),generation=randomUUID();
const headers={accept:'application/json; alms-playback=2',cookie:'__Host-alms_session='+token,origin:'https://lms.flyjung.kr','x-csrf-token':'synthetic-csrf','idempotency-key':randomUUID()};
const input={courseId:'10',lectureId:'20'};
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
function fixture() {
  const userId=randomUUID(),session={tokenHash:hashToken(token),csrfToken:headers['x-csrf-token'],user:{id:userId}};
  let active=true,authorizations=0,writes=0,job:Job|null=null;
  const store={
    getSession:async()=>active?session:null,
    findJobRequest:async()=>job,
    createJob:async(owner,data,authorization)=>{
      writes++;const proof=inspectPlaybackAdmission(authorization.admission,{userId:owner,courseId:data.courseId,lectureId:data.lectureId});
      assert.equal(authorization.almsTokenHash,session.tokenHash);
      job={...data,id:randomUUID(),userId:owner,status:'queued',schoolResult:null,errorCode:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
        acceptedGeneration:proof.generation,executionTokenHash:null,executionOutcome:null};
      return job;
    },
  } as Store;
  const provider:SchoolProvider={capabilities:{schoolAuthentication:false,schoolRead:false,playback:true,pauseResume:false},
    authorizePlayback:async(context,target,options)=>{authorizations++;await options.validate();options.signal.throwIfAborted();
      return createPlaybackAdmission({userId:context.userId,...target},{generation,encryptedSession:'synthetic-private-school-seal'});},
  };
  return{store,provider,userId,logout:()=>{active=false;},counts:()=>({authorizations,writes}),job:()=>job};
}
test('only fresh server-side admission creates a job and the public response excludes its authority',async()=>{
  const f=fixture(),app=await buildApp(config,f.store,f.provider,undefined,undefined,{isReady:async()=>true});
  try{
    const response=await app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});assert.equal(response.statusCode,202);
    assert.equal(response.json().executionOutcome,null);assert.equal(f.job()?.acceptedGeneration,generation);
    assert.doesNotMatch(response.body,/acceptedGeneration|executionTokenHash|synthetic-private|idempotencyKey|requestHash/);
    assert.deepEqual(f.counts(),{authorizations:1,writes:1});
    const replay=await app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});assert.equal(replay.json().id,response.json().id);
    assert.deepEqual(f.counts(),{authorizations:1,writes:1});
  }finally{await app.close();}
});
test('missing school admission capability and forged body fields never create a job',async()=>{
  for(const mode of ['missing','disabled','forged','csrf'] as const){
    const f=fixture();if(mode==='missing')delete f.provider.authorizePlayback;if(mode==='disabled')f.provider.capabilities.playback=false;
    const app=await buildApp(config,f.store,f.provider,undefined,undefined,{isReady:async()=>true});
    try{
      const response=await app.inject({method:'POST',url:'/v1/jobs',headers:mode==='csrf'?{...headers,'x-csrf-token':'wrong'}:headers,
        payload:mode==='forged'?{...input,acceptedGeneration:generation}:input});
      assert.equal(response.statusCode,mode==='forged'?400:mode==='csrf'?403:503);assert.deepEqual(f.counts(),{authorizations:0,writes:0});
    }finally{await app.close();}
  }
});
test('logout during fresh preparation withholds admission even if the adapter later returns a proof',async()=>{
  const f=fixture(),wait=gate();let entered=false;
  f.provider.authorizePlayback=async(context,target)=>{entered=true;await wait.promise;return createPlaybackAdmission({userId:context.userId,...target},{generation,encryptedSession:'synthetic-private-school-seal'});};
  const app=await buildApp(config,f.store,f.provider,undefined,undefined,{isReady:async()=>true});
  try{
    const pending=app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});await flush();assert.equal(entered,true);
    f.logout();wait.release();const response=await pending;assert.equal(response.statusCode,401);assert.equal(f.counts().writes,0);
  }finally{wait.release();await app.close();}
});
test('same-key lookup rechecks the current session before returning an older admitted job',async()=>{
  const f=fixture(),app=await buildApp(config,f.store,f.provider,undefined,undefined,{isReady:async()=>true});
  try{
    await app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});
    const find=f.store.findJobRequest.bind(f.store);f.store.findJobRequest=async(...args)=>{const job=await find(...args);f.logout();return job;};
    const replay=await app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});assert.equal(replay.statusCode,401);
    assert.deepEqual(f.counts(),{authorizations:1,writes:1});
  }finally{await app.close();}
});
test('request deadline covers initial auth and late school preparation without automatically retrying',async t=>{
  const timeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',((callback:any,ms?:number,...args:any[])=>timeout(callback,ms===90_000||ms===5000?30:ms,...args)) as typeof setTimeout);
  for(const at of ['auth','preparation'] as const){
    const f=fixture(),wait=gate();let signal:AbortSignal|undefined,calls=0;
    if(at==='auth')f.store.getSession=async()=>{calls++;await wait.promise;return null;};
    else f.provider.authorizePlayback=async(context,target,options)=>{calls++;signal=options.signal;await wait.promise;return createPlaybackAdmission({userId:context.userId,...target},{generation,encryptedSession:'synthetic-private-school-seal'});};
    const app=await buildApp(config,f.store,f.provider,undefined,undefined,{isReady:async()=>true});
    try{
      const response=await app.inject({method:'POST',url:'/v1/jobs',headers,payload:input});
      assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'PLAYBACK_ADMISSION_UNCONFIRMED');
      if(signal)assert.equal(signal.aborted,true);wait.release();await flush();
      assert.equal(calls,1);assert.equal(f.counts().writes,0);
    }finally{wait.release();await app.close();}
  }
});
