import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, jobClaim } from '../../src/playback-authority.js';
import { reviewedPreplaySource, type ReviewedPreplayPermitInput } from '../../src/reviewed-preplay.js';
import type { SchoolResult } from '../../src/domain.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('operator-reviewed historical preplay retry in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, admin: Pool, store: PgStore;
  const schema = 'reviewed_preplay_' + randomUUID().replaceAll('-', ''), op = { timeoutMs: 5000 };
  before(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 12, options: `-c search_path=${schema}` });
    await migrate(pool); store = new PgStore(pool); await store.health();
  });
  after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const row = async (id: string) => (await pool.query('SELECT to_jsonb(j) AS value FROM playback_jobs j WHERE id=$1', [id])).rows[0].value;
  const facts = (value: Record<string, unknown>) => { const { reviewed_preplay_release_id: _marker, ...original } = value; return original; };
  const evidence = (): SchoolResult => ({ observedAt: new Date().toISOString(), progressPercent: 0, attendance: 'unknown', recognized: null,
    evidence: { resourceType: 'movie', published: true, opened: true, useAttendance: true, omitProgress: false, completed: false,
      schoolAttendanceStatus: 'none', progressSeconds: 0, lastPositionSeconds: 0, durationSeconds: 100 } });
  async function fixture(options: { permit?: boolean; expiresMs?: number; outcome?: string; error?: string } = {}) {
    const identity = { provider: 'reviewed-preplay-qa', subject: randomUUID() }, previousGeneration = randomUUID(), generation = randomUUID();
    const seal = 'synthetic-reviewed-seal-' + randomUUID();
    const session = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => seal });
    const owner = session.user.id, parentId = randomUUID();
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,created_at,updated_at,
      heartbeat_at,idempotency_key,request_hash,accepted_generation,last_execution_token_hash,execution_outcome,error_code)
      VALUES($1,$2,'10','20','needs_verification','2026-11-08T01:00:00Z','2026-11-08T01:00:00Z','2026-11-08T01:00:03.123456Z',
        '2026-11-08T01:00:02Z',$3,$4,$5,$6,$7,$8)`,
      [parentId,owner,randomUUID(),hashToken('synthetic-original'),previousGeneration,hashToken(randomUUID()),options.outcome ?? 'not_started',options.error ?? 'SCHOOL_RESULT_UNKNOWN']);
    await pool.query('INSERT INTO job_outbox(job_id,dispatched_at) VALUES($1,clock_timestamp())', [parentId]);
    const auth = { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: null };
    const snapshot = (await pool.query(`SELECT reviewed_preplay_job_fingerprint(j) AS fingerprint,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM playback_jobs j WHERE id=$1`, [parentId])).rows[0];
    const permitInput: ReviewedPreplayPermitInput = { parentId, expectedVersion: snapshot.version, originalFingerprint: snapshot.fingerprint,
      evidenceSha256: hashToken('synthetic-reviewed-evidence-' + randomUUID()), expiresAt: new Date(Date.now() + (options.expiresMs ?? 3600000)).toISOString(), source: reviewedPreplaySource };
    const permit = options.permit === false ? null : await store.registerReviewedPreplayPermit(permitInput);
    const consent = await store.createPlaybackStartConsent(owner, { courseId: '10', lectureIds: ['20'], confirmed: true }, randomUUID(), hashToken(randomUUID()),
      { ...auth, generation, encryptedSession: seal }, op);
    const input = { expectedVersion: snapshot.version, startConsentId: consent.id, idempotencyKey: randomUUID(), requestHash: hashToken(randomUUID()) };
    const authorization = () => ({ ...auth, admission: createPlaybackAdmission({ userId: owner, courseId: '10', lectureId: '20' }, { generation, encryptedSession: seal },100), schoolResult: evidence() });
    return { owner,parentId,previousGeneration,generation,seal,session,auth,permitInput,permit,consent,input,authorization };
  }
  it('migration starts with no permissions or releases; private review leaves every parent fact unchanged', async () => {
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM playback_preplay_review_permits')).rows[0].n,0);
    const f = await fixture({ permit:false }), before = await row(f.parentId);
    assert.equal((await store.getReviewedPreplayEligibility(f.owner,f.parentId,f.auth))?.eligible,false);
    const p = await store.registerReviewedPreplayPermit(f.permitInput);
    assert.deepEqual(await row(f.parentId),before);
    assert.deepEqual(await store.registerReviewedPreplayPermit(f.permitInput),p);
    assert.equal((await store.getReviewedPreplayEligibility(f.owner,f.parentId,f.auth))?.eligible,true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM playback_preplay_releases')).rows[0].n,0);
  });
  it('requires a separately reviewed exact historical parent, fingerprint and source, never a generic not_started value', async () => {
    const f = await fixture({ permit:false }), before = await row(f.parentId);
    await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization()), { code:'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE' });
    await assert.rejects(store.registerReviewedPreplayPermit({ ...f.permitInput, originalFingerprint:'0'.repeat(64) }), { code:'JOB_CHANGED' });
    await assert.rejects(store.registerReviewedPreplayPermit({ ...f.permitInput, source:{...reviewedPreplaySource,commit:'0'.repeat(40)} }));
    assert.deepEqual(await row(f.parentId),before);
    for (const options of [{outcome:'interrupted',error:'PLAYBACK_REPORT_UNKNOWN'},{outcome:'not_started',error:'WORKER_INTERRUPTED'}]) {
      const bad = await fixture({ ...options,permit:false });
      await assert.rejects(store.registerReviewedPreplayPermit(bad.permitInput), { code:'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE' });
    }
    const recent = await fixture({permit:false});
    await pool.query('UPDATE playback_jobs SET created_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',[recent.parentId]);
    await assert.rejects(store.registerReviewedPreplayPermit(recent.permitInput),{code:'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE'});
  });
  it('historical fingerprints are identical across session timezones without changing the caller setting',async()=>{
    const f=await fixture({permit:false}),client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL TimeZone='Asia/Seoul'");
      const korean=(await client.query('SELECT reviewed_preplay_job_fingerprint(j) AS fingerprint FROM playback_jobs j WHERE id=$1',[f.parentId])).rows[0].fingerprint;
      assert.equal((await client.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone,'Asia/Seoul');
      await client.query("SET LOCAL TimeZone='America/Los_Angeles'");
      const pacific=(await client.query('SELECT reviewed_preplay_job_fingerprint(j) AS fingerprint FROM playback_jobs j WHERE id=$1',[f.parentId])).rows[0].fingerprint;
      assert.equal(korean,pacific);assert.equal(pacific,f.permitInput.originalFingerprint);
      assert.equal((await client.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone,'America/Los_Angeles');
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('one atomic retry preserves every old fact and creates a normal consent-bound child, outbox, metadata and relation', async () => {
    const f=await fixture(), before=await row(f.parentId);
    const result=await store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization());
    assert.deepEqual(facts(await row(f.parentId)),facts(before));
    assert.ok((await row(f.parentId)).reviewed_preplay_release_id);
    assert.equal(result.originalJob.status,'needs_verification'); assert.equal(result.originalJob.errorCode,'SCHOOL_RESULT_UNKNOWN');
    assert.equal(result.originalJob.executionOutcome,'not_started'); assert.equal(result.originalJob.acceptedGeneration,f.previousGeneration);
    assert.equal(result.job.acceptedGeneration,f.generation); assert.equal(result.job.startConsent?.id,f.consent.id); assert.equal(result.job.status,'queued');
    assert.equal((await pool.query('SELECT 1 FROM job_outbox WHERE job_id=$1 AND dispatched_at IS NULL',[result.job.id])).rowCount,1);
    assert.equal((await pool.query('SELECT duration_seconds FROM playback_queue_metadata WHERE job_id=$1',[result.job.id])).rows[0].duration_seconds,100);
    for(const table of ['playback_auth_waits','playback_execution_terminations','playback_job_settlements','playback_start_attempts','playback_job_progress'])
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE job_id=$1`,[f.parentId])).rowCount,0);
    assert.equal((await store.getReviewedPreplayEligibility(f.owner,f.parentId,f.auth))?.retriedAsJobId,result.job.id);
    assert.equal(await store.claimJob(f.parentId),null);
  });
  it('exact-key lookup and replay return the same child after completion without fresh school authority; conflicting keys cannot repeat it', async () => {
    const f=await fixture(), result=await store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization());
    await store.cancelJob(f.owner,result.job.id);
    const replay=await store.retryReviewedPreplay(f.owner,f.parentId,f.input,{...f.authorization(),admission:{} as never,schoolResult:{} as never});
    assert.equal(replay.job.id,result.job.id); assert.equal(replay.job.status,'cancelled');
    assert.equal((await store.findReviewedPreplayRetry(f.owner,f.parentId,f.input.idempotencyKey,f.auth))?.job.id,result.job.id);
    await assert.rejects(store.findReviewedPreplayRetry(f.owner,f.parentId,f.input.idempotencyKey,f.auth,op,hashToken('wrong')),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,{...f.input,idempotencyKey:randomUUID()},f.authorization()),{code:'PLAYBACK_REVIEWED_PREPLAY_ALREADY_RETRIED'});
    assert.equal(await store.findReviewedPreplayRetry(f.owner,f.parentId,randomUUID(),f.auth),null);
  });
  it('two concurrent different keys create exactly one child and one release, including a repeatable-read pool default', async () => {
    const f=await fixture(), rrPool=new Pool({connectionString:url,max:3,options:`-c search_path=${schema} -c default_transaction_isolation=repeatable\\ read`});
    try {
      const rr=new PgStore(rrPool);
      const results=await Promise.allSettled([f.input,{...f.input,idempotencyKey:randomUUID()}].map(input=>rr.retryReviewedPreplay(f.owner,f.parentId,input,f.authorization())));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.filter(r=>r.status==='rejected').length,1);
      assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId])).rowCount,1);
      assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE user_id=$1',[f.owner])).rowCount,2);
    } finally {await rrPool.end();}
  });
  it('ordinary admission remains blocked for every unreleased unknown and competes safely with reviewed admission', async () => {
    const f=await fixture(), ordinary=()=>store.createJob(f.owner,{courseId:'10',lectureId:'20',scheduledFor:new Date().toISOString(),idempotencyKey:randomUUID(),requestHash:hashToken(randomUUID()),startConsentId:f.consent.id},f.authorization());
    await assert.rejects(ordinary(),{code:'JOB_ALREADY_ACTIVE'});
    const results=await Promise.allSettled([ordinary(),store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization())]);
    assert.equal(results[0].status,'rejected'); assert.equal(results[1].status,'fulfilled');
    const result=(results[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.retryReviewedPreplay>>>).value;
    const claim=jobClaim((await store.claimJob(result.job.id))!);
    await store.transitionJob(claim,['running'],'needs_verification',null,'PLAYBACK_REPORT_UNKNOWN',{outcome:'interrupted'});
    await assert.rejects(ordinary(),{code:'JOB_ALREADY_ACTIVE'});
    const other=await fixture({permit:false});
    await assert.rejects(store.createJob(other.owner,{courseId:'10',lectureId:'20',scheduledFor:new Date().toISOString(),idempotencyKey:randomUUID(),requestHash:hashToken('other')},other.authorization()),{code:'JOB_ALREADY_ACTIVE'});
  });
  it('stale version or any reviewed parent fact change invalidates the permit without marking history', async () => {
    const f=await fixture(), before=await row(f.parentId);
    await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,{...f.input,expectedVersion:'2026-11-08T01:00:03.123455Z'},f.authorization()),{code:'JOB_CHANGED'});
    assert.deepEqual(await row(f.parentId),before);
    await pool.query("UPDATE playback_jobs SET heartbeat_at=heartbeat_at+interval '1 microsecond' WHERE id=$1",[f.parentId]);
    const changed=await row(f.parentId);
    await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization()),{code:'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE'});
    assert.deepEqual(await row(f.parentId),changed);
  });
  it('wrong owner, CSRF, client, seal, generation, completion or missing consent never releases a parent', async () => {
    for(const mode of ['owner','csrf','client','seal','generation','complete','unknown','consent'] as const){
      const f=await fixture(), before=await row(f.parentId), auth=f.authorization(), input={...f.input};
      if(mode==='csrf')auth.csrfToken='synthetic-wrong'; if(mode==='client')auth.clientId='unregistered' as never;
      if(mode==='seal'||mode==='generation')auth.admission=createPlaybackAdmission({userId:f.owner,courseId:'10',lectureId:'20'},{generation:mode==='generation'?f.previousGeneration:f.generation,encryptedSession:mode==='seal'?'synthetic-stale':f.seal});
      if(mode==='complete')auth.schoolResult.evidence!.completed=true;
      if(mode==='unknown')delete auth.schoolResult.evidence;
      if(mode==='consent')input.startConsentId=randomUUID();
      await assert.rejects(store.retryReviewedPreplay(mode==='owner'?randomUUID():f.owner,f.parentId,input,auth));
      assert.deepEqual(await row(f.parentId),before);
      assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId])).rowCount,0);
    }
  });
  it('revoked new consent, logout and active manual/old-generation leases leave the permit and history intact',async()=>{
    for(const mode of ['revoke','logout','manual','old-worker'] as const){
      const f=await fixture(), before=await row(f.parentId);
      if(mode==='revoke')await store.revokePlaybackStartConsent(f.owner,f.consent.id,f.auth,op);
      if(mode==='logout')await store.deleteSession(f.auth.almsTokenHash);
      if(mode==='manual'||mode==='old-worker')await pool.query(`INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at)
        VALUES($1,$2,'10','20',$3,$4,clock_timestamp()+interval '1 minute')`,[f.owner,mode==='manual'?f.generation:f.previousGeneration,hashToken('synthetic-lease'),mode==='manual'?'manual':'worker']);
      await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization()));
      assert.deepEqual(await row(f.parentId),before);
    }
  });
  it('DB rejects marker forgery, release deletion and every later modification of released history',async()=>{
    const f=await fixture(), before=await row(f.parentId);
    await assert.rejects(pool.query('UPDATE playback_jobs SET reviewed_preplay_release_id=$2 WHERE id=$1',[f.parentId,randomUUID()]),{code:'23503'});
    assert.deepEqual(await row(f.parentId),before);
    await store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization());
    await assert.rejects(pool.query('UPDATE playback_jobs SET reviewed_preplay_release_id=NULL WHERE id=$1',[f.parentId]));
    await assert.rejects(pool.query('UPDATE playback_jobs SET updated_at=clock_timestamp() WHERE id=$1',[f.parentId]));
    await assert.rejects(pool.query('DELETE FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId]));
    await assert.rejects(pool.query('UPDATE playback_preplay_review_permits SET evidence_sha256=$2 WHERE parent_job_id=$1',[f.parentId,hashToken('changed')]));
  });
  it('child insertion failure rolls back the parent marker, release and all new queue records',async()=>{
    const f=await fixture(), before=await row(f.parentId), name='reject_child_'+randomUUID().replaceAll('-','');
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='23514'; END $$`);
    try{
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON playback_jobs FOR EACH ROW WHEN(NEW.user_id='${f.owner}'::uuid) EXECUTE FUNCTION ${name}()`);
      try{
        await assert.rejects(store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization()),{code:'23514'});
        assert.deepEqual(await row(f.parentId),before);
        assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId])).rowCount,0);
        assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE user_id=$1',[f.owner])).rowCount,1);
      }finally{await pool.query(`DROP TRIGGER ${name} ON playback_jobs`);}
    }finally{await pool.query(`DROP FUNCTION ${name}()`);}
  });
  it('same-key readback after a lost application response does not create another release or outbox',async()=>{
    const f=await fixture();
    await store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization()); // Deliberately discard the accepted response.
    const lookup=await store.findReviewedPreplayRetry(f.owner,f.parentId,f.input.idempotencyKey,f.auth,op,f.input.requestHash);
    assert.ok(lookup);
    assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId])).rowCount,1);
    assert.equal((await pool.query('SELECT 1 FROM job_outbox WHERE job_id=$1',[lookup.job.id])).rowCount,1);
    await assert.rejects(store.findReviewedPreplayRetry(f.owner,f.parentId,f.input.idempotencyKey,{...f.auth,csrfToken:'wrong'}),{code:'AUTH_REQUIRED'});
  });
  it('wall-clock permit, consent and session expiry across an actual parent lock wait rolls back every release write',async()=>{
    for(const mode of ['permit','consent','session'] as const){
      const f=await fixture({permit:mode!=='permit'}), blocker=await pool.connect(), before=await row(f.parentId);
      let deadline:string;
      if(mode==='permit'){
        deadline=(await pool.query("SELECT (clock_timestamp()+interval '4 seconds') AS expires")).rows[0].expires.toISOString();
        await store.registerReviewedPreplayPermit({...f.permitInput,expiresAt:deadline});
      }else if(mode==='consent'){
        const id=randomUUID();
        const r=await pool.query(`WITH instant AS(SELECT clock_timestamp() AS t) INSERT INTO playback_start_consents
          (id,user_id,client_id,generation,course_id,lecture_ids,idempotency_key,request_hash,created_at,expires_at)
          SELECT $1,$2,NULL,$3,'10',ARRAY['20'],$4,$5,t,t+interval '4 seconds' FROM instant RETURNING expires_at`,[id,f.owner,f.generation,randomUUID(),hashToken('short')]);
        deadline=r.rows[0].expires_at.toISOString(); f.input.startConsentId=id;
      }else{
        deadline=(await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '4 seconds' WHERE token_hash=$1 RETURNING expires_at",[f.auth.almsTokenHash])).rows[0].expires_at.toISOString();
      }
      let pending:Promise<unknown>|undefined,blocking=false;
      try{
        await blocker.query('BEGIN');blocking=true;
        const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query('SELECT id FROM playback_jobs WHERE id=$1 FOR UPDATE',[f.parentId]);
        pending=store.retryReviewedPreplay(f.owner,f.parentId,f.input,f.authorization(),{timeoutMs:15000}).then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let n=0;n<100&&!waiting;n++){
          waiting=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;
          if(!waiting)await new Promise(r=>setTimeout(r,10));
        }
        assert.equal(waiting,true,'retry must wait for the exact parent lock');
        let expired=false;
        const expiryObservationDeadline=performance.now()+6000;
        // Four seconds of database time must actually pass, even when local queries are fast.
        while(!expired&&performance.now()<expiryObservationDeadline){
          expired=(await blocker.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[deadline])).rows[0].expired;
          if(!expired)await new Promise(r=>setTimeout(r,10));
        }
        assert.equal(expired,true);
        await blocker.query('COMMIT');blocking=false;
        const outcome=await pending as {error?:unknown}; assert.ok(outcome.error);
        assert.deepEqual(await row(f.parentId),before);
        assert.equal((await pool.query('SELECT 1 FROM playback_preplay_releases WHERE parent_job_id=$1',[f.parentId])).rowCount,0);
        if(mode==='permit'){
          assert.equal((await store.getReviewedPreplayEligibility(f.owner,f.parentId,f.auth))?.eligible,false);
          await store.registerReviewedPreplayPermit({...f.permitInput,expiresAt:new Date(Date.now()+3600000).toISOString(),evidenceSha256:hashToken('synthetic-new-review')});
          assert.equal((await pool.query('SELECT 1 FROM playback_preplay_review_permits WHERE parent_job_id=$1',[f.parentId])).rowCount,2);
          assert.equal((await store.getReviewedPreplayEligibility(f.owner,f.parentId,f.auth))?.eligible,true);
        }
      }finally{if(blocking)await blocker.query('ROLLBACK');await pending;blocker.release();}
    }
  });
});
