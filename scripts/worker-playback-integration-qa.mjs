import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../dist/store.js';
import { migrate } from '../dist/migrations.js';
import { createQueueClient, startWorker } from '../dist/queue.js';
import { shutdownWorker } from '../dist/worker-shutdown.js';
import { workerPgOptions } from '../dist/worker-bounds.js';
import { createWorkerClaimValidator } from '../dist/playback-bootstrap.js';
import { createPlaybackAdmission, createPlaybackFinalProof } from '../dist/playback-authority.js';
import { PgPlaybackLeaseRepository } from '../dist/manual-video-lease.js';
import { createSchoolPlayback } from '../dist/school-playback.js';
import { createControlledPlaybackRuntime, createControlledPlaybackSource } from '../dist/controlled-playback-runtime.js';
import { createVideoStreamer } from '../dist/video-stream.js';
import { encryptSchoolSession } from '../dist/crypto.js';
import { unavailableSchoolProvider } from '../dist/provider.js';
import { AppError } from '../dist/errors.js';

async function main(){
const databaseUrl=process.env.TEST_DATABASE_URL;
if(process.platform!=='linux'||!databaseUrl||!['/alms_test','/alms_qa'].includes(new URL(databaseUrl).pathname)
  ||new URL(databaseUrl).hostname!=='127.0.0.1')throw Error('ISOLATED_QA_DATABASE_REQUIRED');
const fixture='/fixtures/large.mp4',fixtureBytes=(await stat(fixture)).size;
assert.ok(fixtureBytes>32*1024*1024);
const key=randomBytes(32),pool=new Pool({connectionString:databaseUrl,max:10,...workerPgOptions}),store=new PgStore(pool);
let databaseErrors=0,queueErrors=0,unexpectedFetches=0;
pool.on('error',()=>{databaseErrors++;});
// The synthetic adapter must not fall through to any school/API network call.
globalThis.fetch=async()=>{unexpectedFetches++;throw Error('UNEXPECTED_NETWORK');};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,ms=30000){const end=performance.now()+ms;while(performance.now()<end){const value=await predicate();if(value)return value;await delay(100);}throw Error('QA_DEADLINE');}
async function noBrowserProcesses(){
 let count=0;for(const pid of(await readdir('/proc')).filter(value=>/^\d+$/.test(value))){try{const [command,state]=await Promise.all([readFile(`/proc/${pid}/cmdline`,'utf8'),readFile(`/proc/${pid}/stat`,'utf8')]);if(command.includes('/opt/playwright-browsers/')&&state.slice(state.lastIndexOf(')')+2,state.lastIndexOf(')')+3)!=='Z')count++;}catch{}}
 return count===0;
}
const mediaUrl='https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/large.mp4';
const fixedResult=()=>({observedAt:new Date().toISOString(),progressPercent:100,attendance:'unknown',recognized:null});
function makeMedia(counters){
 return createVideoStreamer(async(url,init)=>{
  assert.equal(url,mediaUrl);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');counters.mediaRequests++;
  const range=new Headers(init.headers).get('range');let start=0,end=fixtureBytes-1;
  if(range){const parts=/^bytes=(\d+)-(\d*)$/.exec(range);assert.ok(parts);start=Number(parts[1]);if(parts[2])end=Math.min(end,Number(parts[2]));}
  const headers={'content-type':'video/mp4','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${fixtureBytes}`}:{})};
  if(init.method==='HEAD')return new Response(null,{status:range?206:200,headers});
  const stream=createReadStream(fixture,{start,end,highWaterMark:65536});stream.on('data',bytes=>{counters.mediaBytes+=bytes.length;});
  const abort=()=>stream.destroy();init.signal.addEventListener('abort',abort,{once:true});stream.once('close',()=>init.signal.removeEventListener('abort',abort));
  return new Response(Readable.toWeb(stream),{status:range?206:200,headers});
 });
}
async function fixtureFor(mode='normal',scheduledDelay=0){
 const identity={provider:'synthetic-worker-qa',subject:randomUUID()},generation=randomUUID();let sealed='';
 const login=await store.issueVerifiedSession(identity,3600,{provider:'ssu',seal:owner=>sealed=encryptSchoolSession({version:1,generation,identity:{studentId:'20269999'},jar:{}},key,owner,'ssu')});
 const owner=login.user.id,target={courseId:'10',lectureId:'20'};
 const counters={preparations:0,workerPreparations:0,observations:0,reports:[],freshReads:0,mediaRequests:0,mediaBytes:0,runtimeStarts:0,closed:0,firstZero:false,allNormal:true,reportAborted:false,ended:false};
 let job,triggered=false,sideEffect=Promise.resolve(),reportSignal;
 const ensure=async(guard,signal)=>{signal.throwIfAborted();await guard();if(await store.getEncryptedSchoolSession(owner,'ssu')!==sealed)throw new AppError(409,'SCHOOL_SESSION_CHANGED','changed');signal.throwIfAborted();};
 const school={prepare:async(scope,guard,signal,expected)=>{
  assert.deepEqual(scope,{owner,courseId:target.courseId,moduleItemId:target.lectureId});await ensure(guard,signal);
  if(expected!==undefined&&expected!==generation)throw new AppError(409,'SCHOOL_SESSION_CHANGED','changed');
  counters.preparations++;if(expected!==undefined){counters.workerPreparations++;counters.workerStartedAt=Date.now();}
  let closed=false;
  return {generation,encryptedSession:sealed,baseline:0,durationSeconds:8,
    validate:signal=>ensure(async()=>{},signal),
    authority:async(guard,signal)=>{await ensure(guard,signal);return {generation,encryptedSession:sealed};},
    prepareMedia:async(guard,signal)=>{await ensure(guard,signal);return {contentId:'synthetic',mediaUrl,validate:async()=>{}};},
    observe:value=>{
      assert.equal(closed,false);if(!counters.observations)counters.firstZero=value.positionSeconds===0&&value.paused;
      counters.observations++;counters.allNormal&&=value.playbackRate===1&&value.visible&&!value.seeking;counters.ended||=value.ended;
      if(job&&value.positionSeconds>0.6&&!triggered&&['cancel','cancel-pending','generation','claim'].includes(mode)){
        triggered=true;
        if(mode.startsWith('cancel'))sideEffect=store.cancelJob(owner,job.id);
        if(mode==='generation')sideEffect=store.issueVerifiedSession(identity,3600,{provider:'ssu',seal:user=>encryptSchoolSession({version:1,generation:randomUUID(),identity:{studentId:'20269999'},jar:{}},key,user,'ssu')});
        if(mode==='claim')sideEffect=pool.query("UPDATE playback_jobs SET execution_token_hash=NULL,status='needs_verification',error_code='SYNTHETIC_CLAIM_REVOKED',updated_at=now() WHERE id=$1",[job.id]);
        void sideEffect.catch(()=>{});
      }
      if(mode==='signal-child'&&value.positionSeconds>0.3&&!triggered){triggered=true;process.stdout.write('READY\n');}
    },
    report:async(event,guard,signal)=>{
      await ensure(guard,signal);assert.equal(closed,false);counters.reports.push(event);reportSignal=signal;
      if(['cancel-pending','signal-child'].includes(mode))await new Promise((_,reject)=>{const abort=()=>{counters.reportAborted=true;reject(new AppError(503,'PLAYBACK_REPORT_UNKNOWN','unknown'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
      await ensure(guard,signal);return {transport:mode==='unknown'?'unknown':'acknowledged',state:event==='ended'||mode==='unknown'?'closed':'ready',school:fixedResult()};
    },
    readFresh:async(guard,signal)=>{assert.equal(closed,true);await ensure(guard,signal);counters.freshReads++;return fixedResult();},
    close:()=>{closed=true;counters.closed++;},
  };
 }};
 const runtime=createControlledPlaybackRuntime(),adapter=createSchoolPlayback({school,leases:new PgPlaybackLeaseRepository(pool),
  validateClaim:createWorkerClaimValidator(store,'execution'),validateFinalClaim:createWorkerClaimValidator(store,'final'),
  createAdmission:createPlaybackAdmission,createFinalProof:createPlaybackFinalProof,
  runtime:{createSource:createControlledPlaybackSource,play:(source,signal)=>{counters.runtimeStarts++;return runtime.play(source,signal);},dispose:runtime.dispose},stream:makeMedia(counters)});
 const provider={...unavailableSchoolProvider,...adapter,capabilities:{schoolAuthentication:false,schoolRead:false,playback:true,pauseResume:false}};
 const validate=async()=>{const session=await store.getSession(hashToken(login.token));assert.equal(session?.user.id,owner);};
 const admission=await adapter.authorizePlayback({userId:owner},target,{signal:AbortSignal.timeout(5000),validate});
 const scheduledFor=new Date(Date.now()+scheduledDelay).toISOString();
 job=await store.createJob(owner,{...target,scheduledFor,idempotencyKey:randomUUID(),requestHash:hashToken(randomUUID())},{admission,almsTokenHash:hashToken(login.token)});
 return {owner,login,job,provider,counters,scheduledFor,get:()=>store.getJob(owner,job.id),logout:()=>store.deleteSession(hashToken(login.token)),sideEffect:()=>sideEffect,
  lease:async()=>Number((await pool.query('SELECT count(*) FROM playback_execution_leases WHERE user_id=$1 AND expires_at>now()',[owner])).rows[0].count),reportSignal:()=>reportSignal};
}
async function runQueue(f,body){
 const boss=createQueueClient(databaseUrl),controller=new AbortController();boss.on('error',()=>{queueErrors++;});
 let stop;try{stop=await startWorker(store,boss,f.provider,controller.signal,()=>{queueErrors++;},{maintenanceMs:200,operationMs:5000,stopMs:30000});return await body(controller,stop);}
 finally{controller.abort();if(stop)await stop();else await boss.stop({graceful:false});await f.sideEffect();await until(noBrowserProcesses,5000);}
}
const terminals=['completed','succeeded','cancelled','failed','needs_reauthentication','needs_verification'];
const settled=f=>until(async()=>{const current=await f.get();return terminals.includes(current.status)?current:null;});
const cases=[];
async function check(name,run){const began=performance.now();try{await run();await until(noBrowserProcesses,5000);cases.push({name,passed:true,elapsedMs:Math.round(performance.now()-began)});}catch(error){const allowed=['PLAYBACK_REPORT_UNKNOWN','PLAYBACK_AUTHORITY_CHANGED','AUTH_REQUIRED','WORKER_OPERATION_TIMEOUT','MEDIA_INVALID','GUARD_FAILED','REPORT_FAILED','CLEANUP_FAILED'];cases.push({name,passed:false,code:allowed.includes(error?.code)?error.code:'QA_ASSERTION',elapsedMs:Math.round(performance.now()-began)});}}
await migrate(pool);await store.health();
if(process.argv.includes('--signal-child')){
 const f=await fixtureFor('signal-child');await writeFile('/tmp/worker-synthetic-child.json',JSON.stringify({owner:f.owner,jobId:f.job.id}),{mode:0o600});
 const boss=createQueueClient(databaseUrl),controller=new AbortController();boss.on('error',()=>{queueErrors++;});
 let end,ending;const finished=new Promise(resolve=>end=resolve);
 const started=startWorker(store,boss,f.provider,controller.signal,()=>{queueErrors++;});
 const stop=()=>ending??=shutdownWorker({controller,stop:[async()=>(await started)()],close:()=>pool.end(),failed:()=>{process.exitCode=3;}}).then(()=>end(),()=>end());
 process.once('SIGTERM',()=>{void stop();});await started;await finished;
 const clean=await noBrowserProcesses();if(!f.counters.reportAborted||!clean||process.exitCode)process.exitCode=4;else process.stdout.write('CLEAN\n');
}else{
 await check('disabled-real-worker-preserves-queued-and-future-outbox',async()=>{
  const queued=await fixtureFor(),future=await fixtureFor('normal',60000);const before=await pool.query('SELECT job_id,dispatched_at FROM job_outbox ORDER BY job_id');
  assert.equal((await pool.query("SELECT to_regnamespace('pgboss') IS NULL AS absent")).rows[0].absent,true);
  const child=spawn(process.execPath,['dist/worker-main.js'],{env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:databaseUrl,SSU_PLAYBACK_ENABLED:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v.toString());child.stderr.resume();
  try{await until(()=>output.includes('worker_started'),10000);assert.match(output,/"playbackProvider":false/);await delay(1200);
    assert.equal((await queued.get()).status,'queued');assert.equal((await future.get()).status,'scheduled');assert.deepEqual((await pool.query('SELECT job_id,dispatched_at FROM job_outbox ORDER BY job_id')).rows,before.rows);
    assert.equal((await pool.query("SELECT to_regnamespace('pgboss') IS NULL AS absent")).rows[0].absent,true);
  }finally{const exited=child.exitCode!==null?Promise.resolve(child.exitCode):new Promise(resolve=>child.once('exit',resolve));const timer=setTimeout(()=>child.kill('SIGKILL'),35000);child.kill('SIGTERM');try{assert.equal(await exited,0);}finally{clearTimeout(timer);}}
  await store.cancelJob(queued.owner,queued.job.id);await store.cancelJob(future.owner,future.job.id);
 });
 await check('scheduled-real-playback-survives-browser-logout-and-finishes-with-recognized-null',async()=>{
  const f=await fixtureFor('normal',3500);await f.logout();assert.equal(await store.getSession(hashToken(f.login.token)),null);
  await runQueue(f,async()=>{await delay(300);assert.equal((await f.get()).status,'scheduled');assert.equal(f.counters.runtimeStarts,0);
    const job=await settled(f);assert.equal(job.status,'completed');assert.equal(job.executionOutcome,'ended');assert.equal(job.schoolResult.recognized,null);assert.equal(job.schoolResult.attendance,'unknown');
    assert.ok(f.counters.workerStartedAt>=Date.parse(f.scheduledFor));assert.equal(f.counters.runtimeStarts,1);assert.equal(f.counters.workerPreparations,1);assert.deepEqual(f.counters.reports,['playing','ended']);
    assert.equal(f.counters.firstZero,true);assert.equal(f.counters.allNormal,true);assert.equal(f.counters.ended,true);assert.ok(f.counters.observations>30);assert.ok(f.counters.mediaBytes>32*1024*1024);assert.equal(await f.lease(),0);
  });
 });
 for(const mode of ['cancel','cancel-pending','unknown','generation','claim'])await check(`real-queue-${mode}-does-not-produce-success-or-repeat-report`,async()=>{
  const f=await fixtureFor(mode);await runQueue(f,async()=>{const job=await settled(f);await until(noBrowserProcesses,10000);assert.ok(!['completed','succeeded'].includes(job.status));
    assert.equal(f.counters.runtimeStarts,1);assert.ok(f.counters.reports.length<=1);assert.ok(!f.counters.reports.includes('ended'));
    if(mode==='cancel'){assert.equal(job.status,'cancelled');assert.equal(job.executionOutcome,'interrupted');assert.equal(job.schoolResult.recognized,null);assert.equal(await f.lease(),0);}
    if(mode==='cancel-pending'||mode==='unknown'){assert.equal(job.status,'needs_verification');assert.equal(job.errorCode,'PLAYBACK_REPORT_UNKNOWN');assert.equal(await f.lease(),1);assert.equal(f.counters.freshReads,0);}
    if(mode==='cancel-pending')assert.equal(f.counters.reportAborted,true);
    if(mode==='generation')assert.equal(job.status,'needs_reauthentication');
    if(mode==='claim'){assert.equal(job.errorCode,'SYNTHETIC_CLAIM_REVOKED');assert.equal(job.executionTokenHash,null);}
  });
 });
 let signalShutdownElapsedMs=null;
 await check('SIGTERM-real-queue-runner-runtime-stops-and-preserves-uncertain-lease',async()=>{
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--signal-child'],{env:{...process.env},stdio:['ignore','pipe','pipe']});let output='',sent=0;child.stderr.resume();
  child.stdout.on('data',data=>{output+=data.toString();if(output.includes('READY')&&!sent){sent=performance.now();child.kill('SIGTERM');}});
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000);const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
  assert.equal(code,0);assert.ok(sent);assert.match(output,/CLEAN/);signalShutdownElapsedMs=Math.round(performance.now()-sent);assert.ok(signalShutdownElapsedMs<35000);
  const saved=JSON.parse(await readFile('/tmp/worker-synthetic-child.json','utf8')),job=await store.getJob(saved.owner,saved.jobId);
  assert.equal(job.status,'needs_verification');assert.equal(job.errorCode,'PLAYBACK_REPORT_UNKNOWN');assert.equal(job.schoolResult,null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM playback_execution_leases WHERE user_id=$1 AND expires_at>now()',[saved.owner])).rows[0].count),1);
 });
 const passed=cases.every(value=>value.passed)&&unexpectedFetches===0&&databaseErrors===0&&queueErrors===0&&await noBrowserProcesses();
 await pool.end();
 process.stdout.write(JSON.stringify({schema:'worker-playback-synthetic-integration-v1',passed,fixtureBytes,schoolLayer:'synthetic-only',database:'isolated-temporary',actualSchoolRequests:0,actualSchoolReports:0,unexpectedFetches,databaseErrors,queueErrors,signalShutdownElapsedMs,noLiveBrowserProcesses:await noBrowserProcesses(),cases},null,2)+'\n');if(!passed)process.exitCode=1;
}

}
await main().catch(()=>{process.stderr.write('{"code":"SYNTHETIC_QA_SETUP_FAILED"}\n');process.exit(2);});
