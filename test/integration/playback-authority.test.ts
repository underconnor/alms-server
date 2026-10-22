import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, createPlaybackFinalProof, jobClaim, type PlaybackAdmission } from '../../src/playback-authority.js';
import { dispatchOutbox } from '../../src/queue.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test','/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('job admission and execution authority in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, store: PgStore;
  const owners: string[] = [];
  before(async () => { pool = new Pool({ connectionString: url, max: 8, application_name: 'alms-qa-job-authority' }); await migrate(pool); store = new PgStore(pool); });
  after(async () => { if (pool) { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); } });
  async function fixture() {
    const generation = randomUUID(), encryptedSession = 'synthetic-school-seal-' + randomUUID();
    const identity = { provider: 'job-authority-qa', subject: randomUUID() };
    const session = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => encryptedSession });
    const userId = session.user.id; owners.push(userId);
    const input = { courseId: '10', lectureId: '20', scheduledFor: new Date().toISOString(), idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-job') };
    const authorization = { almsTokenHash: hashToken(session.token), admission: createPlaybackAdmission({ userId, courseId: input.courseId, lectureId: input.lectureId }, { generation, encryptedSession }) };
    const create = () => store.createJob(userId, input, authorization);
    return { userId, identity, session, input, authorization, generation, encryptedSession, create };
  }
  const seal = (f: {generation:string;encryptedSession:string}) => ({generation:f.generation,encryptedSession:f.encryptedSession});
  const result = { observedAt: '2026-10-03T00:00:00Z', progressPercent: 100, attendance: 'unknown' as const, recognized: null };
  async function rowCounts(owner: string) {
    const jobs = await pool.query('SELECT id FROM playback_jobs WHERE user_id=$1', [owner]);
    const outbox = await pool.query('SELECT 1 FROM job_outbox o JOIN playback_jobs j ON j.id=o.job_id WHERE j.user_id=$1', [owner]);
    return [jobs.rowCount, outbox.rowCount];
  }
  async function waitForLock(count=1, table="school_sessions") {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (Number((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-qa-job-authority' AND wait_event_type='Lock' AND query LIKE $1",['%'+table+'%'])).rowCount) >= count) return;
      await delay(10);
    }
    assert.fail('Expected school-row lock wait');
  }
  it('requires an opaque matching owner/target proof and current browser session before new admission', async () => {
    const f = await fixture(), other = await fixture();
    for (const admission of [{} as PlaybackAdmission, other.authorization.admission,
      createPlaybackAdmission({ userId: f.userId, courseId: '11', lectureId: '20' }, seal(f))]) {
      await assert.rejects(store.createJob(f.userId, f.input, { ...f.authorization, admission }));
    }
    await store.deleteSession(f.authorization.almsTokenHash);
    await assert.rejects(f.create(), (error: any) => error.code === 'AUTH_REQUIRED');
    assert.deepEqual(await rowCounts(f.userId), [0,0]);
  });
  it('a replaced school seal cannot admit a job or an outbox row', async () => {
    const f = await fixture();
    await store.issueVerifiedSession(f.identity, 3600, { provider: 'ssu', seal: () => 'synthetic-new-login' });
    await assert.rejects(f.create(), (error: any) => error.code === 'PLAYBACK_AUTHORITY_CHANGED');
    assert.deepEqual(await rowCounts(f.userId), [0,0]);
  });
  for (const replacement of ['login','jar-cas'] as const) it(`${replacement} winning a school-row lock is rechecked before admission commits`, async () => {
    const f = await fixture(), locker = await pool.connect();
    let pending: Promise<unknown> | undefined, replacing: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' FOR UPDATE", [f.userId]);
      replacing = replacement === 'login'
        ? store.issueVerifiedSession(f.identity,3600,{provider:'ssu',seal:()=> 'synthetic-replaced'})
        : store.replaceEncryptedSchoolSession(f.userId,'ssu',f.encryptedSession,'synthetic-replaced');
      await waitForLock();
      pending = f.create().then(() => null, error => error);
      await waitForLock(2);
      await locker.query('COMMIT'); await replacing;
      assert.equal((await pending as any)?.code, 'PLAYBACK_AUTHORITY_CHANGED');
      assert.deepEqual(await rowCounts(f.userId), [0,0]);
    } finally { await locker.query('ROLLBACK'); locker.release(); await replacing; await pending; }
  });
  it('logout waits behind an admission already holding its session row, then preserves that accepted job', async () => {
    const f=await fixture(),locker=await pool.connect();let pending:ReturnType<typeof f.create>|undefined,logout:Promise<void>|undefined;
    try {
      await locker.query('BEGIN');await locker.query('SELECT user_id FROM school_sessions WHERE user_id=$1 FOR UPDATE',[f.userId]);
      pending=f.create();await waitForLock();
      logout=store.deleteSession(f.authorization.almsTokenHash);await waitForLock(2,'sessions');
      await locker.query('COMMIT');const job=await pending;await logout;
      assert.equal(await store.getSession(f.authorization.almsTokenHash),null);
      assert.equal((await store.getJob(f.userId,job.id))?.acceptedGeneration,f.generation);
      assert.equal((await store.claimJob(job.id))?.status,'running');
      assert.deepEqual(await rowCounts(f.userId),[1,1]);
    } finally {await locker.query('ROLLBACK');locker.release();await pending;await logout;}
  });
  it('cancels an admission blocked on a row lock without a late job/outbox insert', async () => {
    const f = await fixture(), locker = await pool.connect(), abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query("SELECT user_id FROM school_sessions WHERE user_id=$1 FOR UPDATE", [f.userId]);
      pending = store.createJob(f.userId, f.input, f.authorization, { signal: abort.signal, timeoutMs: 5000 }).then(() => null, error => error);
      await waitForLock(); abort.abort(new Error('synthetic-abort')); assert.ok(await pending);
      await locker.query('ROLLBACK'); await delay(30);
      assert.deepEqual(await rowCounts(f.userId), [0,0]);
    } finally { abort.abort(); await locker.query('ROLLBACK'); locker.release(); await pending; }
  });
  it('same-key replay returns its original generation without reauthorizing or changing the outbox', async () => {
    const f = await fixture();
    const [one,two] = await Promise.all([f.create(), f.create()]); assert.equal(one.id,two.id);
    await store.issueVerifiedSession(f.identity, 3600, { provider: 'ssu', seal: () => 'synthetic-later-login' });
    const replay = await store.createJob(f.userId, f.input, { ...f.authorization, admission: {} as PlaybackAdmission });
    assert.equal(replay.id,one.id); assert.equal(replay.acceptedGeneration,f.generation);
    assert.deepEqual(await rowCounts(f.userId), [1,1]);
    await assert.rejects(store.findJobRequest(f.userId,f.input.idempotencyKey,'different-hash'), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  });
  it('one concurrent claim wins; all owner/target/generation/token mismatches lose every worker SQL operation', async () => {
    const f = await fixture(), job = await f.create(), other = await fixture();
    const claims = await Promise.all([store.claimJob(job.id), new PgStore(pool).claimJob(job.id)]);
    assert.equal(claims.filter(Boolean).length,1);
    const claim = jobClaim(claims.find(Boolean)!);
    for (const bad of [{...claim,jobId:randomUUID()},{...claim,userId:other.userId},{...claim,courseId:'11'},
      {...claim,lectureId:'21'},{...claim,acceptedGeneration:randomUUID()},{...claim,executionTokenHash:randomBytes(32).toString('hex')}]) {
      assert.equal(await store.getWorkerJob(bad),null); assert.equal(await store.heartbeat(bad),false);
      assert.equal(await store.transitionJob(bad,['running'],'reconciling'),null);
    }
    assert.equal(await store.heartbeat(claim),true);
    assert.equal((await store.getWorkerJob(claim))?.status,'running');
  });
  it('final school result requires the same claim and current school seal; ended/null becomes completed only once', async () => {
    const f = await fixture(), job = await f.create(), claim = jobClaim((await store.claimJob(job.id))!);
    await store.transitionJob(claim,['running'],'reconciling');
    await assert.rejects(store.transitionJob(claim,['reconciling'],'completed',result,null,{outcome:'ended'}));
    const wrong = createPlaybackFinalProof({...claim,executionTokenHash:'f'.repeat(64)},seal(f));
    await assert.rejects(store.transitionJob(claim,['reconciling'],'completed',result,null,{outcome:'ended',authority:wrong}));
    const authority = createPlaybackFinalProof(claim,seal(f));
    const completed = await store.transitionJob(claim,['reconciling'],'completed',result,null,{outcome:'ended',authority});
    assert.equal(completed?.status,'completed'); assert.equal(completed?.executionOutcome,'ended'); assert.equal(completed?.schoolResult?.recognized,null);
    assert.equal(completed?.executionTokenHash,null);
    assert.equal(await store.transitionJob(claim,['reconciling'],'completed',result,null,{outcome:'ended',authority}),null);
    assert.equal(await store.heartbeat(claim),false);
  });
  it('a new login before final CAS cannot make an old prepared result look current', async () => {
    const f = await fixture(), job = await f.create(), claim = jobClaim((await store.claimJob(job.id))!);
    await store.transitionJob(claim,['running'],'reconciling'); const authority = createPlaybackFinalProof(claim,seal(f));
    await store.issueVerifiedSession(f.identity,3600,{provider:'ssu',seal:()=> 'synthetic-fresh-login'});
    assert.equal(await store.transitionJob(claim,['reconciling'],'completed',result,null,{outcome:'ended',authority}),null);
    assert.equal((await store.getJob(f.userId,job.id))?.schoolResult,null);
    assert.equal((await store.getJob(f.userId,job.id))?.status,'reconciling');
  });
  it('ALMS logout preserves admitted authority, whereas stale recovery invalidates the execution token', async () => {
    const f = await fixture(), job = await f.create(); await store.deleteSession(f.authorization.almsTokenHash);
    const claim = jobClaim((await store.claimJob(job.id))!); assert.equal(await store.heartbeat(claim),true);
    await pool.query("UPDATE playback_jobs SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[job.id]);
    assert.ok(await store.recoverStaleJobs());
    assert.equal(await store.heartbeat(claim),false); assert.equal(await store.getWorkerJob(claim),null);
    assert.equal(await store.transitionJob(claim,['running'],'reconciling'),null);
    assert.equal(await store.claimJob(job.id),null);
    assert.equal((await store.getJob(f.userId,job.id))?.status,'needs_verification');
  });
  it('legacy jobs are quarantined before dispatch without attaching a new generation or changing historical results', async () => {
    const f = await fixture(), ids: string[] = [];
    for (const status of ['queued','scheduled','running','cancel_requested','succeeded']) {
      const id=randomUUID(); ids.push(id);
      await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,school_result)
        VALUES($1,$2,'10',$3,$4,clock_timestamp(),$5,'legacy',$6::jsonb)`,[id,f.userId,id,status,randomUUID(),status==='succeeded'?JSON.stringify(result):null]);
      await pool.query('INSERT INTO job_outbox(job_id) VALUES($1)',[id]);
      assert.equal(await store.claimJob(id),null);
    }
    assert.equal(await store.quarantineLegacyJobs(),4);
    // Other tests have current queued jobs; only this fixture's legacy IDs must never be dispatched.
    const sent: string[] = [];
    await dispatchOutbox(store,{send:async (_queue:unknown,payload:{jobId:string})=>{sent.push(payload.jobId);return payload.jobId;}} as unknown as PgBoss);
    assert.equal(sent.some(id=>ids.includes(id)),false);
    const rows=await pool.query('SELECT status,accepted_generation,execution_token_hash,execution_outcome,school_result FROM playback_jobs WHERE user_id=$1 ORDER BY created_at',[f.userId]);
    assert.equal(rows.rows.filter(row=>row.status==='needs_reauthentication').length,2);
    assert.equal(rows.rows.filter(row=>row.status==='needs_verification').length,2);
    for(const row of rows.rows){assert.equal(row.accepted_generation,null);assert.equal(row.execution_token_hash,null);assert.equal(row.execution_outcome,null);}
    assert.deepEqual(rows.rows.find(row=>row.status==='succeeded').school_result,result);
  });
});
